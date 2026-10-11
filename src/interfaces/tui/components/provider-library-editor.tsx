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

import { Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

import { ModelSettingsEditor } from './model-settings-editor.js';
import { ActionRow, DialogFrame, fieldRows } from './selection-list.js';
import { effortWindow } from './model-picker.js';
import { editComposer, textDraft } from '../input/composer-editor.js';
import { truncateToDisplayWidth } from '../render/width.js';
import { EMPTY_MODEL_SETTINGS_EDIT, type ModelSettingsEdit } from '../state.js';
import { tuiColors } from '../theme.js';
import type { ProviderCatalog } from '../../../application/configuration/provider-catalog.js';
import type { ProviderLibrary } from '../../../application/configuration/provider-library.js';
import {
  MODEL_INPUT_MODALITIES,
  PROVIDER_PROTOCOLS,
  protocolEffortCapability,
  semanticEqual,
  type ModelInputModality,
  type ModelMetadata,
  type ProviderProtocol,
} from '../../../domain/model-configuration.js';

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

/**
 * 选定模型后的确认步。
 *
 * 目录候选沿定稿只确认独立的横向 effort，元数据由目录精确值随记录保存；手填 exact ID 没有目录事实，
 * 因此同一步还要确认上下文窗口与输入模态，并且确认后才保存——手填不依赖目录查询。
 * 窗口与模态都可以留空：留空即未知，不写默认值，保存的模型因此没有元数据声明。
 */
type DeclareStep = {
  readonly model: string;
  /** true 表示手填：需要元数据声明并在此保存；目录候选已在选定模型时保存。 */
  readonly manual: boolean;
  /** 目录候选保存后的 modelRef；手填在确认时才有。 */
  readonly modelRef: string | null;
  /** 目录给出的精确元数据起点；用户改动后来源即改为 user_declared。 */
  readonly catalogMetadata: ModelMetadata | null;
  readonly effortValues: readonly string[];
  /** 0 表示不指定 effort，之后是可信取值。 */
  readonly effortIndex: number;
  readonly contextWindow: string;
  readonly modalities: readonly ModelInputModality[];
  readonly modalityIndex: number;
  readonly focus: 'window' | 'modalities' | 'effort' | 'action';
  /** ActionRow：0 返回模型列表，1 确认并交接。 */
  readonly action: number;
  /** 聚焦区域；目录候选只有 effort 与动作两区。 */
  readonly regions: readonly DeclareStep['focus'][];
};

type EditorState = {
  readonly edit: ModelSettingsEdit;
  readonly notice: string | null;
  readonly declare: DeclareStep | null;
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

function initialState(library: ProviderLibrary, catalog: ProviderCatalog): EditorState {
  // 共享编辑器不写项目配置，因此按「项目始终可用」隐藏模型列表里的初始化项。
  const base: ModelSettingsEdit = { ...EMPTY_MODEL_SETTINGS_EDIT, presets: catalog.presets(), projectAvailable: true };
  const loaded = library.load();
  if (loaded.kind !== 'loaded') return { edit: base, notice: '! ' + loaded.code + ': ' + loaded.message, declare: null };
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
    declare: null,
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

/** 目录候选的精确元数据（窗口与模态齐备才算）；目录没声明就是未知，不猜默认值。 */
function catalogMetadataOf(
  candidate: ReturnType<ProviderCatalog['candidates']>['models'][number] | undefined,
): ModelMetadata | null {
  if (candidate === undefined) return null;
  const modalities = candidate.inputModalities;
  if (candidate.contextWindow === null || modalities == null || modalities.length === 0) return null;
  return { contextWindow: candidate.contextWindow, inputModalities: [...modalities], source: 'catalog' };
}

/** 本次声明要保存的元数据；两者都为空即未知，不写入记录。 */
function declaredMetadata(step: DeclareStep): ModelMetadata | null {
  if (step.contextWindow === '' && step.modalities.length === 0) return null;
  if (step.contextWindow === '' || step.modalities.length === 0) {
    // 只有一半的声明没有意义：窗口限制与输入模态要么都声明，要么都未知。
    throw new Error('窗口与输入模态必须同时声明');
  }
  const contextWindow = Number(step.contextWindow);
  if (!/^[0-9]+$/u.test(step.contextWindow) || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('上下文窗口必须是正安全整数');
  }
  // text 恒在：声明了输入能力就必须包含文字输入，否则模型无法承担任何协调会话。
  const inputModalities = step.modalities.includes('text') ? [...step.modalities] : ['text' as const, ...step.modalities];
  const metadata = { contextWindow, inputModalities };
  // 与目录精确元数据逐字段相同才算目录来源；改过任何一项就是用户声明。
  const source = step.catalogMetadata !== null &&
    semanticEqual({ ...metadata, source: 'catalog' }, step.catalogMetadata) ? 'catalog' : 'user_declared';
  return { ...metadata, source };
}

function openDeclare(edit: ModelSettingsEdit, model: string, manual: boolean, modelRef: string | null): DeclareStep {
  const connection = edit.connections.find((entry) => entry.connectionRef === edit.connectionRef);
  const candidate = manual ? undefined : edit.catalogResult?.models.find((entry) => entry.id === model);
  const catalogMetadata = catalogMetadataOf(candidate);
  const saved = edit.models.find((entry) => entry.modelRef === modelRef) ??
    edit.models.findLast((entry) => entry.connectionRef === edit.connectionRef && entry.model === model);
  const metadata = saved?.metadata ?? catalogMetadata;
  // effort 取值只来自**这条记录本身**：既有记录按它已保存的能力来源，新保存的记录按目录能力来源，
  // 两者都没有时才是手填的固定协议预设（那正是 saveModel 会写进去的能力）。界面因此不会提供任何
  // 保存后会缺少能力来源的 effort。
  const efforts = saved !== undefined ? saved.effortCapability?.values ?? []
    : candidate?.effortCapability?.values ??
      (connection === undefined ? [] : protocolEffortCapability(connection.providerIntegration)?.values ?? []);
  return {
    model,
    manual,
    modelRef,
    catalogMetadata,
    effortValues: efforts,
    effortIndex: 0,
    contextWindow: metadata === null ? '' : String(metadata.contextWindow),
    modalities: metadata === null ? [] : [...metadata.inputModalities],
    modalityIndex: 0,
    focus: manual ? 'window' : 'effort',
    // 定稿：进入动作区时默认动作永远是「返回」，确认必须显式选择。
    action: 0,
    regions: manual ? ['window', 'modalities', 'effort', 'action'] : ['effort', 'action'],
  };
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

  /** 保存连接；失败保留全部输入，只更新结构化提示。模型由声明步保存。 */
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
        finish({ edit, notice: '! save_failed: 连接名称、地址与 API Key 不能为空', declare: null });
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
          finish({ edit, notice: '! save_failed: ' + saved.code + ': ' + saved.message, declare: null });
          return;
        }
        const loaded = library.load();
        if (loaded.kind !== 'loaded') {
          finish({ edit, notice: '! save_failed: ' + loaded.code + ': ' + loaded.message, declare: null });
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
          declare: null,
        });
      }, (error: unknown) => {
        finish({ edit, notice: '! save_failed: ' + (error instanceof Error ? error.message : '保存失败'), declare: null });
      });
      return;
    }
    if (edit.connectionRef === null || edit.model.trim() === '') {
      finish({ edit, notice: '! save_failed: 请选择模型或输入 exact ID', declare: null });
      return;
    }
    // 目录候选：沿定稿先保存记录，再确认独立横向 effort。目录的精确元数据随记录保存，无需额外一步。
    const existing = edit.models.findLast((item) => item.connectionRef === edit.connectionRef && item.model === edit.model);
    if (existing !== undefined) {
      const next = { ...edit, model: existing.model, modelRef: existing.modelRef };
      finish({ edit: next, notice: null, declare: openDeclare(next, existing.model, false, existing.modelRef) });
      return;
    }
    const saved = library.saveModel({ expectedRevision: edit.libraryRevision, connectionRef: edit.connectionRef, model: edit.model });
    if (saved.kind !== 'saved') {
      finish({ edit, notice: '! save_failed: ' + saved.code + ': ' + saved.message, declare: null });
      return;
    }
    const next = { ...edit, model: saved.model.model, modelRef: saved.model.modelRef, models: [...edit.models, saved.model], libraryRevision: saved.revision };
    finish({ edit: next, notice: null, declare: openDeclare(next, saved.model.model, false, saved.model.modelRef) });
  }, [library, catalog, update]);

  /** 确认步：目录候选直接交接已保存的引用，手填先校验声明再追加记录并交接。 */
  const confirmDeclare = useCallback((step: DeclareStep) => {
    if (inFlight.current) return;
    const edit = stateRef.current.edit;
    if (edit.connectionRef === null) {
      update((state) => ({ ...state, notice: '! save_failed: 请先选择连接' }));
      return;
    }
    const effort = step.effortIndex === 0 ? null : step.effortValues[step.effortIndex - 1] ?? null;
    if (!step.manual) {
      if (step.modelRef === null) { update((state) => ({ ...state, notice: '! save_failed: 模型记录不存在' })); return; }
      update((state) => ({ ...state, declare: null, notice: null }));
      select(step.modelRef, effort);
      return;
    }
    let metadata: ModelMetadata | null;
    try {
      metadata = declaredMetadata(step);
    } catch (error) {
      update((state) => ({ ...state, declare: { ...step, focus: 'window', action: 0 }, notice: '! save_failed: ' + (error instanceof Error ? error.message : '元数据无效') }));
      return;
    }
    const existing = edit.models.findLast((item) => item.connectionRef === edit.connectionRef && item.model === step.model);
    // 声明与既有记录逐字段相同就复用原记录：编辑只追加，也不为同一模型反复制造新引用。
    if (existing !== undefined && semanticEqual(existing.metadata ?? null, metadata)) {
      update((state) => ({ ...state, declare: null, notice: null }));
      select(existing.modelRef, effort);
      return;
    }
    inFlight.current = true;
    const saved = library.saveModel({
      expectedRevision: edit.libraryRevision,
      connectionRef: edit.connectionRef,
      model: step.model,
      ...(metadata === null ? {} : { metadata }),
    });
    if (saved.kind !== 'saved') {
      inFlight.current = false;
      update((state) => ({ ...state, declare: step, notice: '! save_failed: ' + saved.code + ': ' + saved.message }));
      return;
    }
    inFlight.current = false;
    update((state) => ({
      ...state,
      edit: { ...state.edit, model: '', modelRef: saved.model.modelRef, models: [...state.edit.models, saved.model], libraryRevision: saved.revision },
      notice: null,
      declare: null,
    }));
    select(saved.model.modelRef, effort);
  }, [library, select, stateRef, update]);

  const cancel = useCallback(() => {
    generation.current += 1;
    discovery.current?.abort();
    update((current) => ({ ...current, edit: { ...current.edit, secret: '' }, declare: null }));
    props.onCancel();
  }, [props, update]);

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    editGeneration.current += 1;
    const current = stateRef.current;
    const edit = current.edit;
    if (current.declare !== null) {
      const step = current.declare;
      const back = (): void => { update((state) => ({ ...state, declare: null, notice: null })); };
      if (key.tab) {
        const regions = step.regions;
        const next = regions[(regions.indexOf(step.focus) + (key.shift ? regions.length - 1 : 1)) % regions.length]!;
        update((state) => ({ ...state, declare: { ...step, focus: next, action: next === 'action' ? 0 : step.action } }));
        return;
      }
      if (key.escape) { back(); return; }
      if (step.focus === 'window' && !key.return && (input !== '' || key.backspace || key.delete)) {
        const next = editComposer(textDraft(step.contextWindow), input, key).text.replace(/[^0-9]/gu, '');
        if (next !== step.contextWindow) update((state) => ({ ...state, declare: { ...step, contextWindow: next } }));
        return;
      }
      if (step.focus === 'modalities') {
        if (key.leftArrow || key.rightArrow) {
          const next = (step.modalityIndex + (key.leftArrow ? MODEL_INPUT_MODALITIES.length - 1 : 1)) % MODEL_INPUT_MODALITIES.length;
          update((state) => ({ ...state, declare: { ...step, modalityIndex: next } }));
          return;
        }
        if (input === ' ') {
          const modality = MODEL_INPUT_MODALITIES[step.modalityIndex]!;
          // text 恒在：还没有任何声明时，第一格就是 text，按一次即可声明 text-only；
          // 已经有声明之后 text 不可取消——没有文字输入的模型无法承担协调会话。
          const modalities = step.modalities.length === 0 ? ['text' as const]
            : modality === 'text' ? step.modalities
              : step.modalities.includes(modality)
                ? step.modalities.filter((entry) => entry !== modality)
                : [...step.modalities, modality];
          update((state) => ({ ...state, declare: { ...step, modalities } }));
          return;
        }
      }
      if ((step.focus === 'effort' || step.focus === 'action') && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
        const bound = step.focus === 'effort' ? step.effortValues.length + 1 : 2;
        update((state) => ({ ...state, declare: step.focus === 'effort'
          ? { ...step, effortIndex: (step.effortIndex + (key.leftArrow ? bound - 1 : 1)) % bound }
          : { ...step, action: (step.action + (key.leftArrow ? 1 : 1)) % 2 } }));
        return;
      }
      if (key.return && !key.meta && !key.shift) {
        if (step.focus !== 'action') { update((state) => ({ ...state, declare: { ...step, focus: 'action', action: 0 } })); return; }
        if (step.action === 0) { back(); return; }
        confirmDeclare(step);
      }
      return;
    }
    if (key.escape) { cancel(); return; }
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
      // 没有选中候选（刚输入过搜索词，selectedIndex 因此为 -1）就是手填状态：Enter 进入声明，不查询目录。
      if (edit.selectedIndex === models.length || edit.selectedIndex < 0) {
        if (edit.query.trim() === '') { update((state) => ({ ...state, notice: '请输入模型编号，或选择目录候选' })); return; }
        // 手填 exact ID 是独立状态：Enter 直接进入声明并保存，不发起目录查询，也不因无匹配而丢弃输入。
        const manual = edit.query.trim();
        update((state) => ({ ...state, edit: { ...state.edit, model: manual, selectedModelId: null }, declare: openDeclare(state.edit, manual, true, null), notice: null }));
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

  if (state.declare !== null) return renderDeclare(state.declare, state.notice, width, rows, props.identity ?? '保存配置不会自动应用');
  return <ModelSettingsEditor edit={state.edit} notice={state.notice} failing={false} availableWidth={width} rows={rows}
    identity={props.identity ?? '保存配置不会自动应用'} />;
}

