const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const BINARY_SHORT_UNITS = ['B', 'K', 'M', 'G', 'T'] as const;

export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BINARY_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(decimals)} ${BINARY_UNITS[unitIndex]}`;
}

export function formatBytesShort(bytes: number | null | undefined, decimals = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BINARY_SHORT_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(decimals)}${BINARY_SHORT_UNITS[unitIndex]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return '—';
  }
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(decimals)}%`;
}

export function gpuShortName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'GPU';
  }
  const normalized = trimmed.replace(/^NVIDIA\s+/i, '').replace(/^Tesla\s+/i, '');
  const lower = normalized.toLowerCase();
  if (lower.startsWith('a100')) {
    return 'A100';
  }
  if (lower.startsWith('v100')) {
    return 'V100';
  }
  if (lower.startsWith('l4')) {
    return 'L4';
  }
  if (lower.startsWith('t4')) {
    return 'T4';
  }
  if (lower.startsWith('rtx')) {
    const match = /rtx\s*(\d{3,5})/i.exec(normalized);
    return match?.[1] ? `RTX ${match[1]}` : 'RTX';
  }
  const firstToken = normalized.split(/\s+/)[0] ?? normalized;
  return firstToken.replace(/-.*$/, '');
}

export function gpuAggregateShortName(names: readonly string[]): string {
  if (names.length === 0) {
    return 'No GPU';
  }
  const first = gpuShortName(names[0] ?? '');
  return names.length === 1 ? first : `${names.length}x ${first}`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /(--?(?:token|api[-_]?key|password|passwd|secret|access[-_]?token|auth[-_]?token)\s*(?:[=:]|\s)\s*)(["']?)[^\s"']+/gi,
  /(\b(?:key|token|password|secret)\s*[=:]\s*)(["']?)[^\s"']+/gi,
];

export function redactCommandLine(command: string | null | undefined, maxLength = 200): string | null {
  if (command === null || command === undefined) {
    return null;
  }
  let redacted = command;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix: string, _quote: string) => `${prefix}<redacted>`);
  }
  if (redacted.length > maxLength) {
    redacted = `${redacted.slice(0, maxLength - 1)}…`;
  }
  return redacted;
}

export function abbreviateId(id: string | null | undefined, length = 8): string {
  if (!id) {
    return '—';
  }
  return id.length <= length ? id : id.slice(0, length);
}

export function formatClock(timestampMs: number | null | undefined): string {
  if (timestampMs === null || timestampMs === undefined) {
    return '—';
  }
  return new Date(timestampMs).toLocaleTimeString([], { hour12: false });
}
