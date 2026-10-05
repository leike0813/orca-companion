/**
 * ledger-lab 业务输出验收器（`artifacts/ledger-lab/result-verifier.mjs`）的行为测试。
 *
 * 这里只验证验收程序自身：期望输出来自 `cases.json`（数据）与 `contract.json`（唯一规则源），
 * `run` seam 用来注入确定性的 CLI 结果，不实现也不镜像被测账单逻辑。真实临时 Git 项目用于覆盖真实
 * 子进程入口、错误退出码、只读 Git 事实、符号链接与临时目录边界。
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CASES_PATH = join(REPOSITORY_ROOT, 'artifacts', 'ledger-lab', 'cases.json');
const VERIFIER_PATH = join(REPOSITORY_ROOT, 'artifacts', 'ledger-lab', 'result-verifier.mjs');

type CheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'INCONCLUSIVE';

type Check = {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

type GitFacts = { readonly head: string | null; readonly index: string | null; readonly status: string | null };

type ResultReport = {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly version: string;
  readonly entry?: string;
  readonly lineEnding?: string;
  readonly repositoryPath: string;
  readonly observedAt: string;
  readonly completedAt?: string;
  readonly status: CheckStatus;
  readonly checks: readonly Check[];
  readonly summary: {
    readonly total: number;
    readonly passed?: number;
    readonly failed?: number;
    readonly blocked?: number;
    readonly inconclusive?: number;
    readonly notCovered?: number;
  };
  readonly git?: { readonly before: GitFacts | null; readonly after: GitFacts | null } | null;
};

type LedgerRecord = {
  readonly id: string;
  readonly category: string;
  readonly merchant: string;
  readonly amountCents: number;
};

type CaseInvoke = {
  readonly rawInput?: string;
  readonly missingInput?: boolean;
  readonly thresholdToken?: string;
  readonly formatToken?: string;
  readonly omitFlags?: readonly string[];
  readonly extraArgs?: readonly string[];
};

type CaseDef = {
  readonly id: string;
  readonly title: string;
  readonly versions: readonly string[];
  readonly formats: readonly string[];
  readonly lineEnding?: string;
  readonly thresholdCents?: number;
  readonly input?: readonly LedgerRecord[];
  readonly expectedJson?: Readonly<Record<string, unknown>>;
  readonly expectedJsonByVersion?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly invoke?: CaseInvoke;
  readonly expectErrorKind?: string;
};

type Projections = {
  readonly aliasVersions: readonly string[];
  readonly redactMerchantVersions: readonly string[];
  readonly csvOrder: Readonly<Record<string, string>>;
};

type Contract = {
  readonly schemaVersion: number;
  readonly entry: string;
  readonly versions: readonly string[];
  readonly formats: readonly string[];
  readonly lineEndings: Readonly<Record<string, string>>;
  readonly defaults: { readonly format: string; readonly lineEnding: string };
  readonly projections: Projections;
  readonly jsonFields: readonly string[];
  readonly categoryFields: readonly string[];
  readonly csvColumns: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly redactedMerchant: string;
  readonly limits: {
    readonly records: number;
    readonly amountCents: number;
    readonly thresholdCents: number;
    readonly defaultThresholdCents: number;
  };
  readonly outputSemantics: {
    readonly successExitCode: number;
    readonly errorExitCode: number;
    readonly stringOrder: string;
    readonly csvFinalNewline: string;
    readonly csvCategory: string;
    readonly jsonArrayComparison: string;
  };
  readonly errorCodes: Readonly<Record<string, string>>;
};

type CaseSet = { readonly schemaVersion: number; readonly projections: Projections; readonly cases: readonly CaseDef[] };

type RunRequest = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
};

type RunOutcome = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code: string; readonly message?: string };
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
};

type RunSeam = (request: RunRequest) => Promise<RunOutcome>;

type VerifyCaseParams = {
  readonly caseDef: CaseDef;
  readonly version: string;
  readonly format: string;
  readonly lineEnding: string;
  readonly repositoryPath: string;
  readonly entry: string;
  readonly run: RunSeam;
  readonly contract: Contract;
  readonly projections: Projections;
};

type InvocationParams = {
  readonly caseDef: CaseDef;
  readonly format: string;
  readonly entry: string;
  readonly inputPath: string;
  readonly lineEnding: string;
  readonly contract: Contract;
};

type VerifierModule = {
  readonly verifyResult: (options: {
    readonly repositoryPath: string;
    readonly version?: string;
    readonly entry?: string;
    readonly lineEnding?: string;
    readonly run?: RunSeam;
  }) => Promise<ResultReport>;
  readonly verifyCase: (params: VerifyCaseParams) => Promise<Check>;
  readonly loadContract: () => Contract;
  readonly loadCaseSet: (contract?: Contract) => CaseSet;
  readonly projectExpectedJson: (caseDef: CaseDef, version: string, context: { contract: Contract; projections: Projections }) => Readonly<Record<string, unknown>>;
  readonly expectedJsonForCase: (caseDef: CaseDef, version: string, context: { contract: Contract; projections: Projections }) => Readonly<Record<string, unknown>>;
  readonly expectedCsvRowsForCase: (caseDef: CaseDef, version: string, context: { contract: Contract; projections: Projections }) => string[][];
  readonly buildInvocationArgs: (params: InvocationParams) => string[];
  readonly encodeCsv: (rows: readonly (readonly string[])[], lineEnding?: string) => string;
  readonly parseCsv: (text: string) => { readonly rows: string[][]; readonly terminators: string[] };
  readonly defaultRun: (request: RunRequest) => Promise<RunOutcome>;
};

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(directory);
  return directory;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const directory = tempRoots.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

let cachedVerifier: VerifierModule | undefined;

async function loadVerifier(): Promise<VerifierModule> {
  if (cachedVerifier === undefined) {
    cachedVerifier = (await import(pathToFileURL(VERIFIER_PATH).href)) as VerifierModule;
  }
  return cachedVerifier;
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

const GIT_ENV: Readonly<Record<string, string>> = {
  ...inheritedEnv(),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Verifier',
  GIT_AUTHOR_EMAIL: 'verifier@example.invalid',
  GIT_COMMITTER_NAME: 'Verifier',
  GIT_COMMITTER_EMAIL: 'verifier@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

function makeGitProject(entrySource: string | null, entry = 'src/cli.mjs'): string {
  const repository = makeTempDir('ledger-lab-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repository, env: GIT_ENV });
  if (entrySource !== null) {
    const entryPath = join(repository, entry);
    mkdirSync(dirname(entryPath), { recursive: true });
    writeFileSync(entryPath, entrySource, 'utf8');
  }
  git(repository, 'add', '-A');
  git(repository, 'commit', '-q', '--allow-empty', '-m', 'fixture');
  return repository;
}

/** 数据表直读：cases.json 不得自带 projections，消费方必须合并 contract.projections。 */
function readCaseSet(contract: Contract): CaseSet {
  const raw = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { schemaVersion: number; projections?: unknown; cases: readonly CaseDef[] };
  return { schemaVersion: raw.schemaVersion, cases: raw.cases, projections: contract.projections };
}

