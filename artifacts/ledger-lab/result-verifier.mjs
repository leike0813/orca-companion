/**
 * ledger-lab 业务输出验收器。
 *
 * 从被测仓库之外用 Node 子进程调用项目 CLI（`node <entry> <input> ...`），按 `contract.json`（唯一
 * 事实源）核对真实 stdout/stderr、退出码与 CSV/JSON 语义。期望输出只来自 `cases.json` 的数据；版本
 * 差异只按 `contract.json` 的 `projections` 做别名替换、CSV 排序与商户抹除，不含阈值、分组或汇总算法。
 *
 * 判定口径：任何检查未通过都不能给出 PASS；结论优先级为 FAIL > BLOCKED > INCONCLUSIVE > PASS（与
 * common.overall 一致）。入口缺失、仓库不可用、临时目录落在被测仓库内记 BLOCKED；超时、输出被截断或
 * 运行结果未知记 INCONCLUSIVE。输入文件写在系统临时目录（被测仓库之外），运行前后用只读 Git 事实核对
 * 被测项目未被改动；Git 任一事实不可读时不判 PASS。
 *
 * 本模块只导出函数，不在导入时执行 CLI 或产生副作用。
 */

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const REPORT_SCHEMA_VERSION = 1;
export const RESULT_REPORT_KIND = 'result-report';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 64 * 1024;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = join(MODULE_DIR, 'contract.json');
const CASES_PATH = join(MODULE_DIR, 'cases.json');
const KNOWN_FLAGS = ['--format', '--threshold-cents', '--line-ending'];
const KNOWN_CSV_ORDERS = ['id-asc', 'amount-desc'];
const MAX_DETAIL_ITEMS = 12;
const MAX_DETAIL_TEXT = 400;
const MAX_GIT_FACT_TEXT = 4096;

let cachedContract = null;

/** 读取并核验 contract.json；所有合同常量（含 projections/defaults/lineEndings）都从这里来。 */
export function loadContract() {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  validateContract(contract);
  return contract;
}

/**
 * 读取 cases.json 并核验数据表。
 *
 * 投影规则只属于 contract.json；返回值把 `projections` 兼容性地指向 `contract.projections`，
 * 数据表本身不得携带该字段。本函数只读文件，不写任何内容。
 */
export function loadCaseSet(contract = defaultContract()) {
  const dataset = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  validateCaseSet(dataset, contract);
  return { schemaVersion: dataset.schemaVersion, cases: dataset.cases, projections: contract.projections };
}

/**
 * 验收单个用例的一个格式。
 *
 * 供 `verifyResult` 内部调用，也供测试直接按用例驱动 `run` seam。返回单个 check 对象。
 */
