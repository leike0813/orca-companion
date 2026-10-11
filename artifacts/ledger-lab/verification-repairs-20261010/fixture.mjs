/**
 * 修复批（repair-ledger-lab-verification-findings）证据专用挂载入口。
 *
 * 只挂载 dist 中的生产组件（ProviderLibraryEditor / StartupOnboarding / TuiApp），
 * 应用端口全部来自 dist/tests/tui/harness.js 的合成 fake 或本文件的窄替身：没有真实
 * Orca、GitHub、provider 凭据或网络调用。进程保持运行，由 capture.mjs 通过真实 PTY
 * 发送按键并在指定状态截图。
 *
 * 用法：node fixture.mjs <scene>
 */
import process from 'node:process';
import { setTimeout as schedule } from 'node:timers';
import { createElement } from 'react';
import { render } from 'ink';
import { ThemeProvider } from '@inkjs/ui';

import { tuiTheme } from '../../../dist/src/interfaces/tui/theme.js';
import { ProviderLibraryEditor } from '../../../dist/src/interfaces/tui/components/provider-library-editor.js';
import { StartupOnboarding } from '../../../dist/src/interfaces/tui/screens/startup-onboarding.js';
import { TuiApp } from '../../../dist/src/interfaces/tui/app.js';
import { allChecksOk, createFakePorts, makeSnapshot } from '../../../dist/tests/tui/harness.js';
import { createTranscriptReadingFixture } from '../../../dist/tests/support/transcript-reading.js';
import { protocolEffortCapability } from '../../../dist/src/domain/model-configuration.js';

const scene = process.argv[2];
if (!scene) throw new Error('缺少 scene 参数');

const settle = (ms) => new Promise(resolve => schedule(resolve, ms));
const never = () => new Promise(() => undefined);
// 与生产入口一致：Ink 接管 Ctrl+C（exitOnCtrlC:false），退出必须走 App 的公开出口才能观察到效果清理。
const inkOptions = { exitOnCtrlC: false, interactive: true };
const mount = (element) => render(createElement(ThemeProvider, { theme: tuiTheme }, element), inkOptions);
/** 协调工作区：公开出口（Ctrl+C / exit）卸载并退出，退出时的终端模式恢复因此可在真实 PTY 里观察。 */
const mountWorkspace = (ports) => {
  const instance = render(createElement(ThemeProvider, { theme: tuiTheme },
    createElement(TuiApp, { ports, terminalWidth: process.stdout.columns, initialScopeId: 'scope-1',
      onExit: () => { instance.unmount(); schedule(() => process.exit(0), 150); } })), inkOptions);
  return instance;
};

// --------------------------------------------------------------------------
// 合成 ProviderLibrary / ProviderCatalog（无凭据、无网络）
// --------------------------------------------------------------------------