function findCheck(report: ResultReport, id: string): Check | undefined {
  return report.checks.find((check) => check.id === id);
}

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function perfectOutcome(
  verifier: VerifierModule,
  caseDef: CaseDef,
  format: string,
  request: RunRequest,
  version: string,
  contract: Contract,
  projections: Projections,
): RunOutcome {
  if (caseDef.expectErrorKind !== undefined) {
    return {
      exitCode: contract.outputSemantics.errorExitCode,
      stdout: '',
      stderr: JSON.stringify({ code: contract.errorCodes[caseDef.expectErrorKind] ?? 'UNKNOWN', message: 'fixture' }),
    };
  }
  if (format === 'json') {
    return { exitCode: contract.outputSemantics.successExitCode, stdout: JSON.stringify(verifier.expectedJsonForCase(caseDef, version, { contract, projections })), stderr: '' };
  }
  const lineEnding = readArg(request.args, '--line-ending') ?? contract.defaults.lineEnding;
  const rows = verifier.expectedCsvRowsForCase(caseDef, version, { contract, projections });
  return { exitCode: contract.outputSemantics.successExitCode, stdout: verifier.encodeCsv(rows, lineEnding), stderr: '' };
}

function makePerfectRun(verifier: VerifierModule, contract: Contract, dataset: CaseSet, version: string, lineEnding: string): RunSeam {
  const index = new Map<string, { caseDef: CaseDef; format: string }>();
  for (const caseDef of dataset.cases) {
    if (!caseDef.versions.includes(version)) continue;
    for (const format of caseDef.formats) {
      const content = typeof caseDef.invoke?.rawInput === 'string'
        ? caseDef.invoke.rawInput
        : caseDef.invoke?.missingInput === true
          ? '<missing>'
          : JSON.stringify(caseDef.input ?? []);
      const tail = verifier.buildInvocationArgs({ caseDef, format, entry: 'src/cli.mjs', inputPath: 'INPUT', lineEnding, contract }).slice(2);
      index.set(JSON.stringify([content, tail]), { caseDef, format });
    }
  }
  return (request) => {
    const inputPath = request.args[1] ?? '';
    const exists = existsSync(inputPath);
    const content = exists ? readFileSync(inputPath, 'utf8') : '<missing>';
    const hit = index.get(JSON.stringify([content, request.args.slice(2)]));
    if (hit === undefined) return Promise.reject(new Error('未登记的输入：' + JSON.stringify([content, request.args.slice(2)])));
    return Promise.resolve(perfectOutcome(verifier, hit.caseDef, hit.format, request, version, contract, dataset.projections));
  };
}

