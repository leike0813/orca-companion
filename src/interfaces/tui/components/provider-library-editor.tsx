/**
 * 共享 Provider library 编辑器（IP-09）。
 *
 * 普通启动与 `--debug` 空库配置用的是同一份 `ProviderLibrary` / `ProviderCatalog`、同一组
 * `ModelSettingsEdit` 字段与同一个 `ModelSettingsEditor` 视图；差别只在结尾：这里不写项目配置，
 * 选中模型后把 `modelRef` 与 `effort` 交给宿主——普通启动用它写项目配置，调试用它打开会话。
 *
 * 秘密边界不变：API Key 只存在内存里的 `edit.secret`，保存成功、Esc 退出与卸载时抹除，组件既不
 * 落盘也不读取已保存的凭据内容。组件自己持有状态与按键处理，宿主不要为它再分发一次按键。
 */

import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

import { ModelSettingsEditor } from './model-settings-editor.js';
import { DialogFrame } from './selection-list.js';
import { editComposer, textDraft } from '../input/composer-editor.js';
import { truncateToDisplayWidth } from '../render/width.js';
import { EMPTY_MODEL_SETTINGS_EDIT, type ModelSettingsEdit } from '../state.js';
import { tuiColors } from '../theme.js';
import type { ProviderCatalog } from '../../../application/configuration/provider-catalog.js';
import type { ProviderLibrary } from '../../../application/configuration/provider-library.js';
import { PROVIDER_PROTOCOLS, type ModelDefinition, type ProviderProtocol } from '../../../domain/model-configuration.js';

export type ProviderLibraryEditorProps = {
  readonly library: ProviderLibrary;
  readonly catalog: ProviderCatalog;
  /** 选中模型后的明确交接；`effort` 只取该模型的可信能力取值，或 `null`。 */
  /** Persist/validate the selected model; a returned message keeps the editor open. */
  readonly onSelect: (modelRef: string, effort: string | null) => void | string | Promise<void | string | null>;
  /** Called after persistence succeeds and only if the selection has not gone stale. */
  readonly onSelected?: (modelRef: string, effort: string | null) => void;
  /** Esc 退出：先抹除内存中的 key，再交给宿主。 */
  readonly onCancel: () => void;
  readonly width: number;
  readonly rows?: number;
  readonly identity?: string;
};

/** 已保存模型、等待用户明确选择 effort 的一步；`null` 表示没有可信 effort 取值。 */
type EffortStep = { readonly model: ModelDefinition; readonly values: readonly string[] };

type EditorState = {
  readonly edit: ModelSettingsEdit;
  readonly notice: string | null;
  readonly effort: EffortStep | null;
  /** 0 是「不指定」，之后是可信取值。 */
  readonly effortIndex: number;
};

// 同一 PTY 批次里的后续按键必须读到前一键的结果，不能等 React 提交下一帧。
function useImmediateState<T>(initial: () => T) {
  const [value, setValue] = useState<T>(initial);
  const current = useRef(value);
  const update = useCallback((next: SetStateAction<T>) => {
    current.current = typeof next === 'function' ? (next as (previous: T) => T)(current.current) : next;
    setValue(current.current);
  }, []);
  return [value, update, current] as const;
}

/** 只有可信能力来源才给 effort 选择步；没有可信取值时直接以 `null` 交接。 */
function effortStep(model: ModelDefinition): EffortStep | null {
  const values = model.effortCapability?.values ?? [];
  return values.length === 0 ? null : { model, values };
}

