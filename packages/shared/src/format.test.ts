import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatBytes,
  formatBytesShort,
  formatDuration,
  gpuAggregateShortName,
  gpuShortName,
  redactCommandLine,
} from './format.js';

describe('format helpers', () => {
  it('formats binary bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(15 * 1024 * 1024 * 1024)).toBe('15.0 GiB');
    expect(formatBytesShort(8.2 * 1024 * 1024 * 1024)).toBe('8.2G');
    expect(formatBytes(null)).toBe('—');
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
  });

  it('formats sample ages', () => {
    expect(formatAge(3_000)).toBe('3s');
    expect(formatAge(125_000)).toBe('2m 5s');
    expect(formatAge(3_780_000)).toBe('1h 3m');
    expect(formatAge(null)).toBe('—');
  });

  it('maps GPU names', () => {
    expect(gpuShortName('Tesla T4')).toBe('T4');
    expect(gpuShortName('NVIDIA A100-SXM4-40GB')).toBe('A100');
    expect(gpuShortName('Tesla V100-SXM2-16GB')).toBe('V100');
    expect(gpuShortName('NVIDIA L4')).toBe('L4');
    expect(gpuAggregateShortName(['Tesla T4', 'Tesla T4'])).toBe('2x T4');
  });

  it('redacts secrets and truncates command lines', () => {
    const redacted = redactCommandLine('python train.py --token=abc123 --api-key def456 key=zzz password: hunter2');
    expect(redacted).not.toContain('abc123');
    expect(redacted).not.toContain('def456');
    expect(redacted).not.toContain('hunter2');
    expect(redactCommandLine('x'.repeat(500))).toHaveLength(200);
    expect(redactCommandLine(null)).toBeNull();
  });
});
