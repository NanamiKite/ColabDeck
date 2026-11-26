// Launches a desktop VS Code with an isolated user-data directory, loads ColabDeck from
// packages/extension in development mode next to the installed official extensions, and
// runs packages/extension/smoke/index.js inside the real extension host.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 180_000;
const SHUTDOWN_GRACE_MS = 5_000;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(root, 'packages/extension');
const sessionDir = mkdtempSync(path.join(tmpdir(), 'colabdeck-smoke-'));
const resultPath = path.join(sessionDir, 'result.json');
const workspaceDir = path.join(sessionDir, 'workspace');
mkdirSync(workspaceDir);

const args = [
  '--new-window',
  '--disable-gpu',
  '--disable-updates',
  '--disable-workspace-trust',
  '--skip-release-notes',
  '--skip-welcome',
  // Avoids a keyring unlock prompt from the throwaway profile on Linux.
  '--password-store=basic',
  `--user-data-dir=${path.join(sessionDir, 'user-data')}`,
  `--extensionDevelopmentPath=${extensionDir}`,
  `--extensionTestsPath=${path.join(extensionDir, 'smoke')}`,
  workspaceDir,
];

console.log(`[smoke] launching VS Code: ${process.env.VSCODE_CLI ?? 'code'} ${args.join(' ')}`);
const child = spawn(process.env.VSCODE_CLI ?? 'code', args, {
  env: { ...process.env, COLABDECK_SMOKE_RESULT: resultPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
child.on('error', (error) => {
  output += `\n${error.message}`;
});

const outcome = await waitForResult();
if (outcome) {
  for (const item of outcome.checks ?? []) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
  }
  if (outcome.fatal) {
    console.error(outcome.fatal);
  }
  const failed = (outcome.checks ?? []).filter((item) => !item.ok).length;
  console.log(`[smoke] ${(outcome.checks ?? []).length - failed}/${outcome.checks?.length ?? 0} checks passed`);
  process.exitCode = outcome.ok ? 0 : 1;
} else {
  console.error(`[smoke] no result within ${TIMEOUT_MS / 1000}s.`);
  process.exitCode = 1;
}

if (child.exitCode === null) {
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(SHUTDOWN_GRACE_MS)]);
  if (child.exitCode === null) {
    child.kill();
  }
}
await sleep(SHUTDOWN_GRACE_MS);
if (process.exitCode !== 0) {
  console.error(`[smoke] VS Code output (last 60 lines):\n${tail(output, 60)}`);
}
rmSync(sessionDir, { recursive: true, force: true });

/**
 * @returns {Promise<{ ok: boolean, fatal?: string, checks?: { name: string, ok: boolean, detail?: string }[] } | null>}
 */
async function waitForResult() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch {
      // Not written yet, or still being written.
    }
    await sleep(500);
  }
  return null;
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
function tail(text, lines) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