async function checkSingle(
  caseId: string,
  mutate: (outcome: RunOutcome, request: RunRequest) => RunOutcome,
  options: { version?: string; lineEnding?: string; format?: string } = {},
): Promise<Check> {
  const verifier = await loadVerifier();
  const contract = verifier.loadContract();
  const dataset = verifier.loadCaseSet(contract);
  const caseDef = dataset.cases.find((candidate) => candidate.id === caseId);
  if (caseDef === undefined) throw new Error('cases.json 缺少用例 ' + caseId);
  const format = options.format ?? caseDef.formats[0];
  if (format === undefined) throw new Error('用例 ' + caseId + ' 没有格式');
  const version = options.version ?? 'initial';
  const run: RunSeam = (request) => Promise.resolve(mutate(perfectOutcome(verifier, caseDef, format, request, version, contract, dataset.projections), request));
  return verifier.verifyCase({
    caseDef,
    version,
    format,
    lineEnding: options.lineEnding ?? 'lf',
    repositoryPath: process.cwd(),
    entry: 'src/cli.mjs',
    run,
    contract,
    projections: dataset.projections,
  });
}

const EMPTY_FIXTURE = [
  'const argv = process.argv.slice(2);',
  "const formatIndex = argv.indexOf('--format');",
  "const format = formatIndex >= 0 ? argv[formatIndex + 1] : 'json';",
  "const endIndex = argv.indexOf('--line-ending');",
  "const ending = endIndex >= 0 && argv[endIndex + 1] === 'crlf' ? '\\r\\n' : '\\n';",
  "if (format === 'json') {",
  "  process.stdout.write(JSON.stringify({ totalCents: 0, byCategory: [], largePayments: [], duplicateGroups: [] }));",
  "} else if (format === 'csv') {",
  "  process.stdout.write('id,category,merchant,amountCents' + ending);",
  '} else {',
  "  process.stderr.write(JSON.stringify({ code: 'INVALID_ARGUMENT', message: 'format' }));",
  '  process.exit(2);',
  '}',
].join('\n');

const ERROR_FIXTURE = [
  "process.stderr.write(JSON.stringify({ code: 'INVALID_LEDGER', message: 'invalid ledger' }));",
  'process.exit(2);',
].join('\n');

const MUTATING_FIXTURE = [
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync('mutated.txt', 'x');",
  "process.stdout.write(JSON.stringify({ totalCents: 0, byCategory: [], largePayments: [], duplicateGroups: [] }));",
].join('\n');

describe('cases.json 与 contract.json 的规则归属', () => {
  test('自校验通过，投影来自合同，数据表不带 projections', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const raw = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { projections?: unknown; cases: readonly CaseDef[] };

    expect(raw.projections).toBeUndefined();
    expect(dataset.projections).toBe(contract.projections);
    expect(readCaseSet(contract)).toEqual(dataset);

    const ids = dataset.cases.map((caseDef) => caseDef.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of [
      'empty', 'standard', 'threshold-equal', 'threshold-zero', 'duplicate-groups', 'unicode',
      'alias-collision', 'control-chars', 'csv-quotes', 'csv-crlf', 'limits-100',
      'default-threshold', 'default-line-ending', 'default-format',
      'invalid-json-parse', 'invalid-records-101', 'invalid-arg-format',
      'invalid-arg-missing-value', 'invalid-arg-duplicate', 'invalid-arg-unknown', 'missing-input',
    ]) {
      expect(ids).toContain(required);
    }
    for (const caseDef of dataset.cases) {
      expect(caseDef.versions.length).toBeGreaterThan(0);
      expect(caseDef.formats.length).toBeGreaterThan(0);
    }
  });

  test('有效输入不超过合同上限，期望 JSON 字段与合同一致', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);

    for (const caseDef of dataset.cases) {
      if (caseDef.expectErrorKind !== undefined || caseDef.input === undefined) continue;
      expect(caseDef.input.length).toBeLessThanOrEqual(contract.limits.records);
      for (const record of caseDef.input) {
        expect(Number.isSafeInteger(record.amountCents)).toBe(true);
        expect(record.amountCents).toBeGreaterThanOrEqual(0);
        expect(record.amountCents).toBeLessThanOrEqual(contract.limits.amountCents);
      }
      const expectations = [caseDef.expectedJson, ...Object.values(caseDef.expectedJsonByVersion ?? {})];
      for (const expected of expectations) {
        if (expected === undefined) continue;
        expect(Object.keys(expected).sort()).toEqual([...contract.jsonFields].sort());
        for (const item of expected['byCategory'] as readonly Record<string, unknown>[]) {
          expect(Object.keys(item).sort()).toEqual([...contract.categoryFields].sort());
        }
      }
    }
  });

  test('记录数边界与合同阈值上限', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    expect(dataset.cases.find((caseDef) => caseDef.id === 'limits-100')?.input?.length).toBe(100);
    expect(dataset.cases.find((caseDef) => caseDef.id === 'invalid-records-101')?.input?.length).toBe(101);
    expect(contract.limits.thresholdCents).toBe(1000000);
    expect(contract.defaults).toEqual({ format: 'json', lineEnding: 'lf' });
  });
});