export async function verifyCase(params) {
  const { caseDef, version, format, lineEnding, repositoryPath, entry, run, contract, projections } = params;
  const omitted = omittedFlags(caseDef);
  const effectiveLineEnding = omitted.includes('--line-ending')
    ? contract.defaults.lineEnding
    : (caseDef.lineEnding ?? lineEnding);
  const checkId = `case:${caseDef.id}:${format}`;
  const details = {
    caseId: caseDef.id,
    version,
    format,
    lineEnding: effectiveLineEnding,
    argv: buildArgvKinds(caseDef, format, contract),
  };
  if (isInsideRoot(repositoryPath, tmpdir())) {
    return makeCheck(checkId, 'BLOCKED', `invalidIO：系统临时目录位于被测仓库内（${tmpdir()}），拒绝写入`, details);
  }
  const tempDir = mkdtempSync(join(tmpdir(), 'ledger-lab-verify-'));
  try {
    if (isInsideRoot(repositoryPath, tempDir)) {
      return makeCheck(checkId, 'BLOCKED', `invalidIO：临时目录位于被测仓库内（${tempDir}），拒绝写入`, details);
    }
    const inputPath = join(tempDir, `${caseDef.id}.json`);
    if (caseDef.invoke?.missingInput !== true) {
      const content = typeof caseDef.invoke?.rawInput === 'string'
        ? caseDef.invoke.rawInput
        : JSON.stringify(caseDef.input ?? []);
      writeFileSync(inputPath, content, 'utf8');
    }
    const args = buildInvocationArgs({ caseDef, format, entry, inputPath, lineEnding, contract });
    let result;
    try {
      result = await run({
        executable: process.execPath,
        args,
        cwd: repositoryPath,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxBytes: DEFAULT_MAX_BYTES,
      });
    } catch (error) {
      return makeCheck(checkId, 'INCONCLUSIVE', `运行 seam 抛出异常：${errorMessage(error)}`, {
        ...details,
        error: errorMessage(error),
      });
    }
    return interpretResult({ caseDef, version, format, lineEnding: effectiveLineEnding, checkId, details, result, contract, projections });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 从被测仓库之外验收一个版本的全部业务输出。
 *
 * @param {{ repositoryPath: string, version?: string, entry?: string, lineEnding?: 'lf'|'crlf', run?: Function }} options
 * @returns {Promise<object>} result-report
 */
export async function verifyResult(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('verifyResult 需要选项对象');
  const contract = defaultContract();
  const repositoryPath = requireString(options.repositoryPath, 'repositoryPath');
  const version = options.version ?? contract.versions[0];
  const entry = requireString(options.entry ?? contract.entry, 'entry');
  const lineEnding = options.lineEnding ?? contract.defaults.lineEnding;
  const run = options.run ?? defaultRun;
  if (typeof run !== 'function') throw new TypeError('run 必须是函数');
  if (!contract.versions.includes(version)) throw new TypeError(`未知 version：${version}`);
  if (typeof contract.lineEndings[lineEnding] !== 'string') throw new TypeError(`未知 lineEnding：${lineEnding}`);

  const observedAt = new Date().toISOString();
  const dataset = loadCaseSet(contract);
  const header = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: RESULT_REPORT_KIND,
    version,
    entry,
    lineEnding,
    repositoryPath,
    observedAt,
  };

  const probe = preflight(repositoryPath, entry);
  if (probe.blocked !== null) return finalizeReport(header, [probe.blocked], null);

  const checks = [...probe.checks];
  for (const caseDef of dataset.cases) {
    if (!caseDef.versions.includes(version)) continue;
    for (const format of caseDef.formats) {
      checks.push(await verifyCase({ caseDef, version, format, lineEnding, repositoryPath, entry, run, contract, projections: dataset.projections }));
    }
  }
  const after = snapshotGit(repositoryPath);
  checks.push(gitUnchangedCheck(probe.before, after));
  return finalizeReport(header, checks, { before: gitFactsView(probe.before), after: gitFactsView(after) });
}

/**
 * 只按投影规则推导期望 JSON（别名 + 别名碰撞合并），不使用用例的显式 override。
 *
 * 别名碰撞（例如同时存在 `餐饮` 与 `food`）把同一别名桶的 count/totalCents 相加；这与账单分组逻辑无关。
 * 显式 golden 用例用 `expectedJsonByVersion` 覆盖本推导，避免验收器成为期望值的唯一来源。
 */
export function projectExpectedJson(caseDef, version, { contract, projections }) {
  if (!isPlainObject(caseDef.expectedJson)) throw new Error(`case ${caseDef.id} 缺少 expectedJson`);
  const json = cloneJson(caseDef.expectedJson);
  if (!projections.aliasVersions.includes(version)) return json;
  const merged = new Map();
  for (const item of json.byCategory) {
    const aliased = contract.aliases[item.category];
    const category = typeof aliased === 'string' ? aliased : item.category;
    const existing = merged.get(category);
    if (existing === undefined) {
      merged.set(category, { category, count: item.count, totalCents: item.totalCents });
      continue;
    }
    existing.count += item.count;
    existing.totalCents += item.totalCents;
  }
  json.byCategory = [...merged.values()];
  return json;
}

/** 某版本的期望 JSON：`expectedJsonByVersion` 显式 golden 优先，否则按投影规则推导。 */
export function expectedJsonForCase(caseDef, version, context) {
  const override = caseDef.expectedJsonByVersion?.[version];
  if (isPlainObject(override)) return cloneJson(override);
  return projectExpectedJson(caseDef, version, context);
}

/**
 * 由 `cases.json` 的输入记录与投影规则生成某版本的完整期望 CSV 表（含表头；CSV 保留类别原值）。
 */
export function expectedCsvRowsForCase(caseDef, version, { contract, projections }) {
  const redact = projections.redactMerchantVersions.includes(version);
  const rows = caseDef.input.map((record) => [
    String(record.id),
    String(record.category),
    redact ? contract.redactedMerchant : String(record.merchant),
    String(record.amountCents),
  ]);
  const order = projections.csvOrder[version];
  if (order === 'id-asc') {
    rows.sort((left, right) => codePointCompare(left[0], right[0]));
  } else if (order === 'amount-desc') {
    rows.sort((left, right) => Number(right[3]) - Number(left[3]) || codePointCompare(left[0], right[0]));
  } else {
    throw new Error(`未知 csvOrder：${String(order)}`);
  }
  return [[...contract.csvColumns], ...rows];
}

/**
 * 构造被测 CLI 的 argv（不含 executable）：`node <entry> <input> [flags] [extraArgs]`。
 *
 * `invoke.omitFlags` 让验收真正省略某个 flag 以核验合同默认值；`invoke.extraArgs` 追加重复、未知或悬空
 * 的 flag。省略规则只依赖 contract.defaults / contract.lineEndings，不在参数里重复默认值。
 */
export function buildInvocationArgs({ caseDef, format, entry, inputPath, lineEnding, contract }) {
  const invoke = isPlainObject(caseDef.invoke) ? caseDef.invoke : {};
  const omitted = omittedFlags(caseDef);
  const args = [entry, inputPath];
  if (!omitted.includes('--format')) {
    args.push('--format', typeof invoke.formatToken === 'string' ? invoke.formatToken : format);
  }
  if (!omitted.includes('--threshold-cents')) {
    args.push('--threshold-cents', typeof invoke.thresholdToken === 'string'
      ? invoke.thresholdToken
      : String(caseDef.thresholdCents ?? contract.limits.defaultThresholdCents));
  }
  if (!omitted.includes('--line-ending')) {
    args.push('--line-ending', caseDef.lineEnding ?? lineEnding);
  }
  if (Array.isArray(invoke.extraArgs)) args.push(...invoke.extraArgs);
  return args;
}

/** 把行序列编码成带指定行尾的 CSV 文本（仅用于构造期望输出，不参与被测实现）。 */
export function encodeCsv(rows, lineEnding, contract = defaultContract()) {
  const terminator = contract.lineEndings?.[lineEnding];
  if (typeof terminator !== 'string') throw new TypeError(`未知 lineEnding：${String(lineEnding)}`);
  if (rows.length === 0) return '';
  return rows.map((row) => row.map(encodeCsvCell).join(',')).join(terminator) + terminator;
}

/**
 * 严格的 RFC 4180 风格 CSV 解析：正确处理引号、转义引号、字段内逗号与换行。
 *
 * 返回 `{ rows, terminators }`；terminators 是记录之间的结构行尾，用于核验 `--line-ending`。
 * 需要引号却未加引号的字段会让解析失败或产生列数不符，不会通过比较。
 */
export function parseCsv(text) {
  if (typeof text !== 'string') throw new TypeError('parseCsv 需要字符串');
  const rows = [];
  const terminators = [];
  let row = [];
  let field = '';
  let index = 0;
  let inQuotes = false;
  let afterQuote = false;
  let rowEnded = true;

  const pushField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    rowEnded = true;
  };

  while (index < text.length) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        afterQuote = true;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (afterQuote) {
      if (char === ',') {
        pushField();
        rowEnded = false;
        index += 1;
        continue;
      }
      if (char === '\n') {
        terminators.push('\n');
        pushRow();
        index += 1;
        continue;
      }
      if (char === '\r' && text[index + 1] === '\n') {
        terminators.push('\r\n');
        pushRow();
        index += 2;
        continue;
      }
      throw new Error(`CSV 非法：结束引号后出现字符 ${JSON.stringify(char)}（offset ${index}）`);
    }
    if (char === '"') {
      if (field.length > 0) throw new Error(`CSV 非法：未加引号的字段中出现引号（offset ${index}）`);
      inQuotes = true;
      rowEnded = false;
      index += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      rowEnded = false;
      index += 1;
      continue;
    }
    if (char === '\n') {
      terminators.push('\n');
      pushRow();
      index += 1;
      continue;
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') {
        terminators.push('\r\n');
        pushRow();
        index += 2;
        continue;
      }
      throw new Error(`CSV 非法：孤立回车（offset ${index}）`);
    }
    field += char;
    rowEnded = false;
    index += 1;
  }

  if (inQuotes) throw new Error('CSV 非法：引号未闭合');
  if (!rowEnded) pushRow();
  return { rows, terminators };
}

