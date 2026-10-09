import process from 'node:process';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function requireInteractive(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('首次配置需要交互式终端；请先运行 pnpm lab configure');
}

export function createTerminalPrompter(input = process.stdin, output = process.stdout) {
  requireInteractive(input, output);
  return {
    async ask(label, fallback = '') {
      const reader = createInterface({ input, output });
      try {
        return await new Promise((resolve, reject) => {
          reader.once('SIGINT', () => { reader.close(); reject(new Error('配置已取消')); });
          reader.once('close', () => reject(new Error('配置已取消')));
          reader.question(`${label}${fallback === '' ? '' : ` [${fallback}]`}: `, (answer) => resolve(answer.trim() || fallback));
        });
      } finally { reader.close(); }
    },
    async secret(label) {
      output.write(`${label}: `);
      const wasRaw = input.isRaw;
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      let value = '';
      try {
        return await new Promise((resolve, reject) => {
          const finish = (error) => { input.off('keypress', onKey); input.off('end', onEnd); error ? reject(error) : resolve(value); };
          const onEnd = () => finish(new Error('配置已取消'));
          const onKey = (text, key = {}) => {
            if (key.ctrl && key.name === 'c') finish(new Error('配置已取消'));
            else if (key.name === 'return' || key.name === 'enter') finish();
            else if (key.name === 'backspace') value = value.slice(0, -1);
            else if (!key.ctrl && !key.meta && typeof text === 'string') value += text.replace(/[\r\n]/gu, '');
          };
          input.on('keypress', onKey); input.once('end', onEnd);
        });
      } finally { input.setRawMode(wasRaw === true); input.pause(); output.write('\n'); value = ''; }
    },
    say: (text) => output.write(`${text}\n`),
  };
}

async function choose(prompt, label, choices, fallback = choices[0]) {
  for (;;) {
    const answer = await prompt.ask(`${label} (${choices.join(' / ')})`, fallback);
    if (choices.includes(answer)) return answer;
    prompt.say('请从列出的选项中选择。');
  }
}

async function integer(prompt, label, fallback, minimum) {
  for (;;) {
    const text = await prompt.ask(label, String(fallback));
    if (/^\d+$/u.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= minimum) return Number(text);
    prompt.say(`请输入不小于 ${minimum} 的安全整数。`);
  }
}

