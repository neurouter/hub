import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCursorStack } from './use-cursor-stack';

describe('useCursorStack', () => {
  it('pushes next cursors, pops on prev, and resets when filters change', () => {
    const { result, rerender } = renderHook(({ key }) => useCursorStack(key), { initialProps: { key: 'q=a' } });
    expect(result.current).toMatchObject({ cursor: null, page: 1, hasPrev: false });
    act(() => result.current.next('c2'));
    expect(result.current).toMatchObject({ cursor: 'c2', page: 2, hasPrev: true });
    act(() => result.current.next('c3'));
    expect(result.current.cursor).toBe('c3');
    act(() => result.current.prev());
    expect(result.current).toMatchObject({ cursor: 'c2', page: 2 });
    act(() => result.current.next(null));
    expect(result.current.page).toBe(2);
    rerender({ key: 'q=b' });
    expect(result.current).toMatchObject({ cursor: null, page: 1, hasPrev: false });
  });
});
