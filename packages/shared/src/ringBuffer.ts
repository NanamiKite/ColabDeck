export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private lengthValue = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`RingBuffer capacity must be a positive integer, received ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.lengthValue;
  }

  get isFull(): boolean {
    return this.lengthValue === this.capacity;
  }

  push(item: T): T | undefined {
    const index = (this.head + this.lengthValue) % this.capacity;
    let evicted: T | undefined;
    if (this.lengthValue === this.capacity) {
      evicted = this.items[this.head];
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.lengthValue += 1;
    }
    this.items[index] = item;
    return evicted;
  }

  last(): T | undefined {
    if (this.lengthValue === 0) {
      return undefined;
    }
    return this.items[(this.head + this.lengthValue - 1) % this.capacity];
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.lengthValue) {
      return undefined;
    }
    return this.items[(this.head + index) % this.capacity];
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.lengthValue = 0;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.lengthValue; index += 1) {
      const item = this.items[(this.head + index) % this.capacity];
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }
}