function initialState(library: ProviderLibrary, catalog: ProviderCatalog): EditorState {
  // 共享编辑器不写项目配置，因此按「项目始终可用」隐藏模型列表里的初始化项。
  const base: ModelSettingsEdit = { ...EMPTY_MODEL_SETTINGS_EDIT, presets: catalog.presets(), projectAvailable: true };
  const loaded = library.load();
  if (loaded.kind !== 'loaded') return { edit: base, notice: '! ' + loaded.code + ': ' + loaded.message, effort: null, effortIndex: 0 };
  const connection = loaded.connections[0] ?? null;
  return {
    edit: {
      ...base,
      connectionRef: connection?.connectionRef ?? null,
      credentialRef: connection?.credential.credentialRef ?? null,
      providerId: connection?.providerId ?? '',
      providerIntegration: connection?.providerIntegration ?? 'openai-chat',
      selectedIndex: connection === null ? -1 : 0,
      connections: loaded.connections,
      models: loaded.models,
      catalogResult: connection === null ? null : catalog.candidates(connection),
      libraryRevision: loaded.revision,
    },
    notice: null,
    effort: null,
    effortIndex: 0,
  };
}

function editProviderField(edit: ModelSettingsEdit, input: string, key: Parameters<typeof editComposer>[2]): ModelSettingsEdit {
  const field = edit.stage === 'connections' || edit.stage === 'preset' || edit.stage === 'models' ? 'query' : edit.field;
  const value = field === 'secret' ? edit.secret
    : field === 'label' ? edit.label
      : field === 'baseUrl' ? edit.baseUrl
        : edit.query;
  const next = editComposer(textDraft(value), input, key).text.replace(/[\r\n]/gu, '');
  if (next === value) return edit;
  if (field === 'secret') return { ...edit, secret: next };
  if (field === 'label') return { ...edit, label: next };
  if (field === 'baseUrl') return { ...edit, baseUrl: next };
  return { ...edit, query: next, selectedIndex: -1, selectedModelId: null };
}

