import { describe, expect, it } from 'vitest';

import { PortAllocator } from './ports.js';

describe('PortAllocator', () => {
  it('hands out distinct ports while they are held', async () => {
    const allocator = new PortAllocator('127.0.0.1');

    const first = await allocator.allocate();
    const second = await allocator.allocate();

    expect(first).not.toBe(second);
    expect(allocator.reserved.size).toBe(2);
  });

  it('releases a port back for reuse', async () => {
    const allocator = new PortAllocator('127.0.0.1');

    const port = await allocator.allocate();
    allocator.release(port);

    expect(allocator.reserved.has(port)).toBe(false);
    expect(allocator.reserved.size).toBe(0);
  });

  it('does not leak reservations across repeated allocate and release cycles', async () => {
    const allocator = new PortAllocator('127.0.0.1');

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const port = await allocator.allocate();
      allocator.release(port);
    }

    expect(allocator.reserved.size).toBe(0);
  });

  it('marks an adopted port as taken without probing', () => {
    const allocator = new PortAllocator('127.0.0.1');

    allocator.reserve(4321);

    expect(allocator.reserved.has(4321)).toBe(true);
  });
});
