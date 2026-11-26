import { RingBuffer, downsampleTelemetry, telemetryWindow } from '@colabdeck/shared';
import type { TelemetrySample } from '@colabdeck/shared';

const MIN_CAPACITY = 60;
const MAX_CAPACITY = 3600;
const WINDOW_MS = 60 * 60_000;
const MAX_POINTS = 600;

export class TelemetryStore {
  private readonly buffers = new Map<string, RingBuffer<TelemetrySample>>();
  private readonly latest = new Map<string, TelemetrySample>();
  private capacity = 720;

  constructor(intervalMs = 5000) {
    this.setInterval(intervalMs);
  }

  setInterval(intervalMs: number): void {
    this.capacity = Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, Math.ceil(WINDOW_MS / Math.max(1000, intervalMs))));
    for (const [serverId, buffer] of this.buffers) {
      const replacement = new RingBuffer<TelemetrySample>(this.capacity);
      for (const sample of buffer.toArray().slice(-this.capacity)) {
        replacement.push(sample);
      }
      this.buffers.set(serverId, replacement);
    }
  }

  append(serverId: string, sample: TelemetrySample): void {
    let buffer = this.buffers.get(serverId);
    if (!buffer) {
      buffer = new RingBuffer<TelemetrySample>(this.capacity);
      this.buffers.set(serverId, buffer);
    }
    buffer.push(sample);
    const latest = this.latest.get(serverId);
    if (!latest || sample.seq >= latest.seq) {
      this.latest.set(serverId, sample);
    }
  }

  clear(serverId: string): void {
    this.buffers.delete(serverId);
    this.latest.delete(serverId);
  }

  getLatest(serverId: string): TelemetrySample | null {
    return this.latest.get(serverId) ?? null;
  }

  getAll(serverId: string): readonly TelemetrySample[] {
    return this.buffers.get(serverId)?.toArray() ?? [];
  }

  getWindow(serverId: string, rangeMs: number, nowMs: number): readonly TelemetrySample[] {
    const all = this.getAll(serverId);
    return downsampleTelemetry(telemetryWindow(all, rangeMs, nowMs), MAX_POINTS);
  }
}