/**
 * 声明步视图（定稿 #52）：字段区 + 独立横向 effort + 区域行 + 动作行。
 *
 * 纯渲染：区域、取值与动作都由容器计算后传入，render 不可能提交或改写任何声明。
 */
function renderDeclare(step: DeclareStep, notice: string | null, width: number, rows: number, identity: string) {
  const inner = Math.max(1, width - 8);
  const efforts = [null, ...step.effortValues];
  const effort = efforts[step.effortIndex] ?? null;
  const window = effortWindow(step.effortValues, effort, inner, step.effortValues.length > 0);
  const effortLine = step.effortValues.length === 0 ? '不适用' : window.values.map((value) =>
    ' [' + truncateToDisplayWidth(value, window.labelWidth) + '] ').join('');
  const modalities = step.modalities.length === 0 ? '未声明（未知）' : step.modalities.join(' · ');
  const metadataFields = fieldRows([
    { label: 'Model', value: step.model },
    { label: '上下文窗口', value: step.contextWindow === '' ? '未声明（未知）' : step.contextWindow },
    { label: '输入模态', value: modalities },
    { label: '来源', value: step.catalogMetadata === null ? 'user_declared' : 'catalog 可编辑' },
  ], inner);
  const fields = step.manual ? metadataFields : fieldRows([{ label: 'Model', value: step.model }], inner);
  let reason: string | null = null;
  if (step.manual) {
    try {
      declaredMetadata(step);
    } catch (error) {
      reason = error instanceof Error ? error.message : '元数据无效';
    }
  }
  const area = step.focus === 'window' ? '当前区域：上下文窗口 · 数字键输入'
    : step.focus === 'modalities' ? '当前区域：输入模态 · ←→ 选择 · 空格切换（text 恒在）'
      : step.focus === 'effort' ? '当前区域：Effort · ' + (effort ?? '不指定')
        : '当前区域：操作按钮 · ' + (step.action === 0 ? '返回' : step.manual ? '保存模型' : '应用选择');
  return (
    <DialogFrame title={step.manual ? 'Coordinator · 模型声明' : 'Coordinator · effort'} summary={identity} width={width} rows={rows}
      footer={step.manual ? 'Tab 区域 · ←→ 选项 · 空格切换 · Enter 保存' : 'Tab 区域 · ←→ effort · Enter 应用'}>
      {fields.map((line, index) => (
        <Text key={index} {...(step.focus === 'window' && line.startsWith('上下文窗口') ? { color: tuiColors.focus } : {})}>
          {truncateToDisplayWidth(line, inner)}
        </Text>
      ))}
      <Text>
        <Text color={step.focus === 'effort' ? tuiColors.focus : tuiColors.muted}>Effort </Text>
        {step.effortValues.length === 0 ? <Text dimColor>{effortLine}</Text>
          : <Text>
              <Text inverse={effort === null} bold={effort === null}>{' [不指定] '}</Text>
              {window.values.map((value) => <Text key={value} inverse={value === effort} bold={value === effort}>
                {' [' + truncateToDisplayWidth(value, window.labelWidth) + '] '}
              </Text>)}
            </Text>}
      </Text>
      {step.manual ? <Text>
        <Text color={step.focus === 'modalities' ? tuiColors.focus : tuiColors.muted}>模态 </Text>
        {MODEL_INPUT_MODALITIES.map((modality) => {
          const on = step.modalities.includes(modality);
          return <Text key={modality} inverse={step.focus === 'modalities' && MODEL_INPUT_MODALITIES[step.modalityIndex] === modality}
            bold={on}>{on ? ' [' + modality + '] ' : ' ' + modality + ' '}</Text>;
        })}
      </Text> : null}
      <Text color={tuiColors.border}>{'─'.repeat(inner)}</Text>
      <Text color={tuiColors.warning}>{truncateToDisplayWidth(area, inner)}</Text>
      {notice === null ? null : <Text color={tuiColors.warning}>{truncateToDisplayWidth(notice, inner)}</Text>}
      <ActionRow index={step.action} allowed={reason === null} label={step.manual ? '保存模型' : '应用选择'} />
      {reason === null ? null : <Text dimColor>{truncateToDisplayWidth(reason, inner)}</Text>}
    </DialogFrame>
  );
}
