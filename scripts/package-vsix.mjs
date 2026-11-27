// Builds the extension and packages it into release/<name>-<version>.vsix with @vscode/vsce.
// Usage: npm run package:vsix [-- --pre-release] [-- --out <path>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(root, 'packages', 'extension');
const releaseDir = path.join(root, 'release');

function fail(message) {
  console.error(`[package-vsix] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { preRelease: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pre-release') {
      options.preRelease = true;
    } else if (arg === '--out') {
      options.out = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (options.out !== null && options.out.length === 0) {
    fail('--out needs a path.');
  }
  return options;
}

const npmCli =
  typeof process.env.npm_execpath === 'string' && path.basename(process.env.npm_execpath) === 'npm-cli.js'
    ? process.env.npm_execpath
    : null;

function run(command, args, cwd, shell = false) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runNpm(args, cwd) {
  if (npmCli) {
    run(process.execPath, [npmCli, ...args], cwd);
    return;
  }
  run('npm', args, cwd, process.platform === 'win32');
}

const options = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
const lockfilePath = path.join(root, 'package-lock.json');
const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
const lockedExtensionVersion = lockfile.packages?.['packages/extension']?.version;

// Fail before the build, not after it.
for (const key of ['name', 'version', 'publisher']) {
  if (typeof manifest[key] !== 'string' || manifest[key].length === 0) {
    fail(`packages/extension/package.json is missing "${key}".`);
  }
}
if (lockedExtensionVersion !== manifest.version) {
  fail(
    `packages/extension version ${manifest.version} does not match package-lock.json (${String(lockedExtensionVersion)}); run npm install --package-lock-only.`,
  );
}
if (!manifest.repository) {
  console.warn('[package-vsix] warning: no "repository" in package.json; the Marketplace listing will not link to the source.');
}
for (const file of ['README.md', 'LICENSE.txt', manifest.icon]) {
  if (!existsSync(path.join(extensionDir, file))) {
    fail(`missing packages/extension/${file}.`);
  }
}

console.log('[package-vsix] building');
runNpm(['run', 'build'], root);

const probe = path.join(extensionDir, 'resources', 'probe', 'colabdeck_probe.py');
if (!existsSync(probe)) {
  fail('packages/extension/resources/probe/colabdeck_probe.py was not synced by the build.');
}
const notebookProbe = path.join(extensionDir, 'resources', 'probe', 'colabdeck_notebook.py');
if (!existsSync(notebookProbe)) {
  fail('packages/extension/resources/probe/colabdeck_notebook.py was not synced by the build.');
}

mkdirSync(releaseDir, { recursive: true });
const out = options.out ?? path.join(releaseDir, `${manifest.name}-${manifest.version}.vsix`);

const vsceArgs = ['package', '--no-dependencies', '--no-yarn', '--out', out];
if (options.preRelease) {
  vsceArgs.push('--pre-release');
}
runNpm(['exec', '--yes', '--package=@vscode/vsce', '--', 'vsce', ...vsceArgs], extensionDir);

const sizeMb = (statSync(out).size / 1024 / 1024).toFixed(2);
console.log(`[package-vsix] wrote ${path.relative(root, out)} (${sizeMb} MB)`);
console.log(`[package-vsix] install locally: code --install-extension ${path.relative(root, out)}`);
console.log('[package-vsix] publish: npm run publish:vsix (credentials: docs/development.md)');
