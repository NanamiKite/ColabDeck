import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(root, 'src/extension.ts')],
  bundle: true,
  outfile: path.join(root, 'dist/extension.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
