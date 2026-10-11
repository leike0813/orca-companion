import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useSpinner } from '@inkjs/ui';
import { DialogFrame } from '../components/selection-list.js';
import { ProviderLibraryEditor } from '../components/provider-library-editor.js';
import { tuiColors, tuiIconMode } from '../theme.js';
import { truncateToDisplayWidth } from '../render/width.js';
import type { TuiPorts, WizardCheck } from '../ports.js';

type Step = 'environment' | 'model' | 'route-map' | 'confirm';
export function StartupOnboarding({ ports, width, onReady, onExit }: {
  readonly ports: TuiPorts; readonly width: number;
  readonly onReady: (scopeId: string | null) => void; readonly onExit: () => void;
}) {
  const size = useWindowSize();
  const columns = size.columns ?? width, rows = size.rows ?? 24;
  const [step, setStep] = useState<Step>('environment');
  const [checks, setChecks] = useState<readonly WizardCheck[]>([]);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [model, setModel] = useState<{ modelRef: string; effort: string | null; label: string } | null>(null);
  const [issue, setIssue] = useState<{ number: number; url: string } | null>(null);
  const [existingConfig, setExistingConfig] = useState(false);
  const [issues, setIssues] = useState<readonly { number: number; title: string; url: string }[]>([]);
  const [action, setAction] = useState(0);
  const [number, setNumber] = useState('');
  const active = useRef(true), inFlight = useRef(false);
  const { frame } = useSpinner({ type: tuiIconMode === 'ascii' ? 'line' : 'dots' });
  const report = (check: WizardCheck) => {
    if (active.current) setChecks(current => [...current.filter(item => item.id !== check.id), check]);
  };
  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice(null);
    try { await work(); }
    catch (error) { if (active.current) setNotice(error instanceof Error ? error.message : '操作失败，请重试'); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  };
  const environment = () => run(async () => {
    setChecks([]);
    const result = await ports.scopeSetup.verifyEnvironment!(report);
    if (!active.current) return;
    if (result.some(check => !check.ok)) { setNotice('环境核验未通过，请处理上方问题后重试'); return; }
    const home = await ports.scopeSetup.resolveHome();
    if (!active.current) return;
    if (home.kind === 'restore') { onReady(home.coordinationScopeId); return; }
    if (home.kind === 'legacy') { onReady(null); return; }
    if (home.kind === 'failed') throw new Error(`${home.code}: ${home.message}`);
    const loaded = await ports.modelSettings?.load();
    if (!active.current) return;
    if (loaded?.kind === 'loaded') { setExistingConfig(true); setStep('confirm'); }
    else if (loaded?.kind === 'failed' && loaded.code !== 'config_unavailable') throw new Error(`${loaded.code}: ${loaded.message}`);
    else setStep('model');
  });
  useEffect(() => {
    active.current = true;
    void environment();
    return () => { active.current = false; };
    // Startup runs once; retries require a user action.
  }, []);

  const selectRouteMap = () => run(async () => {
    const port = ports.scopeSetup.routeMapInitialization;
    if (!port) throw new Error('Route Map 初始化不可用');
    const selected = action === 0 ? await port.create() : await port.select(Number(number));
    if (!active.current) return;
    if (selected.kind === 'failed') throw new Error(`${selected.code}: ${selected.message}`);
    setIssue(selected.value); setStep('confirm');
  });
  const selectModel = async (modelRef: string, effort: string | null): Promise<void | string> => {
    const library = ports.modelSettings?.library?.load();
    const label = library?.kind === 'loaded' ? library.models.find(item => item.modelRef === modelRef)?.model : null;
    setModel({ modelRef, effort, label: label ?? '已选模型' });
    if (!existingConfig) return;
    if (inFlight.current) return '模型配置正在保存';
    inFlight.current = true;
    try {
      const port = ports.modelSettings;
      const loaded = await port?.load();
      if (!port || loaded?.kind !== 'loaded') throw new Error('项目模型配置不可用');
      const saved = await port.save({ role: 'coordinator', modelRef, effort, expectedRevision: loaded.snapshot.revision });
      if (saved.kind !== 'saved') throw new Error(`${saved.code}: ${saved.message}`);
    } catch (error) {
      return error instanceof Error ? error.message : '模型配置保存失败';
    } finally { inFlight.current = false; }
  };
  const confirm = () => run(async () => {
    if (!existingConfig) {
      if (!model || !issue || !ports.modelSettings?.initializeProject) throw new Error('请完成模型和 Route Map 设置');
      const saved = await ports.modelSettings.initializeProject({ modelRef: model.modelRef, effort: model.effort, routeMapIssueNumber: issue.number });
      if (saved.kind !== 'saved') throw new Error(`${saved.code}: ${saved.message}`);
      setExistingConfig(true);
    }
    setChecks([]);
    const verified = await ports.scopeSetup.verify(report);
    if (!active.current) return;
    if (verified.some(check => !check.ok)) throw new Error('模型或 Route Map 核验未通过，请修复配置后重试');
    const proposal = await ports.scopeSetup.proposal();
    if (!active.current) return;
    const result = await ports.scopeSetup.initialize(proposal);
    if (!active.current) return;
    if (result.kind !== 'accepted') throw new Error(`${result.code}: ${result.message}`);
    onReady(proposal.coordinationScopeId);
  });
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { active.current = false; ports.exitIntent?.(); onExit(); return; }
    if (step === 'model') return;
    if (key.escape && !busy) { ports.exitIntent?.(); onExit(); return; }
    if (busy) return;
    if (step === 'environment') { if (key.return) void environment(); return; }
    if (step === 'confirm') {
      if (input === 'm') { setNotice(null); setStep('model'); }
      else if (key.return) void confirm();
      return;
    }
    if (key.upArrow || key.downArrow) { setAction(action === 0 ? 1 : 0); return; }
    if (key.ctrl && input === 'l') {
      void run(async () => {
        const port = ports.scopeSetup.routeMapInitialization;
        if (!port) throw new Error('Route Map 初始化不可用');
        const listed = await port.list();
        if (listed.kind === 'failed') throw new Error(`${listed.code}: ${listed.message}`);
        if (active.current) setIssues(listed.value);
      }); return;
    }
    if (key.return) { void selectRouteMap(); return; }
    if (action === 1) {
      if (key.backspace || key.delete) setNumber(number.slice(0, -1));
      else if (/^\d+$/u.test(input)) setNumber((number + input).slice(0, 10));
    }
  });
  const library = ports.modelSettings?.library, catalog = ports.modelSettings?.catalog;
  if (step === 'model' && library && catalog) return <ProviderLibraryEditor library={library} catalog={catalog}
    width={columns} rows={rows} identity="项目环境  ›  Coordinator  ›  Route Map  ›  开始规划" onSelect={selectModel}
    onSelected={() => { if (active.current) setStep(existingConfig ? 'confirm' : 'route-map'); }}
    onCancel={() => { ports.exitIntent?.(); onExit(); }} />;
  const fit = (value: string) => truncateToDisplayWidth(value, Math.max(1, columns - 8));
  const labels = { repository: '项目仓库', orca: 'Orca 连接', identity: '项目身份', model: '模型能力', tracker: 'Route Map' };
  const symbols = tuiIconMode === 'ascii' ? { passed: '+', failed: 'x', waiting: '-' } : { passed: '✓', failed: '✗', waiting: '·' };
  const ids = step === 'confirm' && busy ? ['repository', 'orca', 'identity', 'model', 'tracker'] as const : ['repository', 'orca', 'identity'] as const;
  return <DialogFrame title="Orca Companion" summary="项目环境  ›  Coordinator  ›  Route Map  ›  开始规划" width={columns} rows={Math.max(12, rows - 2)}
    footer={busy ? '核验中 · Ctrl+C 退出' : step === 'environment' ? 'Enter 重试核验 · Esc 退出' : step === 'route-map' ? '↑↓ 选择 · Ctrl+L 查看 issues · Enter 继续 · Esc 退出' : 'Enter 确认初始化 · m 修改模型 · Esc 退出'}>
    <Box flexDirection="column" gap={1}>
      <Text bold color={tuiColors.accent}>{step === 'environment' ? '正在准备项目环境' : step === 'route-map' ? '设置 Route Map' : step === 'model' ? '设置 Coordinator 模型' : '准备开始规划'}</Text>
      {step === 'environment' || step === 'confirm' && busy ? ids.map(id => {
        const check = checks.find(item => item.id === id);
        const pending = busy && !check && ids.find(candidate => !checks.some(item => item.id === candidate)) === id;
        const marker = check ? check.ok ? symbols.passed : symbols.failed : pending ? frame : symbols.waiting;
        return <Text key={id} color={check ? check.ok ? tuiColors.success : tuiColors.error : tuiColors.muted}>
          {fit(`${marker} ${labels[id]}${check ? '  ' + check.detail : ''}`)}
        </Text>;
      }) : null}
      {step === 'route-map' ? <>
        {busy ? <Text color={tuiColors.muted}>{frame} {action === 0 ? '正在创建 Route Map…' : '正在读取 Route Map…'}</Text> : null}
        <Text inverse={action === 0}> 创建空 Route Map </Text>
        <Text inverse={action === 1}>{fit(' 选择已有 issue  #' + (number || '输入编号'))}</Text>
        {issues.slice(0, Math.max(0, rows - 14)).map(item => <Text key={item.number} dimColor>{fit(`#${item.number}  ${item.title}`)}</Text>)}
      </> : null}
      {step === 'confirm' && !busy ? <>
        <Text>{fit(model ? `Coordinator  ${model.label}` : '使用已保存的 Coordinator 配置')}</Text>
        {issue ? <Text>{fit(`Route Map  #${issue.number}`)}</Text> : null}
        <Text>确认后核验模型连接并开始规划。</Text>
        <Text inverse> 确认初始化 </Text>
      </> : null}
      {notice ? <Text color={tuiColors.error}>{fit(notice)}</Text> : null}
    </Box>
  </DialogFrame>;
}
