import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useLiveResource } from './use-live-resource';
import { useSubmit } from './use-submit';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A load whose answers are handed out by the test, so it decides when each request settles. */
function controlledLoad<T>() {
  const pending: { resolve: (value: T) => void; reject: (error: unknown) => void; signal: AbortSignal }[] = [];
  const load = vi.fn(
    (signal: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      }),
  );
  return { load, pending };
}

describe('useLiveResource', () => {
  test('asks again one interval after each answer while the data is live, and stops when it is not', async () => {
    const answers = ['running', 'running', 'done'];
    const load = vi.fn(() => Promise.resolve(answers.shift() ?? 'done'));
    const { result } = renderHook(() => useLiveResource('k', load, (value) => value !== 'done'));
    await advance(0);
    expect(result.current).toMatchObject({ status: 'ready', data: 'running' });
    expect(load).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(load).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(load).toHaveBeenCalledTimes(2);
    await advance(1000);
    expect(result.current.data).toBe('done');
    expect(load).toHaveBeenCalledTimes(3);

    await advance(60_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  test('never has two requests in flight: the next one waits for the answer to the last', async () => {
    const { load, pending } = controlledLoad<string>();
    renderHook(() => useLiveResource('k', load, () => true));
    await advance(0);
    expect(load).toHaveBeenCalledTimes(1);

    await advance(30_000);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]?.resolve('running');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a failed refresh keeps the data on screen, reports it, keeps trying and recovers by itself', async () => {
    const outcomes: (string | Error)[] = ['first', new Error('proxy down'), 'third'];
    const load = vi.fn(() => {
      const outcome = outcomes.shift() ?? 'later';
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    });
    const { result } = renderHook(() => useLiveResource('k', load, () => true));
    await advance(0);
    expect(result.current).toMatchObject({ status: 'ready', data: 'first', refreshError: undefined });

    await advance(1000);
    expect(result.current).toMatchObject({ status: 'ready', data: 'first' });
    expect(result.current.refreshError).toEqual(new Error('proxy down'));

    await advance(1000);
    expect(result.current).toMatchObject({ status: 'ready', data: 'third', refreshError: undefined });
  });

  test('a failure before any data is an error, which does not poll; reload starts over', async () => {
    const load = vi.fn<(signal: AbortSignal) => Promise<string>>().mockRejectedValueOnce(new Error('down')).mockResolvedValue('up');
    const { result } = renderHook(() => useLiveResource('k', load, () => false));
    await advance(0);
    expect(result.current).toMatchObject({ status: 'error', data: undefined });
    await advance(10_000);
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.reload();
    });
    await advance(0);
    expect(result.current).toMatchObject({ status: 'ready', data: 'up' });
  });

  test('unmounting aborts the request in flight and cancels the next one', async () => {
    const { load, pending } = controlledLoad<string>();
    const { unmount } = renderHook(() => useLiveResource('k', load, () => true));
    await advance(0);
    expect(pending[0]?.signal.aborted).toBe(false);
    unmount();
    expect(pending[0]?.signal.aborted).toBe(true);
    await act(async () => {
      pending[0]?.resolve('late');
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a new key abandons the old request and never shows its answer', async () => {
    const { load, pending } = controlledLoad<string>();
    const { result, rerender } = renderHook(({ key }) => useLiveResource(key, load, () => false), { initialProps: { key: 'a' } });
    await advance(0);
    rerender({ key: 'b' });
    await advance(0);
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending[0]?.resolve('answer for a');
      pending[1]?.resolve('answer for b');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.data).toBe('answer for b');
  });
});

describe('useSubmit', () => {
  test('a second submit while the first is in flight does nothing', async () => {
    const { load: action, pending } = controlledLoad<string>();
    const { result } = renderHook(() => useSubmit(() => action(new AbortController().signal)));
    let first: Promise<string | undefined> | undefined;
    let second: Promise<string | undefined> | undefined;
    act(() => {
      first = result.current.submit();
      second = result.current.submit();
    });
    expect(result.current.pending).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending[0]?.resolve('done');
      await Promise.all([first, second]);
    });
    expect(await first).toBe('done');
    expect(await second).toBeUndefined();
    expect(result.current.pending).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
  });

  test('keeps the failure, and clears it when the next submit starts', async () => {
    const action = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('refused')).mockResolvedValue('ok');
    const { result } = renderHook(() => useSubmit(action));
    await act(async () => {
      expect(await result.current.submit()).toBeUndefined();
    });
    expect(result.current.error).toEqual(new Error('refused'));
    expect(result.current.pending).toBe(false);
    await act(async () => {
      expect(await result.current.submit()).toBe('ok');
    });
    expect(result.current.error).toBeUndefined();
  });

  test('passes the arguments through and can submit again once the first has finished', async () => {
    const action = vi.fn((value: number) => Promise.resolve(value * 2));
    const { result } = renderHook(() => useSubmit(action));
    await act(async () => {
      expect(await result.current.submit(2)).toBe(4);
      expect(await result.current.submit(5)).toBe(10);
    });
    expect(action).toHaveBeenCalledTimes(2);
  });
});