describe('期望投影', () => {
  test('别名只作用于统计，CSV 保留类别原值', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const standard = dataset.cases.find((caseDef) => caseDef.id === 'standard');
    if (standard === undefined) throw new Error('缺少 standard');
    const context = { contract, projections: dataset.projections };

    const initial = verifier.expectedJsonForCase(standard, 'initial', context) as { byCategory: readonly { category: string }[] };
    const revised = verifier.expectedJsonForCase(standard, 'revised', context) as { byCategory: readonly { category: string }[] };
    expect(initial.byCategory.map((item) => item.category)).toContain('餐饮');
    expect(revised.byCategory.map((item) => item.category)).toEqual(expect.arrayContaining(['food', 'travel']));

    const revisedRows = verifier.expectedCsvRowsForCase(standard, 'revised', context);
    expect(revisedRows[0]).toEqual([...contract.csvColumns]);
    expect(revisedRows.slice(1).map((row) => row[0])).toEqual(['a1', 'd4', 'c3', 'b2', 'e5']);
    expect(revisedRows.some((row) => row[1] === '餐饮')).toBe(true);
    const privacyRows = verifier.expectedCsvRowsForCase(standard, 'privacy', context);
    expect(privacyRows.slice(1).every((row) => row[2] === contract.redactedMerchant)).toBe(true);
  });

  test('别名碰撞用显式 golden，且与投影合并结果一致', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const collision = dataset.cases.find((caseDef) => caseDef.id === 'alias-collision');
    if (collision === undefined) throw new Error('缺少 alias-collision');
    const context = { contract, projections: dataset.projections };

    expect(collision.expectedJsonByVersion?.['revised']).toBeDefined();
    expect(collision.expectedJsonByVersion?.['privacy']).toBeDefined();
    const revised = verifier.expectedJsonForCase(collision, 'revised', context) as { byCategory: readonly { category: string; count: number; totalCents: number }[] };
    const byName = new Map(revised.byCategory.map((item) => [item.category, item]));
    expect(byName.get('food')).toEqual({ category: 'food', count: 2, totalCents: 7000 });
    expect(byName.get('travel')).toEqual({ category: 'travel', count: 2, totalCents: 4000 });
    expect(verifier.projectExpectedJson(collision, 'revised', context)).toEqual(revised);
    expect(verifier.projectExpectedJson(collision, 'privacy', context)).toEqual(verifier.expectedJsonForCase(collision, 'privacy', context));
  });

  test('空账单与含 NUL 的用例是明确字面量', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const context = { contract, projections: dataset.projections };

    const empty = dataset.cases.find((caseDef) => caseDef.id === 'empty');
    if (empty === undefined) throw new Error('缺少 empty');
    expect(verifier.expectedJsonForCase(empty, 'initial', context)).toEqual({
      totalCents: 0, byCategory: [], largePayments: [], duplicateGroups: [],
    });
    expect(verifier.expectedCsvRowsForCase(empty, 'initial', context)).toEqual([[...contract.csvColumns]]);

    const control = dataset.cases.find((caseDef) => caseDef.id === 'control-chars');
    if (control === undefined) throw new Error('缺少 control-chars');
    const json = verifier.expectedJsonForCase(control, 'initial', context) as { largePayments: readonly string[]; duplicateGroups: readonly (readonly string[])[] };
    expect(json.largePayments).toEqual(['x\u0000y']);
    expect(json.duplicateGroups).toEqual([['d\u0000a', 'd\u0000b']]);
  });
});

