import type { JSX } from 'preact';
import { formatAge } from '@colabdeck/shared';
import { useNow } from '../hooks/useNow.js';

interface SampleAgeProps {
  readonly receivedAtMs: number | null;
  readonly connected: boolean;
}

export function SampleAge({ receivedAtMs, connected }: SampleAgeProps): JSX.Element {
  const now = useNow(1000);
  if (receivedAtMs === null) {
    return <span class="freshness">No sample yet</span>;
  }
  const ageMs = Math.max(0, now - receivedAtMs);
  const stale = !connected || ageMs > 15_000;
  return (
    <span class={`freshness${stale ? ' stale' : ''}`}>
      Last sample {formatAge(ageMs)} ago
    </span>
  );
}