/** 生产用 `run` 实现：数组参数、有界 stdout/stderr、超时即杀并立刻返回，不等待子进程退出。 */
export async function defaultRun({ executable, args, cwd, timeoutMs, maxBytes }) {
  return await new Promise((resolveOutcome) => {
    let settled = false;
    let timer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolveOutcome(outcome);
    };

    let child;
    try {
      child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ exitCode: null, stdout: '', stderr: '', error: { code: 'SPAWN_FAILED', message: errorMessage(error) } });
      return;
    }

    const stdout = { text: '', bytes: 0, truncated: false };
    const stderr = { text: '', bytes: 0, truncated: false };
    child.stdout.on('data', (chunk) => appendBounded(stdout, chunk, maxBytes));
    child.stderr.on('data', (chunk) => appendBounded(stderr, chunk, maxBytes));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', (error) => {
      const code = error?.code === 'ENOENT' ? 'ENOENT' : 'SPAWN_FAILED';
      finish({ exitCode: null, stdout: stdout.text, stderr: stderr.text, error: { code, message: errorMessage(error) } });
    });
    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({
        exitCode: null,
        stdout: stdout.text,
        stderr: stderr.text,
        error: { code: 'TIMEOUT', message: `超过 ${timeoutMs}ms 未结束` },
      });
    }, timeoutMs);
  });
}

function appendBounded(target, chunk, maxBytes) {
  if (target.truncated) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = maxBytes - target.bytes;
  if (remaining <= 0) {
    target.truncated = true;
    return;
  }
  if (buffer.length <= remaining) {
    target.text += buffer.toString('utf8');
    target.bytes += buffer.length;
    return;
  }
  target.text += buffer.subarray(0, remaining).toString('utf8');
  target.bytes = maxBytes;
  target.truncated = true;
}

function interpretResult({ caseDef, version, format, lineEnding, checkId, details, result, contract, projections }) {
  if (!isPlainObject(result)) return fail(checkId, '运行 seam 返回了非对象结果', details);

  const runError = isPlainObject(result.error) ? result.error : null;
  if (runError !== null) {
    const code = typeof runError.code === 'string' ? runError.code : 'UNKNOWN';
    const errorText = typeof runError.message === 'string' ? runError.message : undefined;
    if (code === 'ENOENT' || code === 'SPAWN_FAILED') {
      return makeCheck(checkId, 'BLOCKED', `missingCLI：无法启动 CLI（${code}）`, { ...details, error: errorText });
    }
    if (code === 'TIMEOUT') {
      return makeCheck(checkId, 'INCONCLUSIVE', `运行超时（>${DEFAULT_TIMEOUT_MS}ms）`, { ...details, error: errorText });
    }
    return makeCheck(checkId, 'INCONCLUSIVE', `运行结果未知（${code}）`, { ...details, error: errorText });
  }
  if (result.stdoutTruncated === true || result.stderrTruncated === true) {
    return makeCheck(checkId, 'INCONCLUSIVE', `输出超过 ${DEFAULT_MAX_BYTES} 字节上限，无法完整判定`, details);
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const isErrorCase = caseDef.expectErrorKind !== undefined;
  const expectedExit = isErrorCase ? contract.outputSemantics.errorExitCode : contract.outputSemantics.successExitCode;

  if (result.exitCode !== expectedExit) {
    return fail(checkId, `期望退出码 ${expectedExit}，实际 ${describeValue(result.exitCode)}`, {
      ...details,
      stdout: clampText(stdout),
      stderr: clampText(stderr),
    });
  }
  if (isErrorCase) {
    const expectedCode = contract.errorCodes[caseDef.expectErrorKind];
    const observedCode = findErrorCode(stderr);
    if (observedCode !== expectedCode) {
      return fail(checkId, `错误码期望 ${expectedCode}，实际 ${observedCode === null ? '未提供或不可解析' : observedCode}`, {
        ...details,
        stderr: clampText(stderr),
      });
    }
    return makeCheck(checkId, 'PASS', `退出码 ${expectedExit}，错误码 ${expectedCode}`, details);
  }
  if (stderr.trim() !== '') return fail(checkId, '成功时 stderr 应为空', { ...details, stderr: clampText(stderr) });

  if (format === 'json') {
    let actual;
    try {
      actual = JSON.parse(stdout);
    } catch (error) {
      return fail(checkId, `stdout 不是合法 JSON：${errorMessage(error)}`, { ...details, stdout: clampText(stdout) });
    }
    const expected = expectedJsonForCase(caseDef, version, { contract, projections });
    const diffs = capDiffs(compareJsonOutput(actual, expected, contract));
    return diffs.length === 0
      ? makeCheck(checkId, 'PASS', 'JSON 输出与期望语义一致', details)
      : fail(checkId, 'JSON 输出与期望不一致', { ...details, diffs });
  }

  const expectedRows = expectedCsvRowsForCase(caseDef, version, { contract, projections });
  const { diffs } = compareCsvOutput(stdout, expectedRows, lineEnding, contract);
  return diffs.length === 0
    ? makeCheck(checkId, 'PASS', 'CSV 输出与期望一致', details)
    : fail(checkId, 'CSV 输出与期望不一致', { ...details, diffs });
}

function compareJsonOutput(actual, expected, contract) {
  if (!isPlainObject(actual)) return ['stdout JSON 不是对象'];
  const diffs = [];
  const actualKeys = Object.keys(actual).sort(codePointCompare);
  const expectedKeys = [...contract.jsonFields].sort(codePointCompare);
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    diffs.push(`字段集合不一致：期望 [${expectedKeys.join(', ')}]，实际 [${actualKeys.join(', ')}]`);
  }
  if (!Number.isSafeInteger(actual.totalCents) || actual.totalCents !== expected.totalCents) {
    diffs.push(`totalCents 期望 ${expected.totalCents}，实际 ${describeValue(actual.totalCents)}`);
  }
  diffs.push(...compareByCategory(actual.byCategory, expected.byCategory, contract));
  diffs.push(...compareIdList(actual.largePayments, expected.largePayments, 'largePayments'));
  diffs.push(...compareIdGroups(actual.duplicateGroups, expected.duplicateGroups, 'duplicateGroups'));
  return diffs;
}

