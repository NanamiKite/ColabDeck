// Publishes a VSIX to the VS Code Marketplace with @vscode/vsce.
// Usage: npm run publish:vsix [-- <path.vsix>] [--yes] [--azure-credential | --oidc]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(root, 'packages', 'extension');
const releaseDir = path.join(root, 'release');
const AUTH_FLAGS = ['--azure-credential', '--oidc'];

function fail(message) {
  console.error(`[publish-vsix] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { vsix: null, yes: false, auth: [] };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--pre-release') {
      fail('pre-release is decided when packaging: npm run package:vsix -- --pre-release');
    } else if (arg === '--pat' || arg === '-p') {
      fail('pass the token through the VSCE_PAT environment variable, not the command line');
    } else if (AUTH_FLAGS.includes(arg)) {
      if (options.auth.length > 0) {
        fail(`use only one of ${AUTH_FLAGS.join(', ')}.`);
      }
      options.auth.push(arg);
    } else if (arg.startsWith('-')) {
      fail(`unknown argument: ${arg}`);
    } else if (options.vsix) {
      fail(`unexpected argument: ${arg}`);
    } else {
      options.vsix = arg;
    }
  }
  return options;
}

function newestVsix(dir) {
  if (!existsSync(dir)) {
    return null;
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.vsix'))
    .map((name) => path.join(dir, name));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

async function confirm(question) {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await lines.question(question)).trim());
  } finally {
    lines.close();
  }
}

const options = parseArgs(process.argv.slice(2));
const vsix = options.vsix ? path.resolve(options.vsix) : newestVsix(releaseDir);
if (!vsix || !existsSync(vsix)) {
  fail(options.vsix ? `not found: ${options.vsix}` : 'no VSIX in release/; run npm run package:vsix first.');
}

const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
const id = `${manifest.publisher}.${manifest.name}`;
const expected = `${manifest.name}-${manifest.version}.vsix`;
const shownPath = path.relative(root, vsix);
if (path.basename(vsix) !== expected) {
  console.warn(`[publish-vsix] warning: ${path.basename(vsix)} does not match ${expected}; make sure it is the build you want to publish.`);
}
if (statSync(path.join(extensionDir, 'package.json')).mtimeMs > statSync(vsix).mtimeMs) {
  console.warn('[publish-vsix] warning: packages/extension/package.json changed after this VSIX was built; run npm run package:vsix again.');
}

if (options.auth.length === 0 && !process.env.VSCE_PAT) {
  console.warn(
    '[publish-vsix] no VSCE_PAT, --azure-credential, or --oidc; vsce will use the credential saved by "vsce login" or prompt for a PAT.',
  );
}

console.log(`[publish-vsix] ${id} ${manifest.version}`);
console.log(`[publish-vsix] ${shownPath.startsWith('..') ? vsix : shownPath}`);
console.log(`[publish-vsix] https://marketplace.visualstudio.com/items?itemName=${id}`);

if (!options.yes) {
  if (!process.stdin.isTTY) {
    fail('refusing to publish without confirmation; rerun with --yes in non-interactive contexts.');
  }
  if (!(await confirm('Publish to the Marketplace? [y/N] '))) {
    console.log('[publish-vsix] aborted');
    process.exit(1);
  }
}

const vsceArgs = ['exec', '--yes', '--package=@vscode/vsce', '--', 'vsce', 'publish', '--packagePath', vsix, ...options.auth];
const npmCli =
  typeof process.env.npm_execpath === 'string' && path.basename(process.env.npm_execpath) === 'npm-cli.js'
    ? process.env.npm_execpath
    : null;
const result = npmCli
  ? spawnSync(process.execPath, [npmCli, ...vsceArgs], { cwd: extensionDir, stdio: 'inherit' })
  : spawnSync('npm', vsceArgs, {
      cwd: extensionDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
if (result.error) {
  fail(result.error.message);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`[publish-vsix] verify with: code --install-extension ${id}`);
