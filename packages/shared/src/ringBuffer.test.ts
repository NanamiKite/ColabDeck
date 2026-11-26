import { describe, expect, it } from 'vitest';
import { RingBuffer } from './ringBuffer.js';

describe('RingBuffer', () => {
  it('keeps the newest items and evicts the oldest', () => {
    const buffer = new RingBuffer<number>(3);
    expect(buffer.push(1)).toBeUndefined();
    expect(buffer.push(2)).toBeUndefined();
    expect(buffer.push(3)).toBeUndefined();
    expect(buffer.push(4)).toBe(1);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
    expect(buffer.last()).toBe(4);
    expect(buffer.length).toBe(3);
  });

  it('clears and rejects invalid capacity', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.last()).toBeUndefined();
    expect(() => new RingBuffer<number>(0)).toThrow();
  });
});