const connection = {
  connectionRef: 'connection-fixture',
  label: '合成连接',
  providerId: 'anthropic',
  providerIntegration: 'anthropic-messages',
  baseUrl: 'https://provider.invalid/v1',
  credential: { kind: 'managed', credentialRef: 'fixture-credential-ref' },
};
const models = [];
const candidates = [{
  id: 'fixture-model-a',
  label: 'fixture-model-a',
  providerId: 'anthropic',
  protocol: 'anthropic-messages',
  effortCapability: { values: ['low', 'medium', 'high'], source: 'fixture:catalog', optionPath: 'outputConfig.effort' },
  contextWindow: 200000,
  inputModalities: ['text'],
}];
const library = {
  load: () => ({ kind: 'loaded', revision: models.length, connections: [connection], models: [...models] }),
  saveConnection: () => Promise.resolve({ kind: 'saved', revision: models.length, connection }),
  // 与生产 saveModel 同一契约：effort 取值来自目录候选能力，缺失时取固定协议预设；
  // 目录给出完整窗口/模态时按 catalog 来源随记录保存。effort 只来自记录本身，界面才拿得到取值。
  saveModel: input => {
    const fromCatalog = candidates.find(item => item.id === input.model &&
      item.protocol === connection.providerIntegration && item.providerId === connection.providerId);
    const catalogMetadata = fromCatalog === undefined || fromCatalog.contextWindow === null ||
      fromCatalog.inputModalities === undefined || fromCatalog.inputModalities.length === 0 ? null
      : { contextWindow: fromCatalog.contextWindow, inputModalities: [...fromCatalog.inputModalities], source: 'catalog' };
    const metadata = input.metadata ?? catalogMetadata;
    const model = {
      modelRef: 'model-fixture-' + models.length,
      connectionRef: input.connectionRef,
      model: input.model,
      effortCapability: fromCatalog?.effortCapability ?? protocolEffortCapability(connection.providerIntegration) ?? null,
      ...(metadata === null ? {} : { metadata }),
    };
    models.push(model);
    return { kind: 'saved', revision: models.length, model };
  },
  resolveModel: modelRef => ({ kind: 'resolved', connection, model: models.find(item => item.modelRef === modelRef) }),
};
const catalog = {
  presets: () => [{ id: 'anthropic', label: 'Anthropic', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', discovery: true }],
  candidates: () => ({ models: candidates, source: 'catalog', catalogVersion: 'fixture', expired: false }),
  discover: () => Promise.resolve({ models: candidates, source: 'discovery', catalogVersion: 'fixture', expired: false }),
  refresh: () => Promise.resolve({ kind: 'unchanged', catalogVersion: 'fixture' }),
};

// --------------------------------------------------------------------------
// 场景
// --------------------------------------------------------------------------

function historyFixture(count) {
  const messages = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push({ role: index % 2 === 0 ? 'assistant' : 'user', content: '历史条目 ' + index, stepId: 'step-' + index });
  }
  return messages;
}

function startupPorts(options) {
  const fake = createFakePorts({ home: { kind: 'wizard' } });
  const checks = allChecksOk();
  Object.assign(fake.ports.scopeSetup, {
    verifyEnvironment: async report => {
      for (const check of checks) { report?.(check); await settle(120); }
      return checks;
    },
    // 最终确认后的核验：三项已通过后保持未决，画面停在真实的 busy 状态。
    verify: async report => {
      for (const check of checks.slice(0, 3)) { report?.(check); await settle(150); }
      return never();
    },
    routeMapInitialization: {
      list: () => Promise.resolve({ kind: 'ok', value: [{ number: 41, title: '既有 Route Map', url: 'https://tracker.invalid/41' }] }),
      select: number => Promise.resolve({ kind: 'ok', value: { number, url: 'https://tracker.invalid/' + number } }),
      create: () => options.routeMapPending ? never()
        : Promise.resolve({ kind: 'ok', value: { number: 42, url: 'https://tracker.invalid/42' } }),
    },
  });
  Object.assign(fake.ports, {
    modelSettings: {
      load: () => Promise.resolve({ kind: 'failed', code: 'config_unavailable', message: '合成证据夹具' }),
      save: () => ({ kind: 'saved', revision: 1, configurationRef: 'config-fixture', profileRef: null }),
      initializeProject: () => Promise.resolve({ kind: 'saved', revision: 1, configurationRef: 'config-fixture', profileRef: null }),
      library,
      catalog,
    },
  });
  return fake;
}

function workspacePorts(options) {
  const fake = createFakePorts({ home: { kind: 'restore', coordinationScopeId: 'scope-1' } });
  const base = fake.ports;
  const session = {
    coordinatorSessionId: 'session-a',
    coordinatorModelConfigurationRef: 'config-a',
    lifecycleState: 'active',
    holdsRuntimeLease: false,
    holdsExecutionLease: false,
    planningResponsible: true,
    openInteractionCount: 0,
    ...(options.turn === undefined ? {} : { turn: options.turn }),
  };
  const snapshot = { ...fakeSnapshot, sessions: [session, { ...session, coordinatorSessionId: 'session-b', planningResponsible: false }] };
  const page = { coordinatorSessionId: 'session-a', messages: options.history, nextCursor: null };
  const reading = createTranscriptReadingFixture({ coordinatorSessionId: 'session-a', page: () => page });
  const ports = {
    ...base,
    reading: { ...base.reading, history: query => reading.history(query), body: query => reading.body(query) },
    snapshot: selectedSessionId => Promise.resolve({ kind: 'snapshot', snapshot: { ...snapshot, selectedSessionId } }),
    transcript: () => Promise.resolve({ kind: 'transcript', transcript: page }),
  };
  // 提交在途：execute 永不结算，界面必须停在真实 pending 状态。
  if (options.pending === true) ports.execute = () => never();
  return { fake, ports };
}

const fakeSnapshot = makeSnapshot();

const scenes = {
  // 共享 ProviderLibraryEditor：候选声明（横向 effort）与手填声明（元数据来源 user_declared）。
  declare: () => mount(createElement(ProviderLibraryEditor, { library, catalog, width: process.stdout.columns,
    rows: process.stdout.rows, identity: '证据夹具 · 合成连接', onSelect: () => undefined, onCancel: () => undefined })),

  // StartupOnboarding：Route Map 创建在途的 spinner。
  'onboarding-route-create': () => mount(createElement(StartupOnboarding, { ports: startupPorts({ routeMapPending: true }).ports,
    width: process.stdout.columns, onReady: () => undefined, onExit: () => undefined })),

  // StartupOnboarding：最终确认后的五项核验 busy 画面。
  'onboarding-final-busy': () => mount(createElement(StartupOnboarding, { ports: startupPorts({ routeMapPending: false }).ports,
    width: process.stdout.columns, onReady: () => undefined, onExit: () => undefined })),

  // 工作区：真实 running 轮次状态（来自 snapshot.sessions[].turn）。
  'workspace-running': () => mountWorkspace(workspacePorts({ turn: { kind: 'running' }, history: historyFixture(12) }).ports),

  // 工作区：新注册空会话的可读 transcript。
  'workspace-empty': () => mountWorkspace(workspacePorts({ history: [] }).ports),

  // 工作区：提交快照后立即 pending，原草稿分离。
  'workspace-pending': () => mountWorkspace(workspacePorts({ pending: true, history: historyFixture(6) }).ports),

  // 工作区：长历史 + 未提交草稿，供 PTY 发送 SGR 滚轮报告。
  'workspace-mouse': () => mountWorkspace(workspacePorts({ history: historyFixture(40) }).ports),
};

const start = scenes[scene];
if (!start) throw new Error('未知 scene：' + scene);
start();
