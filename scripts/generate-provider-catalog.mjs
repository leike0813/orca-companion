import { readFile, writeFile } from 'node:fs/promises';
import { convertModelsDev } from '../src/application/configuration/provider-catalog-conversion.ts';

const source = globalThis.process.argv[2];
const target = new globalThis.URL('../src/adapters/agents/provider-catalog.json', import.meta.url);
const raw = JSON.parse(source ? await readFile(source, 'utf8') : await (await globalThis.fetch('https://models.dev/api.json', { signal: globalThis.AbortSignal.timeout(10000) })).text());
await writeFile(target, JSON.stringify(convertModelsDev(raw), null, 2) + '\n');