export async function configureSettings({ settingsPath, prompt, host, catalog, roles, harnesses }) {
  const previous = host.read();
  if (previous.kind === 'failed') throw Object.assign(new Error(previous.message), { code: previous.code });
  const config = previous.kind === 'read' ? previous.config : null;
  const active = config?.coordinatorModels.find((model) => model.configurationRef === config.defaultCoordinatorModelRef);
  const library = host.providerLibrary;
  let available = library.load();
  if (available.kind !== 'loaded') throw Object.assign(new Error(available.message), { code: available.code });
  const credentials = host.credentials.metadata();
  if (credentials.kind === 'rejected') throw Object.assign(new Error(credentials.message), { code: credentials.code });
  prompt.say('正在更新公共 Provider 和模型目录…');
  const refreshed = await host.providerCatalog.refresh();
  prompt.say(refreshed.kind === 'failed' ? '目录更新失败，继续使用缓存或内置目录。'
    : refreshed.kind === 'unchanged' ? '公共目录已是最新。' : '公共目录已更新。');
  let connection;
  let refreshConnection = false;
  if (available.connections.length > 0 && await choose(prompt, 'Coordinator 连接', ['existing', 'new'], 'existing') === 'existing') {
    connection = await selectLibraryConnection(prompt, available.connections);
    refreshConnection = true;
  } else {
    connection = await addConnection(prompt, library, host.providerCatalog, available.revision);
    available = library.load();
    if (available.kind !== 'loaded') throw Object.assign(new Error(available.message), { code: available.code });
  }
  if (refreshConnection) {
    try { await host.providerCatalog.discover(connection); } catch { /* 连接和离线候选仍可用。 */ }
  }
  const candidates = host.providerCatalog.candidates(connection).models;
  const modelChoice = await selectCoordinatorModel(prompt, candidates, active?.model);
  const savedModel = library.saveModel({ expectedRevision: available.revision, connectionRef: connection.connectionRef, model: modelChoice });
  if (savedModel.kind !== 'saved') throw Object.assign(new Error(savedModel.message), { code: savedModel.code });
  const effortValues = savedModel.model.effortCapability?.values ?? [];
  const effort = effortValues.length === 0 ? null : await choose(prompt, 'Coordinator effort', ['default', ...effortValues], 'default');
  const workers = [];
  for (const role of roles) {
    const selectedRef = config?.execution.workerProfileRefs[role];
    const previousProfile = config?.execution.workerProfiles.find((profile) => profile.profileRef === selectedRef);
    const harness = await choose(prompt, `${role} harness`, harnesses, previousProfile?.harness ?? harnesses[0]);
    const queried = await catalog.query({ harness });
    if (queried.kind === 'available') {
      for (const [index, candidate] of queried.models.entries()) prompt.say(`${index + 1}. ${candidate.model}`);
    } else prompt.say(`目录不可用（${queried.code}），可以填写未验证模型 ID。`);
    const answer = await prompt.ask(`${role} 模型序号或原生 ID`, previousProfile?.modelSelection.model ?? '');
    const selected = queried.kind === 'available'
      ? queried.models.find((entry, index) => entry.model === answer || String(index + 1) === answer) : undefined;
    const nativeModel = selected?.model ?? answer;
    if (!nativeModel) throw new Error(`${role} 模型不能为空`);
    const capability = selected?.effortCapability ?? null;
    const effort = capability === null ? null : await choose(prompt, `${role} effort`, ['default', ...capability.values], 'default');
    workers.push({ role, harness, modelSelection: { model: nativeModel, effort: effort === 'default' ? null : effort,
      effortCapability: capability, catalogSource: selected ? queried.source : null } });
  }
  const maxMutations = await integer(prompt, '规划 tracker 写入预算', config?.planning.maxMutations ?? 100, 1);
  const maxInputTokens = await integer(prompt, 'Coordinator 输入 token 上限', config?.context.maxInputTokens ?? 120000, 1);
  const confirm = await choose(prompt, '保存以上选择作为后续演练默认配置', ['save', 'cancel'], 'cancel');
  if (confirm !== 'save') throw new Error('配置已取消');
  await mkdir(dirname(settingsPath), { recursive: true, mode: 0o700 });
  return host.save({ coordinator: { modelRef: savedModel.model.modelRef, effort: effort === 'default' ? null : effort }, workers, maxMutations, maxInputTokens });
}

const PAGE_SIZE = 20;

async function selectPaged(prompt, label, rows, display, match, fallback, allowManual = false) {
  let query = '';
  let page = 0;
  for (;;) {
    const matches = rows.filter((row) => match(row, query));
    if (query !== '') {
      const exact = matches.find((row) => display(row).split(' — ')[0] === query);
      if (exact) return exact;
    }
    const start = page * PAGE_SIZE;
    for (const [index, row] of matches.slice(start, start + PAGE_SIZE).entries()) prompt.say(`${index + 1}. ${display(row)}`);
    if (matches.length > PAGE_SIZE) prompt.say(`共 ${matches.length} 项；当前显示 ${start + 1}-${Math.min(start + PAGE_SIZE, matches.length)}。`);
    const answer = await prompt.ask(`${label}：输入序号、搜索词${matches.length > PAGE_SIZE ? '、next' : ''}或精确名称`, fallback ?? '');
    if (allowManual && answer === 'manual') return null;
    if (/^\d+$/u.test(answer) && Number(answer) >= 1 && Number(answer) <= Math.min(PAGE_SIZE, matches.length - start)) return matches[start + Number(answer) - 1];
    if (answer === 'next' && start + PAGE_SIZE < matches.length) { page += 1; continue; }
    const exact = matches.find((row) => display(row).split(' — ')[0] === answer);
    if (exact) return exact;
    query = answer;
    page = 0;
  }
}

