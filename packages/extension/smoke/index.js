// Real extension-host smoke test. `npm run test:smoke` starts a desktop VS Code with
// this directory as --extensionTestsPath, loading ColabDeck in development mode next
// to the installed official extensions. It covers activation and contribution
// registration only; the Colab runtime path is verified by hand with
// docs/mvp-validation.md.
'use strict';

const fs = require('node:fs');
const vscode = require('vscode');

const EXTENSION_ID = 'NanamiKite.colabdeck';
const DASHBOARD_FOCUS_COMMAND = 'colabdeck.dashboard.focus';
const OFFICIAL_DEPENDENCIES = ['google.colab', 'ms-toolsai.jupyter'];
const CONTRIBUTED_COMMANDS = [
  'colabdeck.openDashboard',
  'colabdeck.refresh',
  'colabdeck.stopMonitoring',
  'colabdeck.startMonitoring',
  'colabdeck.restartProbe',
  'colabdeck.openProbeLog',
  'colabdeck.showServerInfo',
  'colabdeck.idleGuard.cancel',
  'colabdeck.idleGuard.snooze',
  'colabdeck.idleGuard.releaseNow',
  'colabdeck.toolkit.killProcess',
  'colabdeck.toolkit.clearCudaCache',
  'colabdeck.toolkit.scanDisk',
];
// Commands that must not block on user input or touch a Colab server.
const SERVERLESS_COMMANDS = [
  'colabdeck.openDashboard',
  'colabdeck.refresh',
  'colabdeck.stopMonitoring',
  'colabdeck.startMonitoring',
  'colabdeck.restartProbe',
];

/**
 * @typedef {object} Check
 * @property {string} name
 * @property {boolean} ok
 * @property {string} [detail]
 */

/** @type {Check[]} */
const checks = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runChecks() {
  for (const id of OFFICIAL_DEPENDENCIES) {
    check(`official dependency installed: ${id}`, vscode.extensions.getExtension(id) !== undefined);
  }

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {
    throw new Error(`${EXTENSION_ID} was not discovered by the extension host.`);
  }
  check(`${EXTENSION_ID} discovered`, true, `v${extension.packageJSON.version}`);
  await extension.activate();
  check(`${EXTENSION_ID} activated`, extension.isActive);

  const commands = await vscode.commands.getCommands(true);
  check('dashboard view contributed', commands.includes(DASHBOARD_FOCUS_COMMAND));
  for (const id of CONTRIBUTED_COMMANDS) {
    check(`command registered: ${id}`, commands.includes(id));
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  const colabMounted = folders.some((folder) => folder.uri.scheme === 'colab');
  check('smoke workspace has no mounted Colab server', !colabMounted);
  if (colabMounted) {
    return;
  }
  for (const id of SERVERLESS_COMMANDS) {
    try {
      await vscode.commands.executeCommand(id);
      check(`command executes without a server: ${id}`, true);
    } catch (error) {
      check(`command executes without a server: ${id}`, false, describe(error));
    }
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports.run = async () => {
  let fatal;
  try {
    await runChecks();
  } catch (error) {
    fatal = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error('[ColabDeck smoke] fatal:', fatal);
  }
  const failed = checks.filter((item) => !item.ok).length;
  const ok = fatal === undefined && failed === 0;
  console.log(`[ColabDeck smoke] ${checks.length - failed}/${checks.length} checks passed`);

  // The extension host console is not attached to the launching terminal, so the
  // structured result travels through a file that scripts/smoke.mjs polls.
  const resultPath = process.env.COLABDECK_SMOKE_RESULT;
  if (resultPath) {
    fs.writeFileSync(resultPath, JSON.stringify({ ok, fatal, checks }), 'utf8');
  }
  if (!ok) {
    throw new Error(`[ColabDeck smoke] ${failed} check(s) failed${fatal ? ' after a fatal error' : ''}`);
  }
};