describe('CSV 解析', () => {
  test('引号、逗号与内嵌换行按 RFC 4180 解析并可往返', async () => {
    const verifier = await loadVerifier();
    const rows = [
      ['id', 'category', 'merchant', 'amountCents'],
      ['q1', 'a', 'Acme, Inc.', '3000'],
      ['q2', 'a', 'Bob "The Boss"', '10000'],
      ['q3', 'b', 'Line1\nLine2', '7000'],
    ];
    const parsed = verifier.parseCsv(verifier.encodeCsv(rows, 'lf'));
    expect(parsed.rows).toEqual(rows);
    expect(parsed.terminators.every((terminator) => terminator === '\n')).toBe(true);
  });

  test('CRLF 行尾被识别为结构行尾', async () => {
    const verifier = await loadVerifier();
    const parsed = verifier.parseCsv(verifier.encodeCsv([['a', 'b'], ['1', '2']], 'crlf'));
    expect(parsed.rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(parsed.terminators).toEqual(['\r\n', '\r\n']);
  });

  test.each<[string, string]>([
    ['孤立回车', 'a,b\rc'],
    ['引号未闭合', '"a,b'],
    ['未加引号字段中出现引号', 'a"b,c'],
    ['结束引号后出现字符', '"a"x,b'],
  ])('拒绝非法 CSV：%s', async (_name, text) => {
    const verifier = await loadVerifier();
    expect(() => verifier.parseCsv(text)).toThrow();
  });
});

describe('verifyResult 聚合', () => {
  test.each(['initial', 'revised', 'privacy'])('完美实现使 %s 版本全部通过，并明示 Git 事实', async (version) => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject('// fixture entry');

    const report = await verifier.verifyResult({
      repositoryPath: repository,
      version,
      run: makePerfectRun(verifier, contract, dataset, version, 'lf'),
    });

    expect(report.kind).toBe('result-report');
    expect(report.version).toBe(version);
    expect(Number.isFinite(Date.parse(report.observedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(report.completedAt ?? ''))).toBe(true);
    expect(report.checks.filter((check) => check.status !== 'PASS')).toEqual([]);
    expect(report.status).toBe('PASS');
    expect(report.summary.total).toBe(report.checks.length);
    expect(report.summary.failed).toBe(0);
    expect(report.git?.before?.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(report.git?.before?.head).toBe(report.git?.after?.head);
    expect(findCheck(report, 'git:unchanged')?.status).toBe('PASS');
  });

  test('CRLF 参数使行尾检查按 CRLF 判定', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject('// fixture entry');
    const report = await verifier.verifyResult({
      repositoryPath: repository,
      version: 'initial',
      lineEnding: 'crlf',
      run: makePerfectRun(verifier, contract, dataset, 'initial', 'crlf'),
    });
    expect(report.status).toBe('PASS');
    expect(findCheck(report, 'case:standard:csv')?.status).toBe('PASS');
  });

  test('确定的 FAIL 优先于 BLOCKED 与 INCONCLUSIVE', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject('// fixture entry');
    const perfect = makePerfectRun(verifier, contract, dataset, 'initial', 'lf');
    const mixed: RunSeam = async (request) => {
      if (basename(request.args[1] ?? '') === 'standard.json') {
        return { exitCode: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'missing' } };
      }
      const outcome = await perfect(request);
      if (basename(request.args[1] ?? '') === 'empty.json') {
        const payload = JSON.parse(outcome.stdout) as Record<string, unknown>;
        payload['totalCents'] = 999;
        return { ...outcome, stdout: JSON.stringify(payload) };
      }
      return outcome;
    };
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial', run: mixed });
    expect(findCheck(report, 'case:empty:json')?.status).toBe('FAIL');
    expect(report.checks.some((check) => check.status === 'BLOCKED')).toBe(true);
    expect(report.status).toBe('FAIL');
  });

  test('运行后 Git 事实不可读时 git:unchanged 记 INCONCLUSIVE', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject('// fixture entry');
    const perfect = makePerfectRun(verifier, contract, dataset, 'initial', 'lf');
    let destroyed = false;
    const destroying: RunSeam = async (request) => {
      const outcome = await perfect(request);
      if (!destroyed) {
        destroyed = true;
        rmSync(repository, { recursive: true, force: true });
      }
      return outcome;
    };
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial', run: destroying });
    expect(findCheck(report, 'git:unchanged')?.status).toBe('INCONCLUSIVE');
    expect(report.status).toBe('INCONCLUSIVE');
  });

  test('argv 形状：真实省略 flag，追加重复/未知/悬空 flag', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject('// fixture entry');
    const perfect = makePerfectRun(verifier, contract, dataset, 'initial', 'lf');
    const seen = new Map<string, readonly string[]>();
    const capturing: RunSeam = async (request) => {
      seen.set(basename(request.args[1] ?? '').replace(/\.json$/u, ''), request.args);
      return await perfect(request);
    };
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial', run: capturing });
    expect(report.status).toBe('PASS');
    const tail = (id: string): readonly string[] => seen.get(id)?.slice(2) ?? [];
    expect(tail('default-threshold')).toEqual(['--format', 'json', '--line-ending', 'lf']);
    expect(tail('default-line-ending')).toEqual(['--format', 'csv', '--threshold-cents', '5000']);
    expect(tail('default-format')).toEqual(['--threshold-cents', '5000', '--line-ending', 'lf']);
    expect(tail('csv-crlf')).toEqual(['--format', 'csv', '--threshold-cents', '5000', '--line-ending', 'crlf']);
    expect(tail('invalid-arg-threshold-text')).toEqual(['--format', 'json', '--threshold-cents', 'abc', '--line-ending', 'lf']);
    expect(tail('invalid-arg-missing-value')).toEqual(['--threshold-cents', '5000', '--line-ending', 'lf', '--format']);
    expect(tail('invalid-arg-duplicate')).toEqual(['--format', 'json', '--threshold-cents', '5000', '--line-ending', 'lf', '--format', 'csv']);
    expect(tail('invalid-arg-unknown')).toEqual(['--format', 'json', '--threshold-cents', '5000', '--line-ending', 'lf', '--unknown']);
  });

  test('输入文件位于仓库外的系统临时目录并在结束后清理', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject('// fixture entry');
    const perfect = makePerfectRun(verifier, contract, dataset, 'initial', 'lf');
    const seen: string[] = [];
    const capturing: RunSeam = async (request) => {
      seen.push(request.args[1] ?? '');
      expect(request.executable).toBe(process.execPath);
      expect(request.cwd).toBe(repository);
      expect(request.timeoutMs).toBe(10_000);
      expect(request.maxBytes).toBe(65_536);
      return await perfect(request);
    };
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial', run: capturing });
    expect(report.status).toBe('PASS');
    expect(seen.length).toBeGreaterThan(0);
    const repositoryReal = realpathSync(repository);
    const temporaryRoot = realpathSync(tmpdir());
    for (const inputPath of seen) {
      expect(isAbsolute(inputPath)).toBe(true);
      expect(inputPath.startsWith(repositoryReal + sep)).toBe(false);
      expect(inputPath.startsWith(temporaryRoot + sep)).toBe(true);
      expect(existsSync(inputPath)).toBe(false);
    }
  });

  test('拒绝非法参数', async () => {
    const verifier = await loadVerifier();
    await expect(verifier.verifyResult({ repositoryPath: '' })).rejects.toThrow(TypeError);
    await expect(verifier.verifyResult({ repositoryPath: process.cwd(), version: 'nope' })).rejects.toThrow(TypeError);
    await expect(verifier.verifyResult({ repositoryPath: process.cwd(), lineEnding: 'cr' })).rejects.toThrow(TypeError);
    await expect(verifier.verifyResult({ repositoryPath: process.cwd(), run: 5 as unknown as RunSeam })).rejects.toThrow(TypeError);
  });
});