function compareByCategory(actual, expected, contract) {
  if (!Array.isArray(actual)) return ['byCategory 不是数组'];
  const diffs = [];
  const expectedFields = [...contract.categoryFields].sort(codePointCompare);
  const entries = new Map();
  for (const item of actual) {
    if (!isPlainObject(item)) {
      diffs.push('byCategory 含非对象项');
      continue;
    }
    if (!isDeepStrictEqual(Object.keys(item).sort(codePointCompare), expectedFields)) {
      diffs.push(`byCategory 项字段不一致：[${Object.keys(item).join(', ')}]`);
      continue;
    }
    if (typeof item.category !== 'string') {
      diffs.push('byCategory.category 不是字符串');
      continue;
    }
    if (entries.has(item.category)) {
      diffs.push(`byCategory 重复类别 ${item.category}`);
      continue;
    }
    if (!Number.isSafeInteger(item.count) || item.count < 0) {
      diffs.push(`byCategory[${item.category}].count 不是非负整数`);
      continue;
    }
    if (!Number.isSafeInteger(item.totalCents) || item.totalCents < 0) {
      diffs.push(`byCategory[${item.category}].totalCents 不是非负整数`);
      continue;
    }
    entries.set(item.category, item);
  }
  const expectedMap = new Map(expected.map((item) => [item.category, item]));
  for (const [category, want] of expectedMap) {
    const got = entries.get(category);
    if (got === undefined) {
      diffs.push(`缺少类别 ${category}`);
      continue;
    }
    if (got.count !== want.count) diffs.push(`类别 ${category} count 期望 ${want.count}，实际 ${got.count}`);
    if (got.totalCents !== want.totalCents) diffs.push(`类别 ${category} totalCents 期望 ${want.totalCents}，实际 ${got.totalCents}`);
  }
  for (const category of entries.keys()) {
    if (!expectedMap.has(category)) diffs.push(`多出类别 ${category}`);
  }
  return diffs;
}

function compareIdList(actual, expected, field) {
  if (!Array.isArray(actual)) return [`${field} 不是数组`];
  if (!actual.every((value) => typeof value === 'string')) return [`${field} 含非字符串元素`];
  const got = [...actual].sort(codePointCompare);
  const want = [...expected].sort(codePointCompare);
  if (!isDeepStrictEqual(got, want)) {
    return [`${field} 不一致：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`];
  }
  return [];
}

function compareIdGroups(actual, expected, field) {
  if (!Array.isArray(actual)) return [`${field} 不是数组`];
  for (const group of actual) {
    if (!Array.isArray(group) || !group.every((value) => typeof value === 'string')) {
      return [`${field} 含非字符串数组`];
    }
  }
  const canonical = (groups) => groups
    .map((group) => [...group].sort(codePointCompare))
    .sort(compareStringArrays);
  const got = canonical(actual);
  const want = canonical(expected);
  if (!isDeepStrictEqual(got, want)) {
    return [`${field} 不一致：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`];
  }
  return [];
}

