import { antigravityReportingDefinition, installReportingTrampoline, maintainReporting, reportingInstalled } from '../dist/src/adapters/agents/worker-harness-reporting.js';
import { maintainKiloReporting, kiloReportingInstalled } from '../dist/src/adapters/agents/kilo-harness.js';
import { maintainKimiReporting, kimiReportingInstalled } from '../dist/src/adapters/agents/kimi-harness.js';
import { maintainHermesReporting, hermesReportingInstalled } from '../dist/src/adapters/agents/hermes-harness.js';
import { maintainClineReporting, clineReportingInstalled } from '../dist/src/adapters/agents/cline-harness.js';
import { maintainMuseReporting, museReportingInstalled } from '../dist/src/adapters/agents/muse-harness.js';
import { maintainCursorReporting, cursorReportingInstalled } from '../dist/src/adapters/agents/cursor-harness.js';

const reporting = {
  antigravity: { maintain: (action) => maintainReporting(antigravityReportingDefinition(), action), installed: () => reportingInstalled(antigravityReportingDefinition()) },
  kilo: { maintain: maintainKiloReporting, installed: kiloReportingInstalled },
  kimi: { maintain: maintainKimiReporting, installed: kimiReportingInstalled },
  hermes: { maintain: maintainHermesReporting, installed: hermesReportingInstalled },
  cline: { maintain: maintainClineReporting, installed: clineReportingInstalled },
  muse: { maintain: maintainMuseReporting, installed: museReportingInstalled },
  cursor: { maintain: maintainCursorReporting, installed: cursorReportingInstalled },
};

const [action, flag, harness, ...extra] = process.argv.slice(2);
if (!['install', 'status', 'uninstall'].includes(action) || flag !== '--harness' || !Object.hasOwn(reporting, harness) || extra.length) {
  process.stderr.write('Usage: node scripts/worker-harness-reporting.mjs install|status|uninstall --harness antigravity|kilo|kimi|hermes|cline|muse|cursor\n');
  process.exit(2);
}
try {
  if (action === 'install') installReportingTrampoline();
  if (action !== 'status') reporting[harness].maintain(action);
  process.stdout.write(JSON.stringify({ harness, installed: reporting[harness].installed() }) + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Reporter setup failed') + '\n');
  process.exitCode = 1;
}
import process from 'node:process';