async function selectLibraryConnection(prompt, connections) {
  return selectPaged(prompt, '选择用户级连接', connections,
    (row) => `${row.label} — ${row.providerId} (${row.providerIntegration})`,
    (row, query) => query === '' || `${row.label} ${row.providerId} ${row.providerIntegration}`.toLowerCase().includes(query.toLowerCase()));
}

async function addConnection(prompt, library, catalog, revision) {
  const presets = catalog.presets();
  const source = await choose(prompt, 'Coordinator provider 来源', ['preset', 'custom'], 'preset');
  let providerId, protocol, baseUrl, label;
  if (source === 'preset') {
    const preset = await selectPaged(prompt, '搜索 provider（名称含地区/产品线）', presets,
      (row) => `${row.label} — ${row.id} (${row.protocol})`,
      (row, query) => query === '' || `${row.label} ${row.id} ${row.protocol}`.toLowerCase().includes(query.toLowerCase()));
    ({ id: providerId, protocol, baseUrl } = preset);
    label = await prompt.ask('连接名称', preset.label);
    if (baseUrl === null) baseUrl = await prompt.ask('Provider 地址');
  } else {
    providerId = 'custom';
    protocol = await choose(prompt, '自定义协议', ['openai-chat', 'openai-responses', 'anthropic-messages'], 'openai-chat');
    label = await prompt.ask('连接名称');
    baseUrl = await prompt.ask('Provider 地址');
  }
  const newSecret = await prompt.secret('API Key');
  if (!newSecret) throw new Error('API Key 不能为空');
  const saved = await library.saveConnection({ expectedRevision: revision, label, providerId, providerIntegration: protocol, baseUrl, newSecret });
  if (saved.kind !== 'saved') throw Object.assign(new Error(saved.message), { code: saved.code });
  prompt.say('API Key 已保存到用户级凭据库；不会显示或写入项目配置。');
  return saved.connection;
}

async function selectCoordinatorModel(prompt, candidates, previousModel) {
  if (candidates.length === 0) {
    prompt.say('模型目录不可用或没有候选；可以手动填写精确模型 ID。');
    return prompt.ask('Coordinator 精确模型 ID', previousModel ?? '');
  }
  const selected = await selectPaged(prompt, '选择 Coordinator 模型（输入 manual 手填）', candidates,
    (row) => `${row.id} — ${row.label}`, (row, query) => query === '' || `${row.id} ${row.label}`.toLowerCase().includes(query.toLowerCase()), previousModel, true);
  return selected?.id ?? prompt.ask('Coordinator 精确模型 ID', previousModel ?? '');
}

export async function runConfigurationWizard(settingsPath, environment = process.env, credentials) {
  const prompt = createTerminalPrompter();
  const [{ createLedgerLabConfigurationHost }, { createWorkerModelSettingsCatalog }, { MODEL_PROFILE_ROLES, WORKER_HARNESS_IDS }] = await Promise.all([
    import('../../dist/src/bootstrap/ledger-lab.js'), import('../../dist/src/bootstrap/worker-model-settings.js'), import('../../dist/src/domain/model-configuration.js'),
  ]);
  const catalog = createWorkerModelSettingsCatalog({ cwd: () => process.cwd(), env: environment });
  const host = createLedgerLabConfigurationHost({ configPath: settingsPath, env: environment, verifyWorkerSelection: catalog.verify,
    ...(credentials ? { credentials } : {}) });
  return configureSettings({ settingsPath, prompt, host, catalog, roles: MODEL_PROFILE_ROLES, harnesses: WORKER_HARNESS_IDS });
}
