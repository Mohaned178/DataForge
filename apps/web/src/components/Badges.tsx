const STATUS_LABEL: Readonly<Record<string, string>> = {
  awaiting_actual_state: 'awaiting actual state',
};

const STATUS_TONE: Readonly<Record<string, string>> = {
  queued: 'neutral',
  running: 'info',
  awaiting_actual_state: 'info',
  succeeded: 'good',
  completed: 'good',
  failed: 'bad',
};

/** A run or execution status. The word is always shown: colour alone never carries the meaning. */
export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${STATUS_TONE[status] ?? 'neutral'}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function VerdictBadge({ verdict }: { verdict: 'PASS' | 'FAIL' | null }) {
  if (verdict === null) return <span className="muted">&mdash;</span>;
  return <span className={`badge ${verdict === 'PASS' ? 'badge--good' : 'badge--bad'}`}>{verdict}</span>;
}

export function Tag({ children, tone = 'neutral' }: { children: string; tone?: 'neutral' | 'warn' | 'bad' | 'info' }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
