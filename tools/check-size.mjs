import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import packageJson from '../package.json' with { type: 'json' };

const bunVersion = '1.4.4';
if (Bun.version !== bunVersion) {
  throw new Error(`Size measurement requires Bun ${bunVersion}; found ${Bun.version}.`);
}

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL(`../${packageJson.main}`, import.meta.url))],
  target: 'browser',
  format: 'esm',
  packages: 'external',
  minify: true,
  write: false,
});

if (!result.success) {
  throw new AggregateError(result.logs, 'Could not bundle the built package. Run bun run build first.');
}
if (result.outputs.length !== 1) {
  throw new Error(`Expected one JS bundle; received ${result.outputs.length} outputs.`);
}

const bytes = new Uint8Array(await result.outputs[0].arrayBuffer());
const gzipBytes = gzipSync(bytes).length;
const minifiedBudget = 15_000;
const gzipBudget = 5_000;

console.log(`${packageJson.name}@${packageJson.version} standalone JS (Bun ${Bun.version})`);
console.log(`Minified: ${bytes.length} bytes / ${minifiedBudget} budget`);
console.log(`Gzipped: ${gzipBytes} bytes / ${gzipBudget} budget`);
console.log('External dependencies, native code, and model assets excluded; not installed-app size.');

if (bytes.length > minifiedBudget || gzipBytes > gzipBudget) {
  throw new Error('JS size budget exceeded. Review the change and update the README measurement.');
}