function compareCsvOutput(stdout, expectedTable, lineEnding, contract) {
  let parsed;
  try {
    parsed = parseCsv(stdout);
  } catch (error) {
    return { diffs: [`CSV 语法非法：${errorMessage(error)}`] };
  }
  const diffs = [];
  const expectedTerminator = contract.lineEndings[lineEnding];
  const wrongTerminator = parsed.terminators.find((terminator) => terminator !== expectedTerminator);
  if (wrongTerminator !== undefined) {
    diffs.push(`行尾不匹配：--line-ending ${lineEnding} 期望 ${JSON.stringify(expectedTerminator)}，实际 ${JSON.stringify(wrongTerminator)}`);
  }
  const expectedHeader = expectedTable[0] ?? contract.csvColumns;
  const header = parsed.rows[0];
  if (header === undefined) {
    diffs.push('CSV 缺少表头');
    return { diffs };
  }
  if (!isDeepStrictEqual(header, expectedHeader)) {
    diffs.push(`表头期望 [${expectedHeader.join(', ')}]，实际 [${header.join(', ')}]`);
  }
  const actualRows = parsed.rows.slice(1);
  const expectedRows = expectedTable.slice(1);
  if (actualRows.length !== expectedRows.length) {
    diffs.push(`数据行数期望 ${expectedRows.length}，实际 ${actualRows.length}`);
  }
  const pairs = Math.min(actualRows.length, expectedRows.length);
  for (let index = 0; index < pairs; index += 1) {
    const actual = actualRows[index];
    const expected = expectedRows[index];
    if (actual.length !== expected.length) {
      diffs.push(`第 ${index + 1} 行列数期望 ${expected.length}，实际 ${actual.length}`);
      continue;
    }
    for (let column = 0; column < expected.length; column += 1) {
      if (actual[column] !== expected[column]) {
        diffs.push(`第 ${index + 1} 行第 ${column + 1} 列期望 ${JSON.stringify(expected[column])}，实际 ${JSON.stringify(actual[column])}`);
        break;
      }
    }
  }
  return { diffs: capDiffs(diffs) };
}

function preflight(repositoryPath, entry) {
  if (!isDirectory(repositoryPath)) {
    return {
      blocked: makeCheck('preflight:repository', 'BLOCKED', `invalidIO：仓库目录不存在或不可读：${repositoryPath}`),
      checks: [],
      before: null,
    };
  }
  const entryPath = resolve(repositoryPath, entry);
  if (!isFileInside(repositoryPath, entryPath)) {
    return {
      blocked: makeCheck('preflight:entry', 'BLOCKED', `missingCLI：入口文件不存在或位于被测仓库之外：${entry}`),
      checks: [],
      before: null,
    };
  }
  const git = inspectGit(repositoryPath);
  if (git.kind !== 'repository') {
    const reason = git.kind === 'unavailable' ? `git 不可用（${git.message}）` : '目标不是 Git 工作树';
    return {
      blocked: makeCheck('preflight:git', 'BLOCKED', `invalidIO：${reason}`),
      checks: [],
      before: null,
    };
  }
  if (realpathSync(git.toplevel) !== realpathSync(repositoryPath)) {
    return {
      blocked: makeCheck('preflight:git', 'BLOCKED', `invalidIO：目标必须是独立仓库根（当前 toplevel：${git.toplevel}）`),
      checks: [],
      before: null,
    };
  }
  const beforeMissing = missingGitFacts(git.snapshot);
  if (beforeMissing.length > 0) {
    return {
      blocked: makeCheck('preflight:git', 'BLOCKED', `invalidIO：无法读取 Git 事实（${beforeMissing.join('、')}），无法证明被测项目未被改动`, { git: gitFactsView(git.snapshot) }),
      checks: [],
      before: null,
    };
  }
  if (isInsideRoot(repositoryPath, tmpdir())) {
    return {
      blocked: makeCheck('preflight:temp', 'BLOCKED', `invalidIO：系统临时目录位于被测仓库内（${tmpdir()}），拒绝写入被测项目`),
      checks: [],
      before: null,
    };
  }
  return {
    blocked: null,
    before: git.snapshot,
    checks: [
      makeCheck('preflight:repository', 'PASS', '仓库目录可用'),
      makeCheck('preflight:entry', 'PASS', `入口存在且位于仓库内：${entry}`),
      makeCheck('preflight:git', 'PASS', '目标为独立 Git 工作树'),
      makeCheck('preflight:temp', 'PASS', '系统临时目录位于被测仓库之外'),
    ],
  };
}

function inspectGit(repositoryPath) {
  const inside = gitRun(repositoryPath, ['rev-parse', '--is-inside-work-tree']);
  if (inside.kind === 'error') return { kind: 'unavailable', message: inside.reason };
  if (inside.kind !== 'ok' || inside.value.trim() !== 'true') return { kind: 'not-a-repository' };
  const toplevel = gitRun(repositoryPath, ['rev-parse', '--show-toplevel']);
  if (toplevel.kind !== 'ok') return { kind: 'unavailable', message: toplevel.reason };
  return { kind: 'repository', toplevel: toplevel.value.trim(), snapshot: snapshotGit(repositoryPath) };
}

