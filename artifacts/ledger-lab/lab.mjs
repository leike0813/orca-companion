import process from 'node:process';
import { mkdir, open, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { assertExternal, readJson, writeNewJson, contract } from './common.mjs';
import { verifyProcess, readEvidence } from './process-verifier.mjs';
import { combineReports, writeReport } from './report.mjs';

const help = `ledger-lab（在本仓库调用；待测项目为独立仓库）
  collect --repo PATH --scope ID --out DIR [--watch] [--interval-ms 2000] [--max-samples 1800]
  verify-result --repo PATH --version initial|revised|privacy --out FILE [--entry src/cli.mjs] [--line-ending lf|crlf]
  verify-process --evidence FILE --mapping FILE --observations FILE --profile main|cancel --out FILE
  report --process FILE --observations FILE --out NEW_DIR [--result FILE]（main 必需）
退出码：0 通过/采集完成，1 断言失败，2 参数或文件错误，3 未覆盖/阻塞/证据不足。`;
const definitions = {
  collect: { required: ['repo', 'scope', 'out'], optional: ['watch', 'interval-ms', 'max-samples'] },
  'verify-result': { required: ['repo', 'version', 'out'], optional: ['entry', 'line-ending'] },
  'verify-process': { required: ['evidence', 'mapping', 'observations', 'profile', 'out'], optional: [] },
  report: { required: ['process', 'observations', 'out'], optional: ['result'] },
};
export function parseArguments(argv) {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) return { command: 'help', options: {} };
  const [command, ...args] = argv;
  const definition = definitions[command];
  if (!definition) throw new Error('未知命令');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) throw new Error('参数必须使用 --name value');
    const name = token.slice(2);
    if (![...definition.required, ...definition.optional].includes(name) || Object.hasOwn(options, name)) throw new Error('未知或重复参数');
    if (name === 'watch') options[name] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('参数缺少值');
      options[name] = value;
    }
  }
  if (definition.required.some((name) => !options[name])) throw new Error('缺少必需参数');
  return { command, options };
}
function boundedInteger(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`数值参数须在 ${min}–${max} 之间`);
  return Number(value);
}
const exitCode = (status) => status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 3;
async function repository(path) {
  const root = await realpath(path);
  const companion = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  if (root === companion) throw new Error('实测必须使用独立仓库');
  return root;
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === 'help') { process.stdout.write(`${help}\n`); return 0; }
  if (command === 'collect') {
    const root = await repository(options.repo);
    const directory = await assertExternal(options.out, root);
    const interval = boundedInteger(options['interval-ms'], 2000, 200, 60000);
    const max = boundedInteger(options['max-samples'], 1800, 1, 10000);
    const { collectSample } = await import('./collector.mjs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(join(directory, 'evidence.jsonl'), 'wx', 0o600);
    const controller = new globalThis.AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const collectorId = randomUUID();
    let samples = 0; let usable = 0;
    try {
      while (!controller.signal.aborted && samples < max) {
        const sample = await collectSample({ repositoryPath: root, coordinationScopeId: options.scope });
        sample.collectorId = collectorId;
        await file.write(`${JSON.stringify(sample)}\n`);
        await file.sync();
        samples++;
        if (sample.sources.store.status === 'available' && sample.sources.store.consistent) usable++;
        if (!options.watch) break;
        try { await setTimeout(interval, undefined, { signal: controller.signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
      }
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop); await file.close();
    }
    process.stdout.write(`${JSON.stringify({ kind: 'capture-summary', samples, consistentStoreSamples: usable, path: join(directory, 'evidence.jsonl') })}\n`);
    return usable ? 0 : 3;
  }
  if (command === 'verify-result') {
    const root = await repository(options.repo);
    const output = await assertExternal(options.out, root);
    if (!contract.versions.includes(options.version) || !['lf', 'crlf'].includes(options['line-ending'] ?? 'lf')) throw new Error('版本或行尾无效');
    const { verifyResult } = await import('./result-verifier.mjs');
    const report = await verifyResult({ repositoryPath: root, version: options.version, entry: options.entry ?? contract.entry, lineEnding: options['line-ending'] ?? 'lf' });
    await writeNewJson(output, report);
    process.stdout.write(`${JSON.stringify({ status: report.status, summary: report.summary, path: output })}\n`);
    return exitCode(report.status);
  }
  if (command === 'verify-process') {
    const samples = await readEvidence(options.evidence);
    const mapping = await readJson(options.mapping);
    const observations = await readJson(options.observations);
    const report = verifyProcess({ samples, mapping, observations, profile: options.profile });
    if (!report.repositoryPath) throw new Error('空日志无法确定待测仓库身份');
    const output = await assertExternal(options.out, report.repositoryPath);
    await writeNewJson(output, report);
    process.stdout.write(`${JSON.stringify({ status: report.status, coverage: report.coverage, path: output })}\n`);
    return exitCode(report.status);
  }
  const processReport = await readJson(options.process);
  const resultReport = options.result ? await readJson(options.result) : null;
  const observations = await readJson(options.observations);
  const report = combineReports({ processReport, resultReport, observations });
  await writeReport(options.out, report);
  process.stdout.write(`${JSON.stringify({ status: report.status, path: resolve(options.out) })}\n`);
  return exitCode(report.status);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`${JSON.stringify({ code: 'LAB_INPUT_OR_IO_ERROR', message: error.message })}\n`); process.exitCode = 2; }
}
