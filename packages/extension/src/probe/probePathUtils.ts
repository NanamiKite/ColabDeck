import * as path from 'node:path';

export type ProbeDirValidation =
  | { readonly ok: true; readonly dir: string; readonly relativeDir: string }
  | { readonly ok: false; readonly error: string };

export function normalizeProbeDir(input: string): ProbeDirValidation {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/content') || trimmed.includes('\0')) {
    return {
      ok: false,
      error: 'Monitoring directory must be an absolute path under /content.',
    };
  }
  if (trimmed !== '/content' && !trimmed.startsWith('/content/')) {
    return { ok: false, error: 'colabdeck.probe.probeDir must be under /content.' };
  }
  if (trimmed.split('/').includes('..')) {
    return { ok: false, error: 'colabdeck.probe.probeDir must not contain "..".' };
  }
  const normalized = path.posix.normalize(trimmed).replace(/\/+$/g, '') || '/content';
  if (normalized !== '/content' && !normalized.startsWith('/content/')) {
    return { ok: false, error: 'colabdeck.probe.probeDir must stay under /content.' };
  }
  const relativeDir = normalized === '/content' ? '' : normalized.slice('/content/'.length);
  return { ok: true, dir: normalized, relativeDir };
}

export function probeFileRemotePath(relativeDir: string, fileName: string): string {
  const cleanRelative = relativeDir.replace(/^\/+|\/+$/g, '');
  if (fileName.length === 0) {
    return cleanRelative.length === 0 ? '/content' : `/content/${cleanRelative}`;
  }
  return cleanRelative.length === 0 ? `/content/${fileName}` : `/content/${cleanRelative}/${fileName}`;
}

export function validateMetricsFileName(fileName: string): string | null {
  if (
    fileName.length === 0 ||
    fileName.length > 128 ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    fileName === '.' ||
    fileName === '..' ||
    !fileName.endsWith('.jsonl')
  ) {
    return 'Probe returned an invalid metrics file name.';
  }
  return null;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