export function ProviderLibraryEditor(props: ProviderLibraryEditorProps) {
  const { library, catalog, width, rows = 16 } = props;
  const [state, update, stateRef] = useImmediateState<EditorState>(() => initialState(library, catalog));
  const inFlight = useRef(false);
  const discovery = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const editGeneration = useRef(0);
  const select = useCallback((modelRef: string, effort: string | null) => {
    if (inFlight.current) return;
    const token = editGeneration.current;
    inFlight.current = true;
    void Promise.resolve().then(() => props.onSelect(modelRef, effort)).then((message) => {
      inFlight.current = false;
      if (message !== undefined && message !== null) {
        update((state) => ({ ...state, notice: '! save_failed: ' + message }));
      } else if (token === editGeneration.current) props.onSelected?.(modelRef, effort);
    }, (error: unknown) => {
      inFlight.current = false;
      update((state) => ({ ...state, notice: '! save_failed: ' + (error instanceof Error ? error.message : '保存失败') }));
    });
  }, [props.onSelect, props.onSelected, update]);

  /** 只接受本次调用的发现结果：换连接、Esc 或卸载后到期的响应直接丢弃。 */
  const discover = useCallback((edit: ModelSettingsEdit) => {
    const connection = edit.connections.find((entry) => entry.connectionRef === edit.connectionRef);
    if (connection === undefined) return;
    discovery.current?.abort();
    const controller = new AbortController();
    discovery.current = controller;
    const token = (generation.current += 1);
    void catalog.discover(connection, { signal: controller.signal }).then((result) => {
      if (token !== generation.current) return;
      update((current) => current.edit.connectionRef === connection.connectionRef
        ? { ...current, edit: { ...current.edit, catalogResult: result } }
        : current);
    }, () => {
      if (token === generation.current) update((current) => ({ ...current, notice: '! catalog_unavailable: 保留当前模型候选，可手动输入 exact ID' }));
    });
  }, [catalog, update]);

  // 打开时若公共目录已过期就发现一次；之后的发现只由按键路径显式发起。
  useEffect(() => {
    const opened = stateRef.current.edit;
    if (opened.catalogResult?.expired === true && opened.connectionRef !== null) discover(opened);
    return () => {
      generation.current += 1;
      editGeneration.current += 1;
      discovery.current?.abort();
      stateRef.current = { ...stateRef.current, edit: { ...stateRef.current.edit, secret: '' } };
    };
  }, [discover, stateRef]);

  /** 保存连接或模型；失败保留全部输入，只更新结构化提示。 */
  const save = useCallback((edit: ModelSettingsEdit) => {
    if (inFlight.current) return;
    inFlight.current = true;
    update((current) => ({ ...current, notice: null }));
    const editToken = editGeneration.current;
    const finish = (next: EditorState) => {
      inFlight.current = false;
      update((current) => {
        if (editToken === editGeneration.current) return next;
        if (edit.stage === 'connection' && next.edit.stage === 'models') {
          return { ...current, edit: { ...current.edit, libraryRevision: next.edit.libraryRevision,
            connections: next.edit.connections, models: next.edit.models }, notice: next.notice };
        }
        return { ...current, notice: next.notice };
      });
    };
    if (edit.stage === 'connection') {
      if (edit.label.trim() === '' || edit.baseUrl.trim() === '' || (edit.secret === '' && edit.credentialRef === null)) {
        finish({ edit, notice: '! save_failed: 连接名称、地址与 API Key 不能为空', effort: null, effortIndex: 0 });
        return;
      }
      void library.saveConnection({
        expectedRevision: edit.libraryRevision,
        label: edit.label,
        providerId: edit.providerId,
        providerIntegration: edit.providerIntegration,
        baseUrl: edit.baseUrl,
        ...(edit.secret === '' ? { credentialRef: edit.credentialRef! } : { newSecret: edit.secret }),
      }).then((saved) => {
        if (saved.kind !== 'saved') {
          finish({ edit, notice: '! save_failed: ' + saved.code + ': ' + saved.message, effort: null, effortIndex: 0 });
          return;
        }
        const loaded = library.load();
        if (loaded.kind !== 'loaded') {
          finish({ edit, notice: '! save_failed: ' + loaded.code + ': ' + loaded.message, effort: null, effortIndex: 0 });
          return;
        }
        finish({
          edit: {
            ...edit,
            stage: 'models',
            connectionRef: saved.connection.connectionRef,
            credentialRef: saved.connection.credential.credentialRef,
            providerId: saved.connection.providerId,
            providerIntegration: saved.connection.providerIntegration,
            label: saved.connection.label,
            baseUrl: saved.connection.baseUrl,
            connections: loaded.connections,
            models: loaded.models,
            libraryRevision: loaded.revision,
            model: '',
            modelRef: null,
            selectedModelId: null,
            selectedIndex: -1,
            query: '',
            secret: '',
            catalogResult: catalog.candidates(saved.connection),
          },
          notice: '连接已保存，首次模型发现已尝试',
          effort: null,
          effortIndex: 0,
        });
      }, (error: unknown) => {
        finish({ edit, notice: '! save_failed: ' + (error instanceof Error ? error.message : '保存失败'), effort: null, effortIndex: 0 });
      });
      return;
    }
    if (edit.stage === 'models') {
      if (edit.connectionRef === null || edit.model.trim() === '') {
        finish({ edit, notice: '! save_failed: 请选择模型或输入 exact ID', effort: null, effortIndex: 0 });
        return;
      }
      const existing = edit.models.find((item) => item.connectionRef === edit.connectionRef && item.model === edit.model);
      if (existing !== undefined) {
        const effort = effortStep(existing);
        finish({ edit: { ...edit, modelRef: existing.modelRef }, notice: null, effort, effortIndex: 0 });
        if (effort === null) select(existing.modelRef, null);
        return;
      }
      const saved = library.saveModel({ expectedRevision: edit.libraryRevision, connectionRef: edit.connectionRef, model: edit.model });
      if (saved.kind !== 'saved') {
        finish({ edit, notice: '! save_failed: ' + saved.code + ': ' + saved.message, effort: null, effortIndex: 0 });
        return;
      }
      finish({
        edit: { ...edit, modelRef: saved.model.modelRef, models: [...edit.models, saved.model], libraryRevision: saved.revision },
        notice: null,
        effort: effortStep(saved.model),
        effortIndex: 0,
      });
      if (effortStep(saved.model) === null) select(saved.model.modelRef, null);
      return;
    }
    finish({ edit, notice: '! save_failed: 先选择连接和模型', effort: null, effortIndex: 0 });
  }, [library, catalog, select, update]);

  const cancel = useCallback(() => {
    generation.current += 1;
    discovery.current?.abort();
    update((current) => ({ ...current, edit: { ...current.edit, secret: '' }, effort: null }));
    props.onCancel();
  }, [props, update]);

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    editGeneration.current += 1;
    const current = stateRef.current;
    const edit = current.edit;
    if (key.escape) { cancel(); return; }
    if (current.effort !== null) {
      if (key.upArrow) { update((state) => ({ ...state, effortIndex: Math.max(0, state.effortIndex - 1) })); return; }
      if (key.downArrow) { update((state) => ({ ...state, effortIndex: Math.min(state.effort?.values.length ?? 0, state.effortIndex + 1) })); return; }
      if (key.return && !key.meta && !key.shift && !inFlight.current) {
        select(current.effort.model.modelRef,
          current.effortIndex === 0 ? null : current.effort.values[current.effortIndex - 1] ?? null);
      }
      return;
    }
    if (edit.stage === 'models' && key.ctrl && input.toLowerCase() === 'r') {
      const connection = edit.connections.find((item) => item.connectionRef === edit.connectionRef);
      if (connection === undefined) return;
      const token = (generation.current += 1);
      void catalog.refresh().then(() => {
        if (token !== generation.current) return;
      update((state) => ({ ...state, edit: { ...state.edit, catalogResult: catalog.candidates(connection) } }));
      }, () => {
        if (token === generation.current) update((state) => ({ ...state, notice: '! catalog_unavailable: 公共模型目录刷新失败，现有候选仍可用' }));
      });
      return;
    }
    if (edit.stage === 'connections' || edit.stage === 'preset' || edit.stage === 'models') {
      const query = edit.query.toLowerCase();
      const connections = edit.connections.filter((item) => (item.label + item.providerId + item.providerIntegration).toLowerCase().includes(query));
      const presets = edit.presets.filter((item) => (item.label + item.id + item.protocol).toLowerCase().includes(query));
      const models = (edit.catalogResult?.models ?? []).filter((item) => (item.label + item.id).toLowerCase().includes(query));
      const count = edit.stage === 'connections' ? connections.length + 2 : edit.stage === 'preset' ? presets.length + 1 : models.length + 2;
      if (key.upArrow || key.downArrow) {
        update((state) => ({ ...state, edit: { ...state.edit, selectedIndex: Math.max(0, Math.min(count - 1, state.edit.selectedIndex + (key.upArrow ? -1 : 1))) } }));
        return;
      }
      if ((!key.return && !key.meta && !key.ctrl && input !== '') || key.backspace || key.delete) {
      update((state) => ({ ...state, edit: editProviderField(state.edit, input, key) }));
        return;
      }
      if (!key.return || key.meta || key.shift) return;
      if (edit.stage === 'connections') {
        const connection = connections[edit.selectedIndex];
        if (connection !== undefined) {
          const catalogResult = catalog.candidates(connection);
          const next = { ...edit, stage: 'models' as const, connectionRef: connection.connectionRef, credentialRef: connection.credential.credentialRef,
            providerId: connection.providerId, providerIntegration: connection.providerIntegration, label: connection.label, baseUrl: connection.baseUrl,
            secret: '', query: '', selectedIndex: -1, selectedModelId: null, catalogResult };
          update((state) => ({ ...state, edit: next, notice: null }));
          if (catalogResult.expired) discover(next);
          return;
        }
        if (edit.selectedIndex === connections.length) {
          const target = edit.connections.find((item) => item.connectionRef === edit.connectionRef);
          if (target === undefined) { update((state) => ({ ...state, notice: '请先选择要编辑的连接' })); return; }
          update((state) => ({ ...state, edit: { ...state.edit, stage: 'connection', providerId: target.providerId, providerIntegration: target.providerIntegration, label: target.label, baseUrl: target.baseUrl, connectionRef: target.connectionRef, credentialRef: target.credential.credentialRef, secret: '', query: '', field: 'label' } }));
          return;
        }
        update((state) => ({ ...state, edit: { ...state.edit, stage: 'preset', query: '', selectedIndex: -1 } }));
        return;
      }
      if (edit.stage === 'preset') {
        const preset = presets[edit.selectedIndex];
        if (preset === undefined && edit.selectedIndex !== presets.length) { update((state) => ({ ...state, notice: '请选择 Provider 或自定义协议' })); return; }
        update((state) => ({ ...state, edit: { ...state.edit, stage: 'connection', providerId: preset?.id ?? 'custom', providerIntegration: preset?.protocol ?? edit.providerIntegration, label: preset?.label ?? '', baseUrl: preset?.baseUrl ?? '', connectionRef: null, credentialRef: null, secret: '', field: 'label', query: '' } }));
        return;
      }
      const model = models[edit.selectedIndex];
      if (model !== undefined) { save({ ...edit, model: model.id, selectedModelId: model.id }); return; }
      if (edit.selectedIndex === models.length) {
        if (edit.query.trim() === '') { update((state) => ({ ...state, notice: '请输入模型编号，或选择目录候选' })); return; }
        save({ ...edit, model: edit.query.trim(), selectedModelId: null });
        return;
      }
      discover(edit);
      return;
    }
    if (edit.stage !== 'connection') return;
    if (key.upArrow || key.downArrow) {
      const fields = ['label', 'baseUrl', 'secret'] as const;
      const index = fields.indexOf(edit.field === 'secret' || edit.field === 'baseUrl' ? edit.field : 'label');
      update((state) => ({ ...state, edit: { ...state.edit, field: fields[(index + (key.upArrow ? 2 : 1)) % fields.length]! } }));
      return;
    }
    if ((key.leftArrow || key.rightArrow) && edit.providerId === 'custom') {
      const protocols = PROVIDER_PROTOCOLS.filter((item) => item !== 'google-gemini') as readonly Exclude<ProviderProtocol, 'google-gemini'>[];
      const index = protocols.indexOf(edit.providerIntegration as Exclude<ProviderProtocol, 'google-gemini'>);
      update((state) => ({ ...state, edit: { ...state.edit, providerIntegration: protocols[(index + (key.leftArrow ? protocols.length - 1 : 1)) % protocols.length]! } }));
      return;
    }
    if (key.return && !key.meta && !key.shift) { save(edit); return; }
    if (input !== '' || key.backspace || key.delete) {
      const next = editProviderField(edit, input, key);
      if (next !== edit) update((state) => ({ ...state, edit: next }));
    }
  });

  if (state.effort !== null) {
    const bodyWidth = Math.max(1, width - 8);
    return <DialogFrame title="Coordinator · effort" summary={state.effort.model.model} width={width} rows={Math.max(6, rows)}
      footer="↑↓ 选择 · Enter 确认 · Esc 返回">
      <Box flexDirection="column">
        {['不指定 effort', ...state.effort.values].map((label, index) => <Text key={label}
          inverse={index === state.effortIndex} {...(index === state.effortIndex ? { color: tuiColors.focus } : {})}>
          {truncateToDisplayWidth((index === state.effortIndex ? '› ' : '  ') + label, bodyWidth)}
        </Text>)}
        {state.notice === null ? null : <Text dimColor>{truncateToDisplayWidth(state.notice, bodyWidth)}</Text>}
      </Box>
    </DialogFrame>;
  }
  return <ModelSettingsEditor edit={state.edit} notice={state.notice} failing={false} availableWidth={width} rows={rows}
    identity={props.identity ?? '保存配置不会自动应用'} />;
}
