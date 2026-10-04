import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../src/app/asyncQueue.js';

async function drain<T>(q: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe('AsyncQueue', () => {
  it('yields items pushed before and after iteration starts, then ends on close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    const result = drain(q);
    q.push(2);
    await Promise.resolve();
    q.push(3);
    q.close();
    expect(await result).toEqual([1, 2, 3]);
  });

  it('delivers queued items after close before finishing', async () => {
    const q = new AsyncQueue<string>();
    q.push('a');
    q.close();
    expect(await drain(q)).toEqual(['a']);
    expect(q.isClosed).toBe(true);
  });

  it('rejects pushes after close', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow(/closed/);
  });

  it('closes when the consumer stops early', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    for await (const _ of q) break;
    expect(q.isClosed).toBe(true);
  });
});