/** 只读 Git 事实：HEAD、index（ls-files --stage）与 status；每个事实都带可用性。 */
function snapshotGit(cwd) {
  return {
    head: captureHead(cwd),
    index: captureFact(cwd, ['ls-files', '--stage']),
    status: captureFact(cwd, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all']),
  };
}

function captureHead(cwd) {
  const result = gitRun(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (result.kind === 'ok') return { kind: 'value', value: result.value.trim() };
  if (result.kind === 'exit' && result.status === 1 && result.value.trim() === '') return { kind: 'unborn' };
  return { kind: 'unavailable', reason: result.reason };
}

function captureFact(cwd, args) {
  const result = gitRun(cwd, args);
  return result.kind === 'ok' ? { kind: 'value', value: result.value } : { kind: 'unavailable', reason: result.reason };
}

/** 所有 Git 读取都走这里：固定 10s 超时与 64KiB 上限，绝不写 Git 对象或索引。 */
function gitRun(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  if (result.error !== undefined && result.error !== null) return { kind: 'error', reason: errorMessage(result.error) };
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (typeof result.status !== 'number') return { kind: 'error', reason: 'git 未返回退出状态' };
  if (result.status === 0) return { kind: 'ok', value: stdout };
  return { kind: 'exit', status: result.status, value: stdout, reason: `git ${args.join(' ')} 退出码 ${result.status}` };
}

function gitUnchangedCheck(before, after) {
  const beforeMissing = missingGitFacts(before);
  if (beforeMissing.length > 0) {
    return makeCheck('git:unchanged', 'BLOCKED', `invalidIO：运行前无法读取 Git 事实（${beforeMissing.join('、')}）`, { before: describeGitFacts(before) });
  }
  const afterMissing = missingGitFacts(after);
  if (afterMissing.length > 0) {
    return makeCheck('git:unchanged', 'INCONCLUSIVE', `运行后无法读取 Git 事实（${afterMissing.join('、')}），无法证明被测项目未被改动`, { after: describeGitFacts(after) });
  }
  const changed = ['head', 'index', 'status'].filter((key) => !isDeepStrictEqual(before[key], after[key]));
  if (changed.length === 0) {
    return makeCheck('git:unchanged', 'PASS', '运行前后 Git 事实（HEAD/index/status）未变化');
  }
  return makeCheck('git:unchanged', 'FAIL', `运行改动了被测项目：${changed.join('、')}`, {
    changed,
    before: describeGitFacts(before),
    after: describeGitFacts(after),
  });
}

function missingGitFacts(snapshot) {
  return ['head', 'index', 'status'].filter((key) => snapshot[key]?.kind === 'unavailable');
}

function describeGitFacts(snapshot) {
  const describe = (fact) => {
    if (fact === undefined) return 'missing';
    return fact.kind === 'value' ? clampText(fact.value) : fact.kind;
  };
  return { head: describe(snapshot.head), index: describe(snapshot.index), status: describe(snapshot.status) };
}

function finalizeReport(header, checks, git) {
  return {
    ...header,
    completedAt: new Date().toISOString(),
    status: overallStatus(checks),
    checks,
    summary: summarize(checks),
    git: git ?? null,
  };
}

/** 报告明示的只读 Git 事实；复用已读结果，不产生新的 Git 查询。head 全量，index/status 有界。 */
function gitFactsView(snapshot) {
  const view = (fact, limit) => {
    if (fact === undefined || fact.kind !== 'value') return null;
    return typeof limit === 'number' ? clampTo(fact.value, limit) : fact.value;
  };
  return {
    head: view(snapshot.head),
    index: view(snapshot.index, MAX_GIT_FACT_TEXT),
    status: view(snapshot.status, MAX_GIT_FACT_TEXT),
  };
}

/** 与 common.overall 一致：确定的 FAIL 优先于 BLOCKED 与 INCONCLUSIVE。 */
function overallStatus(checks) {
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.length === 0 || checks.some((check) => check.status !== 'PASS')) return 'INCONCLUSIVE';
  return 'PASS';
}

function summarize(checks) {
  const summary = { total: checks.length, passed: 0, failed: 0, blocked: 0, inconclusive: 0, notCovered: 0 };
  for (const check of checks) {
    if (check.status === 'PASS') summary.passed += 1;
    else if (check.status === 'FAIL') summary.failed += 1;
    else if (check.status === 'BLOCKED') summary.blocked += 1;
    else if (check.status === 'INCONCLUSIVE') summary.inconclusive += 1;
    else summary.notCovered += 1;
  }
  return summary;
}

function buildArgvKinds(caseDef, format, contract) {
  const invoke = isPlainObject(caseDef.invoke) ? caseDef.invoke : {};
  const omitted = omittedFlags(caseDef);
  return {
    format: omitted.includes('--format') ? `${contract.defaults.format}(默认)` : (invoke.formatToken ?? format),
    thresholdCents: omitted.includes('--threshold-cents')
      ? `${contract.limits.defaultThresholdCents}(默认)`
      : (invoke.thresholdToken ?? String(caseDef.thresholdCents ?? contract.limits.defaultThresholdCents)),
    lineEnding: omitted.includes('--line-ending') ? `${contract.defaults.lineEnding}(默认)` : (caseDef.lineEnding ?? 'call'),
    extraArgs: Array.isArray(invoke.extraArgs) ? invoke.extraArgs : [],
    missingInput: invoke.missingInput === true,
  };
}

function omittedFlags(caseDef) {
  return Array.isArray(caseDef.invoke?.omitFlags) ? caseDef.invoke.omitFlags : [];
}

function validateContract(contract) {
  const invalid = (message) => {
    throw new Error(`ledger-lab contract.json 非法：${message}`);
  };
  if (!isPlainObject(contract) || contract.schemaVersion !== 1) invalid('需要 schemaVersion 1');
  if (!isNonEmptyString(contract.entry)) invalid('缺少 entry');
  for (const key of ['versions', 'formats', 'jsonFields', 'categoryFields', 'csvColumns']) {
    if (!Array.isArray(contract[key]) || contract[key].length === 0 || !contract[key].every((value) => isNonEmptyString(value))) {
      invalid(`${key} 必须是非空字符串数组`);
    }
  }
  if (!contract.formats.includes('json') || !contract.formats.includes('csv')) invalid('formats 必须包含 json 与 csv');
  if (!isPlainObject(contract.lineEndings)
    || !isNonEmptyText(contract.lineEndings['lf'])
    || !isNonEmptyText(contract.lineEndings['crlf'])) {
    invalid('lineEndings 必须定义 lf 与 crlf');
  }
  if (!isPlainObject(contract.defaults)
    || !contract.formats.includes(contract.defaults.format)
    || !Object.hasOwn(contract.lineEndings, contract.defaults.lineEnding)) {
    invalid('defaults 必须是合同内的默认 format 与 lineEnding');
  }
  const projections = contract.projections;
  if (!isPlainObject(projections)
    || !Array.isArray(projections.aliasVersions)
    || !Array.isArray(projections.redactMerchantVersions)
    || !isPlainObject(projections.csvOrder)) {
    invalid('projections 形状非法');
  }
  for (const key of ['aliasVersions', 'redactMerchantVersions']) {
    if (!projections[key].every((version) => contract.versions.includes(version))) invalid(`projections.${key} 含未知 version`);
  }
  for (const version of contract.versions) {
    if (!KNOWN_CSV_ORDERS.includes(projections.csvOrder[version])) invalid(`projections.csvOrder 缺少或未知 ${version}`);
  }
  const limits = contract.limits;
  if (!isPlainObject(limits)) invalid('缺少 limits');
  for (const key of ['records', 'amountCents', 'thresholdCents', 'defaultThresholdCents']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) invalid(`limits.${key} 必须是非负安全整数`);
  }
  if (limits.defaultThresholdCents > limits.thresholdCents) invalid('默认阈值不得超过阈值上限');
  if (!isPlainObject(contract.aliases) || !Object.values(contract.aliases).every((value) => typeof value === 'string')) {
    invalid('aliases 必须是字符串映射');
  }
  if (!isNonEmptyString(contract.redactedMerchant)) invalid('缺少 redactedMerchant');
  if (!isPlainObject(contract.errorCodes)) invalid('缺少 errorCodes');
  for (const kind of ['arguments', 'read', 'json', 'ledger']) {
    if (!isNonEmptyString(contract.errorCodes[kind])) invalid(`errorCodes.${kind} 缺失`);
  }
  const semantics = contract.outputSemantics;
  if (!isPlainObject(semantics)
    || semantics.successExitCode !== 0
    || semantics.errorExitCode !== 2
    || semantics.stringOrder !== 'UTF-16-code-unit'
    || semantics.csvFinalNewline !== 'optional'
    || semantics.csvCategory !== 'raw'
    || semantics.jsonArrayComparison !== 'unordered; category names must be unique') {
    invalid('outputSemantics 与验收器实现的语义不一致');
  }
  return contract;
}

