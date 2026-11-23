import { useEffect, useState } from 'react';

/** The browser's clock in milliseconds, refreshed every second while `active`; a page showing "waiting for 12 s" reads it. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}
