import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { overall, summarize, statuses, assertExternal } from './common.mjs';

export function combineReports({ processReport, resultReport, observations }) {
  if (processReport?.schemaVersion !== 1 || processReport.kind !== 'process-report' || !Array.isArray(processReport.checks)) throw new Error('过程报告 schema 无效');
  if (resultReport == null && processReport.profile !== 'cancel') throw new Error('主运行报告必须提供成品验收');
  if (resultReport != null && (resultReport.schemaVersion !== 1 || resultReport.kind !== 'result-report' || !Array.isArray(resultReport.checks))) throw new Error('成品报告 schema 无效');
  if (observations?.schemaVersion !== 1 || observations.coordinationScopeId !== processReport.coordinationScopeId || !Array.isArray(observations.entries)) throw new Error('观察记录 Scope 不匹配');
  if (!processReport.repositoryPath || (resultReport && processReport.repositoryPath !== resultReport.repositoryPath)) throw new Error('过程与成品报告属于不同仓库');
  const sameHead = resultReport && processReport.capture?.gitHead && processReport.capture.gitHead === resultReport.git?.before?.head?.trim() && processReport.capture.gitHead === resultReport.git?.after?.head?.trim();
  const correlation = resultReport ? { id: 'correlation', status: sameHead ? 'PASS' : 'INCONCLUSIVE', message: sameHead ? '最后过程样本与成品测试前后 HEAD 一致' : '过程与成品缺少相同 HEAD 证据，须复核实测时点' } : null;
  const checks = [{ id: 'process', status: processReport.status }, ...(resultReport ? [{ id: 'result', status: resultReport.status }, correlation] : [])];
  if (!checks.every((c) => statuses.includes(c.status)) || [...processReport.checks, ...(resultReport?.checks ?? [])].some((c) => !statuses.includes(c.status))) throw new Error('验收状态无效');
  return { schemaVersion: 1, kind: 'acceptance-report', status: overall(checks), repositoryPath: processReport.repositoryPath,
    coordinationScopeId: processReport.coordinationScopeId, profile: processReport.profile,
    resultVersion: resultReport?.version ?? null, process: processReport, result: resultReport ?? null,
    observations: observations.entries, assessments: observations.entries.filter((note) => note.kind === 'assessment'),
    correlation,
    summary: { process: summarize(processReport.checks), result: resultReport ? summarize(resultReport.checks) : null },
    limitations: ['合并报告继承原报告的采样和证据边界。', '一次主运行和一次 cancel 运行分别报告；不可混合 Scope。', '成品检查与过程观察必须针对同一次实测，由操作者核对时点与 HEAD。'] };
}
const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
export function markdownReport(report) {
  const rows = report.process.checks.map((c) => `| ${cell(c.id)} | ${c.status} | ${cell(c.message)} |`);
  const resultRows = (report.result?.checks ?? []).map((c) => `| ${cell(c.id)} | ${c.status} | ${cell(c.message)} |`);
  const notes = report.observations.map((n) => `- ${cell(n.at)} · ${cell(n.scenarioId)} · ${cell(n.kind)}${n.rating ? ` · ${n.rating}/5` : ''}: ${cell(n.text)}`);
  const correlation = report.correlation ? `\n\nHEAD 关联：${report.correlation.status}。${cell(report.correlation.message)}。` : '';
  const resultSection = report.result ? `| 检查 | 状态 | 结论 |\n| --- | --- | --- |\n${resultRows.join('\n')}` : '取消档案不要求成品交付。';
  return `# ledger-lab 验收报告\n\n整体状态：**${report.status}**。Scope：${cell(report.coordinationScopeId)}；档案：${cell(report.profile)}；成品版本：${cell(report.resultVersion)}。${correlation}\n\n## 过程\n\n| 场景 | 状态 | 证据结论 |\n| --- | --- | --- |\n${rows.join('\n')}\n\n## 成品\n\n${resultSection}\n\n## 人工观察\n\n${notes.join('\n') || '无人工观察。'}\n\n## 证据边界\n\n${[...report.limitations, ...report.process.limitations].map((line) => `- ${line}`).join('\n')}\n`;
}
export async function writeReport(directory, report) {
  const target = await assertExternal(directory, report.repositoryPath);
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: false, mode: 0o700 });
  await writeFile(join(target, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(target, 'report.md'), markdownReport(report), { flag: 'wx', mode: 0o600 });
}