describe('verifyResult 预检', () => {
  test('仓库目录不存在时 BLOCKED invalidIO 且 git 为 null', async () => {
    const verifier = await loadVerifier();
    const missing = join(tmpdir(), 'ledger-lab-missing-' + String(Date.now()) + '-' + String(Math.random()));
    const report = await verifier.verifyResult({ repositoryPath: missing });
    expect(report.status).toBe('BLOCKED');
    expect(report.checks[0]?.id).toBe('preflight:repository');
    expect(report.checks[0]?.message).toContain('invalidIO');
    expect(report.git).toBeNull();
  });

  test('入口缺失时 BLOCKED missingCLI', async () => {
    const verifier = await loadVerifier();
    const repository = makeGitProject(null);
    const report = await verifier.verifyResult({ repositoryPath: repository });
    expect(report.status).toBe('BLOCKED');
    expect(report.checks[0]?.id).toBe('preflight:entry');
    expect(report.checks[0]?.message).toContain('missingCLI');
    expect(report.git).toBeNull();
  });

  test('入口符号链接指向被测仓库之外时 BLOCKED', async () => {
    const verifier = await loadVerifier();
    const repository = makeGitProject(null);
    const outside = makeTempDir('ledger-lab-outside-');
    const target = join(outside, 'cli.mjs');
    writeFileSync(target, '// outside', 'utf8');
    const link = join(repository, 'src', 'link.mjs');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    const report = await verifier.verifyResult({ repositoryPath: repository, entry: 'src/link.mjs' });
    expect(report.status).toBe('BLOCKED');
    expect(report.checks[0]?.id).toBe('preflight:entry');
  });

  test('非 Git 目录 BLOCKED invalidIO', async () => {
    const verifier = await loadVerifier();
    const directory = makeTempDir('ledger-lab-plain-');
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', 'cli.mjs'), '// fixture', 'utf8');
    const report = await verifier.verifyResult({ repositoryPath: directory });
    expect(report.status).toBe('BLOCKED');
    expect(report.checks[0]?.id).toBe('preflight:git');
    expect(report.checks[0]?.message).toContain('invalidIO');
  });

  test('仓库子目录不是独立仓库根，BLOCKED', async () => {
    const verifier = await loadVerifier();
    const repository = makeGitProject(null);
    const subdirectory = join(repository, 'nested');
    mkdirSync(join(subdirectory, 'src'), { recursive: true });
    writeFileSync(join(subdirectory, 'src', 'cli.mjs'), '// fixture', 'utf8');
    const report = await verifier.verifyResult({ repositoryPath: subdirectory });
    expect(report.status).toBe('BLOCKED');
    expect(report.checks[0]?.id).toBe('preflight:git');
  });

  test('TMPDIR 落在被测仓库内时 BLOCKED，且不写入该仓库', async () => {
    const repository = makeGitProject('// fixture entry');
    const inner = join(repository, 'tmp');
    mkdirSync(inner, { recursive: true });
    const before = git(repository, 'status', '--porcelain', '--untracked-files=all');
    const previous = process.env['TMPDIR'];
    process.env['TMPDIR'] = inner;
    try {
      const verifier = await loadVerifier();
      const report = await verifier.verifyResult({ repositoryPath: repository });
      expect(report.status).toBe('BLOCKED');
      expect(report.checks[0]?.id).toBe('preflight:temp');
      expect(report.git).toBeNull();
      expect(readdirSync(inner)).toEqual([]);
      expect(git(repository, 'status', '--porcelain', '--untracked-files=all')).toBe(before);
    } finally {
      if (previous === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previous;
    }
  });
});

describe('真实子进程路径', () => {
  test('固定入口真实运行：对应检查 PASS，其余 FAIL', async () => {
    const verifier = await loadVerifier();
    const repository = makeGitProject(EMPTY_FIXTURE);
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial' });
    expect(findCheck(report, 'case:empty:json')?.status).toBe('PASS');
    expect(findCheck(report, 'case:empty:csv')?.status).toBe('PASS');
    expect(findCheck(report, 'case:standard:json')?.status).toBe('FAIL');
    expect(findCheck(report, 'preflight:entry')?.status).toBe('PASS');
    expect(findCheck(report, 'git:unchanged')?.status).toBe('PASS');
    expect(report.status).toBe('FAIL');
  });

  test('真实错误退出码与错误码被核验', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const repository = makeGitProject(ERROR_FIXTURE);
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial' });
    for (const caseDef of dataset.cases) {
      if (caseDef.expectErrorKind !== 'ledger') continue;
      expect(findCheck(report, 'case:' + caseDef.id + ':json')?.status).toBe('PASS');
    }
    expect(findCheck(report, 'case:invalid-json-parse:json')?.status).toBe('FAIL');
    expect(findCheck(report, 'case:missing-input:json')?.status).toBe('FAIL');
  });

  test('运行改动项目时 git:unchanged FAIL', async () => {
    const verifier = await loadVerifier();
    const repository = makeGitProject(MUTATING_FIXTURE);
    const report = await verifier.verifyResult({ repositoryPath: repository, version: 'initial' });
    expect(findCheck(report, 'git:unchanged')?.status).toBe('FAIL');
    expect(report.status).toBe('FAIL');
  });
});

