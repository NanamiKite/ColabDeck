import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ProbeStatus, ServerDescriptor } from '@colabdeck/shared';
import type { Logger } from '../log.js';
import { TerminalProbeLauncher } from './launcher.js';
import type { ProbePaths } from './probePaths.js';

const mocks = vi.hoisted(() => ({
  terminals: [] as unknown[],
  workspaceFolders: [] as unknown[],
  readFile: vi.fn(),
  deleteFile: vi.fn(),
  delay: vi.fn(),
}));

vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));
vi.mock('vscode', () => ({
  ThemeIcon: class ThemeIcon {
    constructor(readonly id: string) {}
  },
  FileSystemError: class FileSystemError extends Error {},
  window: { terminals: mocks.terminals },
  workspace: {
    workspaceFolders: mocks.workspaceFolders,
    fs: { readFile: mocks.readFile, delete: mocks.deleteFile },
    getConfiguration: () => ({ get: () => true }),
  },
}));

const server: ServerDescriptor = {
  id: 'r-test',
  label: 'Colab GPU',
  source: 'mounted-folder',
  notebookUri: null,
  jupyterBaseUrl: null,
  kernelApiAvailable: false,
};

const paths = {
  dir: '/content/.colabdeck',
  status: { path: '/content/.colabdeck/status.json' },
} as ProbePaths;

function addTerminal(name: string, kind: 'local' | 'other-pty' | 'colab') {
  const sendText = vi.fn();
  const options = {
    name,
    iconPath: new vscode.ThemeIcon(kind === 'other-pty' ? 'terminal' : 'colab-logo'),
    ...(kind !== 'local' ? { pty: {} } : {}),
  };
  const terminal = { name, creationOptions: options, sendText };
  mocks.terminals.push(terminal);
  return terminal;
}

function status(bootId: string, state: ProbeStatus['state'] = 'running', ageMs = 0): ProbeStatus {
  const now = Date.now();
  return {
    protocol: 1,
    bootId,
    vmBootId: 'vm-test',
    pid: 123,
    python: '3.12',
    startedAtMs: now - ageMs,
    serverNowMs: now - ageMs,
    lastSampleAtMs: now - ageMs,
    seq: 1,
    sampleIntervalMs: 5_000,
    probeDir: paths.dir,
    metricsFile: 'metrics.jsonl',
    state,
    capabilities: [],
  };
}

const encode = (value: ProbeStatus): Buffer => Buffer.from(JSON.stringify(value));

describe('TerminalProbeLauncher', () => {
  const launcher = new TerminalProbeLauncher({ info: vi.fn() } as unknown as Logger);

  beforeEach(() => {
    mocks.terminals.length = 0;
    mocks.workspaceFolders.length = 0;
    mocks.readFile.mockReset();
    mocks.deleteFile.mockClear();
    mocks.delay.mockReset().mockResolvedValue(undefined);
  });

  it('does not send input to a same-name local terminal or unrelated extension terminal', async () => {
    const local = addTerminal(server.label, 'local');
    const other = addTerminal(server.label, 'other-pty');

    await expect(launcher.launch(server, paths, 5_000)).rejects.toThrow('Open the matching Colab terminal first');
    expect(local.sendText).not.toHaveBeenCalled();
    expect(other.sendText).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous terminal or mounted runtime label', () => {
    addTerminal(server.label, 'colab');
    mocks.workspaceFolders.push({ uri: { scheme: 'colab', authority: 'r-other' }, name: server.label });
    expect(() => launcher.requireTerminal(server)).toThrow('The Colab terminal is ambiguous');

    mocks.workspaceFolders.length = 0;
    addTerminal(server.label, 'colab');
    expect(() => launcher.requireTerminal(server)).toThrow('The Colab terminal is ambiguous');
  });

  it('preserves status and waits for a new running probe after launch', async () => {
    const terminal = addTerminal(server.label, 'colab');
    const previous = encode(status('old'));
    const running = status('new');
    mocks.readFile
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(encode(status('new', 'stopping')))
      .mockResolvedValueOnce(encode(running));

    await expect(launcher.launch(server, paths, 5_000)).resolves.toEqual(running);
    expect(terminal.sendText).toHaveBeenCalledTimes(1);
    expect(mocks.readFile).toHaveBeenCalledTimes(4);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it('does not launch after cancellation during the initial status read', async () => {
    const terminal = addTerminal(server.label, 'colab');
    const controller = new AbortController();
    const canceled = new Error('canceled');
    mocks.readFile.mockImplementationOnce(async () => {
      controller.abort(canceled);
      return encode(status('old'));
    });

    await expect(launcher.launch(server, paths, 5_000, controller.signal)).rejects.toBe(canceled);
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it('finds a recently sampled probe without a terminal and ignores stale or stopping probes', async () => {
    const running = status('running');
    mocks.readFile
      .mockResolvedValueOnce(encode(running))
      .mockResolvedValueOnce(encode(status('stale', 'running', 60_000)))
      .mockResolvedValueOnce(encode(status('stopping', 'stopping')));

    await expect(launcher.findRunningProbe(paths)).resolves.toEqual(running);
    await expect(launcher.findRunningProbe(paths)).resolves.toBeNull();
    await expect(launcher.findRunningProbe(paths)).resolves.toBeNull();
  });
});
