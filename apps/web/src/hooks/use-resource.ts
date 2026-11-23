import { useCallback, useEffect, useRef, useState } from 'react';

export type ResourceStatus = 'loading' | 'ready' | 'error';

export interface Resource<T> {
  readonly status: ResourceStatus;
  /** The latest successfully loaded value. While a reload or a new request is in flight it is the previous one. */
  readonly data: T | undefined;
  /** The failure of the latest request (status "error"). */
  readonly error: unknown;
  readonly reload: () => void;
}

type Settled<T> = { readonly key: string; readonly value: T } | { readonly key: string; readonly error: unknown };

/**
 * Loads one resource. `key` names the request (path and query): when it changes the previous request
 * is aborted and the new one starts; `reload()` repeats the current one. The result is stored with
 * the key it answers, so a response to a superseded request can never be shown.
 */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [reloads, setReloads] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [lastValue, setLastValue] = useState<T | undefined>(undefined);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const requestKey = `${key}#${reloads}`;

  useEffect(() => {
    const controller = new AbortController();
    loadRef.current(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setLastValue(value);
        setSettled({ key: requestKey, value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setSettled({ key: requestKey, error });
      },
    );
    return () => {
      controller.abort();
    };
  }, [requestKey]);

  const reload = useCallback(() => {
    setReloads((count) => count + 1);
  }, []);

  if (settled === null || settled.key !== requestKey) return { status: 'loading', data: lastValue, error: undefined, reload };
  if ('error' in settled) return { status: 'error', data: lastValue, error: settled.error, reload };
  return { status: 'ready', data: settled.value, error: undefined, reload };
}