describe('JSON 语义比较', () => {
  test('字段顺序、类别顺序与 IDs 顺序不影响判定', async () => {
    const check = await checkSingle('standard', (outcome) => {
      const payload = JSON.parse(outcome.stdout) as Record<string, unknown>;
      const byCategory = payload['byCategory'] as unknown[];
      payload['byCategory'] = [...byCategory].reverse();
      return { ...outcome, stdout: JSON.stringify({ duplicateGroups: payload['duplicateGroups'], largePayments: payload['largePayments'], byCategory: payload['byCategory'], totalCents: payload['totalCents'] }) };
    });
    expect(check.status).toBe('PASS');
  });

  test.each<[string, string]>([
    ['缺少字段', '{"totalCents":0,"byCategory":[],"largePayments":[]}'],
    ['多余字段', '{"totalCents":0,"byCategory":[],"largePayments":[],"duplicateGroups":[],"extra":1}'],
  ])('字段集合不符判 FAIL：%s', async (_name, stdout) => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, stdout }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('字段集合');
  });

  test('totalCents 不符判 FAIL', async () => {
    const check = await checkSingle('standard', (outcome) => {
      const payload = JSON.parse(outcome.stdout) as Record<string, unknown>;
      payload['totalCents'] = 1;
      return { ...outcome, stdout: JSON.stringify(payload) };
    });
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('totalCents');
  });

  test('重复类别判 FAIL', async () => {
    const check = await checkSingle('standard', (outcome) => {
      const payload = JSON.parse(outcome.stdout) as { byCategory: unknown[] };
      payload.byCategory = [...payload.byCategory, payload.byCategory[0]];
      return { ...outcome, stdout: JSON.stringify(payload) };
    });
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('重复类别');
  });

  test('重复组内容不符判 FAIL', async () => {
    const check = await checkSingle('duplicate-groups', (outcome) => {
      const payload = JSON.parse(outcome.stdout) as Record<string, unknown>;
      payload['duplicateGroups'] = [['g1', 'g5']];
      return { ...outcome, stdout: JSON.stringify(payload) };
    });
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('duplicateGroups');
  });

  test('含 NUL 的 ID 不能被拼接误读为相等', async () => {
    const check = await checkSingle('control-chars', (outcome) => {
      const payload = JSON.parse(outcome.stdout) as Record<string, unknown>;
      payload['largePayments'] = ['x', 'y'];
      return { ...outcome, stdout: JSON.stringify(payload) };
    });
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('largePayments');
  });

  test('输出不是合法 JSON 判 FAIL', async () => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, stdout: 'not json' }));
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('不是合法 JSON');
  });
});

