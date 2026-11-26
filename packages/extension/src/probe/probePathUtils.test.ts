import { describe, expect, it } from 'vitest';
import {
  normalizeProbeDir,
  probeFileRemotePath,
  shellQuote,
  validateMetricsFileName,
} from './probePathUtils.js';

describe('probe path utilities', () => {
  it('normalizes /content probe directories', () => {
    const result = normalizeProbeDir('/content/.colabdeck/');
    expect(result).toEqual({ ok: true, dir: '/content/.colabdeck', relativeDir: '.colabdeck' });
    expect(normalizeProbeDir('/content')).toEqual({ ok: true, dir: '/content', relativeDir: '' });
  });

  it('rejects paths outside /content and traversal', () => {
    expect(normalizeProbeDir('/tmp/probe').ok).toBe(false);
    expect(normalizeProbeDir('content/probe').ok).toBe(false);
    expect(normalizeProbeDir('/content/../etc').ok).toBe(false);
  });

  it('builds remote paths', () => {
    expect(probeFileRemotePath('.colabdeck', 'status.json')).toBe('/content/.colabdeck/status.json');
    expect(probeFileRemotePath('', 'status.json')).toBe('/content/status.json');
    expect(probeFileRemotePath('', '')).toBe('/content');
  });

  it('validates metrics file names', () => {
    expect(validateMetricsFileName('metrics.jsonl')).toBeNull();
    expect(validateMetricsFileName('../metrics.jsonl')).not.toBeNull();
    expect(validateMetricsFileName('status.json')).not.toBeNull();
  });

  it('quotes shell values', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
