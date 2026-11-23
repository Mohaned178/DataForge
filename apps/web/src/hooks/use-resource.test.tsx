import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useResource } from './use-resource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useResource', () => {
  test('loads, then reports the value', async () => {
    const { result } = renderHook(() => useResource('a', () => Promise.resolve('value')));
    expect(result.current.status).toBe('loading');
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.data).toBe('value');
  });

  test('a response to a superseded request is never shown', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(({ key }) => useResource(key, () => (key === 'a' ? first.promise : second.promise)), {
      initialProps: { key: 'a' },
    });
    rerender({ key: 'b' });
    second.resolve('second');
    await waitFor(() => {
      expect(result.current.data).toBe('second');
    });
    await act(async () => {
      first.resolve('first');
      await first.promise;
    });
    expect(result.current.data).toBe('second');
    expect(result.current.status).toBe('ready');
  });

  test('the previous request is aborted when the key changes', () => {
    const signals: AbortSignal[] = [];
    const { rerender } = renderHook(
      ({ key }) =>
        useResource(key, (signal) => {
          signals.push(signal);
          return new Promise<string>(() => undefined);
        }),
      { initialProps: { key: 'a' } },
    );
    rerender({ key: 'b' });
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  test('keeps the previous value on screen while a new request is in flight', async () => {
    const next = deferred<string>();
    const { result, rerender } = renderHook(({ key }) => useResource(key, () => (key === 'a' ? Promise.resolve('one') : next.promise)), {
      initialProps: { key: 'a' },
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    rerender({ key: 'b' });
    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBe('one');
    next.resolve('two');
    await waitFor(() => {
      expect(result.current.data).toBe('two');
    });
  });

  test('reload repeats the current request', async () => {
    const load = vi.fn(() => Promise.resolve('x'));
    const { result } = renderHook(() => useResource('a', load));
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  test('a failure is reported with its error, and a later success clears it', async () => {
    const failure = new Error('boom');
    let attempt = 0;
    const { result } = renderHook(() => useResource('a', () => (attempt++ === 0 ? Promise.reject(failure) : Promise.resolve('recovered'))));
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error).toBe(failure);
    act(() => {
      result.current.reload();
    });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.data).toBe('recovered');
  });
});