describe('CSV 输出比较', () => {
  test('未加引号的逗号字段判 FAIL', async () => {
    const check = await checkSingle('csv-quotes', (outcome) => ({ ...outcome, stdout: 'id,category,merchant,amountCents\nq1,a,Acme, Inc.,3000\n' }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('列数');
  });

  test('未加引号的引号字段判 FAIL', async () => {
    const check = await checkSingle('csv-quotes', (outcome) => ({ ...outcome, stdout: 'id,category,merchant,amountCents\nq2,a,Bob "The Boss",10000\n' }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('CSV 语法非法');
  });

  test('未加引号的内嵌换行判 FAIL', async () => {
    const check = await checkSingle('csv-quotes', (outcome) => ({ ...outcome, stdout: 'id,category,merchant,amountCents\nq3,b,Line1\nLine2,7000\n' }));
    expect(check.status).toBe('FAIL');
  });

  test('行序不符判 FAIL', async () => {
    const check = await checkSingle('standard', (outcome) => {
      const lines = outcome.stdout.trimEnd().split('\n');
      const header = lines[0] ?? '';
      return { ...outcome, stdout: [header, ...lines.slice(1).reverse()].join('\n') + '\n' };
    }, { version: 'revised', format: 'csv' });
    expect(check.status).toBe('FAIL');
  });

  test('CRLF 用例收到 LF 判 FAIL', async () => {
    const check = await checkSingle('csv-crlf', (outcome) => ({ ...outcome, stdout: outcome.stdout.replaceAll('\r\n', '\n') }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('行尾不匹配');
  });

  test('表头不符判 FAIL', async () => {
    const check = await checkSingle('csv-crlf', (outcome) => ({ ...outcome, stdout: outcome.stdout.replace('id,category,merchant,amountCents', 'id,category,amountCents') }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('表头');
  });
});

describe('运行结果不确定与不可用', () => {
  test('成功时写 stderr 判 FAIL', async () => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, stderr: 'warning\n' }));
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('stderr');
  });

  test('非零退出判 FAIL', async () => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, exitCode: 1 }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('退出码');
  });

  test('错误码不符判 FAIL', async () => {
    const check = await checkSingle('invalid-json-parse', (outcome) => ({ ...outcome, stderr: JSON.stringify({ code: 'INVALID_LEDGER' }) }));
    expect(check.status).toBe('FAIL');
    expect(findMessage(check)).toContain('错误码');
  });

  test('启动失败判 BLOCKED', async () => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, exitCode: null, error: { code: 'ENOENT', message: 'not found' } }));
    expect(check.status).toBe('BLOCKED');
    expect(check.message).toContain('missingCLI');
  });

  test('超时判 INCONCLUSIVE', async () => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, exitCode: null, error: { code: 'TIMEOUT', message: 'slow' } }));
    expect(check.status).toBe('INCONCLUSIVE');
  });

  test('输出被截断判 INCONCLUSIVE', async () => {
    const check = await checkSingle('empty', (outcome) => ({ ...outcome, stdoutTruncated: true }));
    expect(check.status).toBe('INCONCLUSIVE');
  });

  test('run seam 抛出异常判 INCONCLUSIVE 且不静默吞掉', async () => {
    const verifier = await loadVerifier();
    const contract = verifier.loadContract();
    const dataset = verifier.loadCaseSet(contract);
    const empty = dataset.cases.find((caseDef) => caseDef.id === 'empty');
    if (empty === undefined) throw new Error('缺少 empty');
    const check = await verifier.verifyCase({
      caseDef: empty,
      version: 'initial',
      format: 'json',
      lineEnding: 'lf',
      repositoryPath: process.cwd(),
      entry: 'src/cli.mjs',
      run: () => Promise.reject(new Error('seam exploded')),
      contract,
      projections: dataset.projections,
    });
    expect(check.status).toBe('INCONCLUSIVE');
    expect(check.message).toContain('seam exploded');
  });
});

describe('defaultRun', () => {
  test('超时后立刻返回 TIMEOUT，不等待子进程', async () => {
    const verifier = await loadVerifier();
    const started = Date.now();
    const outcome = await verifier.defaultRun({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: process.cwd(),
      timeoutMs: 400,
      maxBytes: 64 * 1024,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome.error?.code).toBe('TIMEOUT');
  });

  test('输出超过 maxBytes 时截断并标记', async () => {
    const verifier = await loadVerifier();
    const outcome = await verifier.defaultRun({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(100000))'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxBytes: 1024,
    });
    expect(outcome.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(1024);
  });

  test('可执行文件不存在时返回 ENOENT', async () => {
    const verifier = await loadVerifier();
    const outcome = await verifier.defaultRun({
      executable: join(tmpdir(), 'ledger-lab-no-such-binary'),
      args: [],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      maxBytes: 1024,
    });
    expect(outcome.error?.code).toBe('ENOENT');
  });
});

function findMessage(check: Check): string {
  const diffs = check.details?.['diffs'];
  const parts = [check.message];
  if (Array.isArray(diffs)) parts.push(diffs.join(' '));
  return parts.join(' ');
}