function validateCaseSet(dataset, contract) {
  if (!isPlainObject(dataset) || dataset.schemaVersion !== 1 || !Array.isArray(dataset.cases)) {
    throw new Error('ledger-lab cases.json 不是受支持的 schemaVersion 1');
  }
  if (dataset.projections !== undefined) {
    throw new Error('cases.json 不得自带 projections；投影规则只属于 contract.json');
  }
  const seen = new Set();
  for (const caseDef of dataset.cases) {
    if (!isPlainObject(caseDef) || !isNonEmptyString(caseDef.id)) throw new Error('case 缺少 id');
    if (seen.has(caseDef.id)) throw new Error(`case id 重复：${caseDef.id}`);
    seen.add(caseDef.id);
    if (!Array.isArray(caseDef.versions) || caseDef.versions.length === 0
      || !caseDef.versions.every((version) => contract.versions.includes(version))) {
      throw new Error(`case ${caseDef.id} 的 versions 非法`);
    }
    if (!Array.isArray(caseDef.formats) || caseDef.formats.length === 0
      || !caseDef.formats.every((format) => contract.formats.includes(format))) {
      throw new Error(`case ${caseDef.id} 的 formats 非法`);
    }
    if (caseDef.thresholdCents !== undefined
      && (!Number.isSafeInteger(caseDef.thresholdCents)
        || caseDef.thresholdCents < 0
        || caseDef.thresholdCents > contract.limits.thresholdCents)) {
      throw new Error(`case ${caseDef.id} 的 thresholdCents 超出 0..${contract.limits.thresholdCents}`);
    }
    if (caseDef.lineEnding !== undefined && !Object.hasOwn(contract.lineEndings, caseDef.lineEnding)) {
      throw new Error(`case ${caseDef.id} 的 lineEnding 非法`);
    }
    if (caseDef.invoke !== undefined && !isPlainObject(caseDef.invoke)) throw new Error(`case ${caseDef.id} 的 invoke 非法`);
    const invoke = isPlainObject(caseDef.invoke) ? caseDef.invoke : {};
    if (invoke.omitFlags !== undefined
      && (!Array.isArray(invoke.omitFlags) || !invoke.omitFlags.every((flag) => KNOWN_FLAGS.includes(flag)))) {
      throw new Error(`case ${caseDef.id} 的 omitFlags 非法`);
    }
    if (invoke.extraArgs !== undefined
      && (!Array.isArray(invoke.extraArgs) || !invoke.extraArgs.every((arg) => typeof arg === 'string'))) {
      throw new Error(`case ${caseDef.id} 的 extraArgs 非法`);
    }
    const omitted = Array.isArray(invoke.omitFlags) ? invoke.omitFlags : [];
    if (omitted.includes('--format')) {
      if (isNonEmptyString(invoke.formatToken)) throw new Error(`case ${caseDef.id} 不能同时省略并指定 --format`);
      if (!isDeepStrictEqual(caseDef.formats, [contract.defaults.format])) {
        throw new Error(`case ${caseDef.id} 省略 --format 时 formats 必须等于默认格式 [${contract.defaults.format}]`);
      }
    }
    if (omitted.includes('--threshold-cents')) {
      if (isNonEmptyString(invoke.thresholdToken)) throw new Error(`case ${caseDef.id} 不能同时省略并指定 --threshold-cents`);
      if (caseDef.thresholdCents !== undefined && caseDef.thresholdCents !== contract.limits.defaultThresholdCents) {
        throw new Error(`case ${caseDef.id} 省略 --threshold-cents 时不得另行声明阈值`);
      }
    }
    if (omitted.includes('--line-ending')
      && caseDef.lineEnding !== undefined
      && caseDef.lineEnding !== contract.defaults.lineEnding) {
      throw new Error(`case ${caseDef.id} 省略 --line-ending 时 lineEnding 必须等于默认值 ${contract.defaults.lineEnding}`);
    }
    if (caseDef.expectExit !== undefined) {
      throw new Error(`case ${caseDef.id} 不得声明 expectExit；退出码来自 contract.outputSemantics`);
    }
    if (caseDef.expectErrorKind !== undefined) {
      if (!isNonEmptyString(caseDef.expectErrorKind) || !Object.hasOwn(contract.errorCodes, caseDef.expectErrorKind)) {
        throw new Error(`case ${caseDef.id} 的 expectErrorKind 未在 contract.json 中定义`);
      }
      continue;
    }
    if (!Array.isArray(caseDef.input)) throw new Error(`case ${caseDef.id} 缺少 input 记录`);
    validateRecords(caseDef.input, contract, caseDef.id);
    if (caseDef.formats.includes('json')) {
      if (caseDef.expectedJson !== undefined) validateExpectedJson(caseDef.expectedJson, contract, caseDef.id);
      if (caseDef.expectedJsonByVersion !== undefined) {
        if (!isPlainObject(caseDef.expectedJsonByVersion)) throw new Error(`case ${caseDef.id} 的 expectedJsonByVersion 非法`);
        for (const version of caseDef.versions) {
          const override = caseDef.expectedJsonByVersion[version];
          if (!isPlainObject(override)) throw new Error(`case ${caseDef.id} 的 expectedJsonByVersion 缺少 ${version}`);
          validateExpectedJson(override, contract, `${caseDef.id}@${version}`);
        }
      }
      if (caseDef.expectedJson === undefined && caseDef.expectedJsonByVersion === undefined) {
        throw new Error(`case ${caseDef.id} 缺少 expectedJson 或 expectedJsonByVersion`);
      }
    }
  }
}

