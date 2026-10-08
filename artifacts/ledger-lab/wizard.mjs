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
  if (previous.kind === 'failed') throw new Error(previous.message);
  const config = previous.kind === 'read' ? previous.config : null;
  const current = config?.coordinatorModels.find((model) => model.configurationRef === config.defaultCoordinatorModelRef);
  const integration = await prompt.ask('Coordinator 已安装的 provider integration（module#export）', current?.providerIntegration ?? '');
  const model = await prompt.ask('Coordinator 模型 ID', current?.model ?? '');
  if (!integration || !model) throw new Error('provider integration 与模型不能为空');
  const connectionOptions = await prompt.ask('连接非秘密 SDK options（JSON 对象）', JSON.stringify(current?.providerConnection?.modelOptions ?? {}));
  const modelOptions = await prompt.ask('模型非秘密 SDK options（JSON 对象）', JSON.stringify(current?.modelOptions ?? {}));
  const parseOptions = (text) => {
    let value;
    try { value = JSON.parse(text); } catch { throw new Error('SDK options 必须为 JSON 对象'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SDK options 必须为 JSON 对象');
    return value;
  };
  const auth = await choose(prompt, 'Coordinator 认证', ['environment', 'existing', 'new'], current?.providerConnection?.credential.kind === 'managed' ? 'existing' : 'environment');
  let credential = { kind: 'harness_login' };
  let newSecret;
  if (auth !== 'environment') {
    const optionPath = await prompt.ask('凭据注入的 SDK 字段路径', current?.providerConnection?.credential.optionPath ?? 'apiKey');
    let credentialRef = null;
    if (auth === 'existing') {
      const metadata = host.credentials.metadata();
      if (metadata.kind === 'rejected') throw new Error(metadata.message);
      if (!metadata.refs.length) throw new Error('凭据库没有可用引用，请选择 new 或 environment');
      credentialRef = await choose(prompt, '凭据引用', metadata.refs, current?.providerConnection?.credential.credentialRef ?? metadata.refs[0]);
    } else {
      prompt.say('新 key 保存到现有用户级 CredentialStore；不回显、不写入演练配置。');
      newSecret = await prompt.secret('新 key');
      if (!newSecret) throw new Error('新 key 不能为空');
    }
    credential = { kind: 'managed', optionPath, credentialRef };
  }
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
  return host.save({ coordinator: { connection: { label: 'ledger-lab', providerIntegration: integration,
      modelOptions: parseOptions(connectionOptions), credential }, model, modelOptions: parseOptions(modelOptions),
      ...(newSecret === undefined ? {} : { newSecret }) }, workers, maxMutations, maxInputTokens });
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
