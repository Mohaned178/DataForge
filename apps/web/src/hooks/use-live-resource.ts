import { useCallback, useEffect, useRef, useState } from 'react';
import type { Resource } from './use-resource';

export interface LiveResource<T> extends Resource<T> {
  /**
   * The failure of the latest refresh when earlier data is on screen: the data is kept, the notice says the
   * API cannot be reached, and the next attempt is already scheduled. Undefined while refreshes succeed.
   */
  readonly refreshError: unknown;
}

/** How long to wait after an answer before asking again. */
export const LIVE_INTERVAL_MS = 1000;

interface State<T> {
  readonly key: string;
  readonly hasValue: boolean;
  readonly value: T | undefined;
  readonly error: unknown;
}

/**
 * Loads one resource and keeps it fresh while `isLive(data)` says it is still moving (a run or execution
 * that is queued or running), then stops by itself.
 *
 * - The next request starts `intervalMs` after the previous answer arrived, never before: the API's event loop
 *   is busy while it generates or delivers in memory, and requests must not pile up behind it.
 * - A refresh that fails keeps the last data on screen (`refreshError`) and tries again; only a failure
 *   before any data arrived is an `error`.
 * - Unmounting, or a new `key`, aborts the request in flight and cancels the timer.
 * - `reload()` starts over for the same key (the "Try again" button of an error).
 */
export function useLiveResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  isLive: (data: T) => boolean,
  intervalMs: number = LIVE_INTERVAL_MS,
): LiveResource<T> {
  const [reloads, setReloads] = useState(0);
  const [state, setState] = useState<State<T> | null>(null);
  const loadRef = useRef(load);
  const isLiveRef = useRef(isLive);
  useEffect(() => {
    loadRef.current = load;
    isLiveRef.current = isLive;
  });
  const requestKey = `${key}#${reloads}`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: { readonly value: T } | undefined;

    const step = () => {
      loadRef.current(controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return;
          latest = { value };
          setState({ key: requestKey, hasValue: true, value, error: undefined });
          if (isLiveRef.current(value)) timer = setTimeout(step, intervalMs);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          const kept = latest;
          setState({ key: requestKey, hasValue: kept !== undefined, value: kept?.value, error });
          if (kept !== undefined) timer = setTimeout(step, intervalMs);
        },
      );
    };
    step();

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [requestKey, intervalMs]);

  const reload = useCallback(() => {
    setReloads((count) => count + 1);
  }, []);

  if (state === null || state.key !== requestKey) return { status: 'loading', data: undefined, error: undefined, refreshError: undefined, reload };
  if (state.hasValue) return { status: 'ready', data: state.value, error: undefined, refreshError: state.error, reload };
  return { status: 'error', data: undefined, error: state.error, refreshError: undefined, reload };
}
