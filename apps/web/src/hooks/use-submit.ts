import { useCallback, useEffect, useRef, useState } from 'react';

export interface Submission<A extends unknown[], R> {
  /** Runs the action. Resolves with its result, or undefined when it failed (see `error`) or another submit is in flight. */
  readonly submit: (...args: A) => Promise<R | undefined>;
  readonly pending: boolean;
  /** The failure of the latest submit; cleared when the next one starts. */
  readonly error: unknown;
  readonly clearError: () => void;
}

/**
 * One write at a time. A second call while the first is in flight does nothing: two identical requests would
 * be two runs (D-6.1), and a state update alone is too slow to stop a fast double click, so a ref guards it.
 */
export function useSubmit<A extends unknown[], R>(action: (...args: A) => Promise<R>): Submission<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const inFlight = useRef(false);
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  });

  const submit = useCallback(async (...args: A): Promise<R | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      return await actionRef.current(...args);
    } catch (failure) {
      setError(failure);
      return undefined;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(undefined);
  }, []);

  return { submit, pending, error, clearError };
}
