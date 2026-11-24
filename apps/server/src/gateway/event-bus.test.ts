import { describe, expect, it } from 'vitest';
import { MemoryCoordination } from '../coordination/memory.js';
import { CoordinationEventBus } from './event-bus.js';

describe('CoordinationEventBus', () => {
  it('fans out published events to every replica bus sharing the coordination store', async () => {
    const coord = new MemoryCoordination();
    const a = new CoordinationEventBus(coord);
    const b = new CoordinationEventBus(coord);
    const got: string[] = [];
    b.subscribe((e) => got.push(`b:${e.kind}`));
    const un = a.subscribe(() => {
      throw new Error('a bad listener must not stop delivery');
    });
    a.subscribe((e) => got.push(`a:${e.kind}`));
    a.publish({ kind: 'tools_list_changed' });
    await new Promise((r) => setTimeout(r, 5));
    expect(got.sort()).toEqual(['a:tools_list_changed', 'b:tools_list_changed']);
    un();
    expect(a.listenerCount).toBe(1);
    a.close();
    b.close();
    await coord.close();
  });
});