function validateExpectedJson(json, contract, label) {
  if (!isDeepStrictEqual(Object.keys(json).sort(codePointCompare), [...contract.jsonFields].sort(codePointCompare))) {
    throw new Error(`case ${label} 的期望 JSON 字段与 contract.jsonFields 不一致`);
  }
  if (!Number.isSafeInteger(json.totalCents) || json.totalCents < 0) throw new Error(`case ${label} 的 totalCents 非法`);
  if (!Array.isArray(json.byCategory)) throw new Error(`case ${label} 的 byCategory 非法`);
  const expectedFields = [...contract.categoryFields].sort(codePointCompare);
  for (const item of json.byCategory) {
    if (!isPlainObject(item) || !isDeepStrictEqual(Object.keys(item).sort(codePointCompare), expectedFields)) {
      throw new Error(`case ${label} 的 byCategory 项字段非法`);
    }
    if (!isNonEmptyString(item.category)
      || !Number.isSafeInteger(item.count)
      || item.count < 0
      || !Number.isSafeInteger(item.totalCents)
      || item.totalCents < 0) {
      throw new Error(`case ${label} 的 byCategory 项取值非法`);
    }
  }
  if (!Array.isArray(json.largePayments) || !json.largePayments.every((value) => typeof value === 'string')) {
    throw new Error(`case ${label} 的 largePayments 非法`);
  }
  if (!Array.isArray(json.duplicateGroups)
    || !json.duplicateGroups.every((group) => Array.isArray(group) && group.every((value) => typeof value === 'string'))) {
    throw new Error(`case ${label} 的 duplicateGroups 非法`);
  }
}

function validateRecords(records, contract, caseId) {
  if (records.length > contract.limits.records) throw new Error(`case ${caseId} 的有效输入超过 records 上限`);
  const ids = new Set();
  for (const record of records) {
    if (!isPlainObject(record)) throw new Error(`case ${caseId} 的输入含非对象记录`);
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.category) || !isNonEmptyString(record.merchant)) {
      throw new Error(`case ${caseId} 的记录字段必须是非空字符串`);
    }
    if (ids.has(record.id)) throw new Error(`case ${caseId} 的输入 id 重复：${JSON.stringify(record.id)}`);
    ids.add(record.id);
    if (!Number.isSafeInteger(record.amountCents)
      || record.amountCents < 0
      || record.amountCents > contract.limits.amountCents) {
      throw new Error(`case ${caseId} 的 amountCents 超出 0..${contract.limits.amountCents}`);
    }
  }
}

function findErrorCode(stderr) {
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  if (text === '') return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return searchCode(payload, 0);
}

function searchCode(value, depth) {
  if (depth > 6 || !isPlainObject(value)) return null;
  if (typeof value.code === 'string') return value.code;
  for (const nested of Object.values(value)) {
    if (isPlainObject(nested)) {
      const found = searchCode(nested, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function encodeCsvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function capDiffs(diffs) {
  if (diffs.length <= MAX_DETAIL_ITEMS) return diffs;
  return [...diffs.slice(0, MAX_DETAIL_ITEMS), `…其余 ${diffs.length - MAX_DETAIL_ITEMS} 项差异已省略`];
}

function clampText(text) {
  return clampTo(text, MAX_DETAIL_TEXT);
}

function clampTo(text, limit) {
  return typeof text === 'string' && text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function makeCheck(id, status, message, details) {
  const check = { id, status, message };
  if (details !== undefined) check.details = details;
  return check;
}

function fail(id, message, details) {
  return makeCheck(id, 'FAIL', message, details);
}

function requireString(value, name) {
  if (!isNonEmptyString(value)) throw new TypeError(`${name} 必须是非空字符串`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 行尾等字面量允许空白字符，只要求是非空字符串。 */
function isNonEmptyText(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isInsideRoot(rootPath, targetPath) {
  try {
    const root = realpathSync(rootPath);
    const target = realpathSync(targetPath);
    return target === root || target.startsWith(root + sep);
  } catch {
    return false;
  }
}

function isFileInside(rootPath, targetPath) {
  try {
    return statSync(realpathSync(targetPath)).isFile() && isInsideRoot(rootPath, targetPath);
  } catch {
    return false;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function codePointCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareStringArrays(left, right) {
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const compared = codePointCompare(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function describeValue(value) {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultContract() {
  if (cachedContract === null) cachedContract = loadContract();
  return cachedContract;
}
