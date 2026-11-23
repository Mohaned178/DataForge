/*
 * Display formatting. Everything here is locale-independent on purpose (no toLocaleString, no
 * local time zone): the same value reads the same on every machine, and every timestamp says UTC.
 */

const DASH = '—';

export function formatCount(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(1))} s`;
  const totalMinutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - totalMinutes * 60);
  if (totalMinutes < 60) return restSeconds === 0 ? `${totalMinutes} min` : `${totalMinutes} min ${restSeconds} s`;
  const totalHours = Math.floor(totalMinutes / 60);
  const restMinutes = totalMinutes - totalHours * 60;
  if (totalHours < 24) return restMinutes === 0 ? `${totalHours} h` : `${totalHours} h ${restMinutes} min`;
  const days = Math.floor(totalHours / 24);
  const restHours = totalHours - days * 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/** How long something has been waiting, in whole seconds: "less than a second", "9 s", "1 min 5 s". */
export function formatWaited(ms: number): string {
  return ms < 1000 ? 'less than a second' : formatDuration(Math.floor(ms / 1000) * 1000);
}

/** Simulation time: milliseconds since the scenario epoch, as T+[d ]hh:mm:ss.mmm. */
export function formatSimTime(ms: number): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  const days = Math.floor(ms / 86_400_000);
  const rest = ms - days * 86_400_000;
  const hours = Math.floor(rest / 3_600_000);
  const minutes = Math.floor((rest % 3_600_000) / 60_000);
  const seconds = Math.floor((rest % 60_000) / 1000);
  const millis = rest % 1000;
  const clock = `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
  return days > 0 ? `T+${days}d ${clock}` : `T+${clock}`;
}

/** An ISO timestamp from the API, as "2026-11-23 12:18:11 UTC". */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return DASH;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1] ?? ''} ${match[2] ?? ''} UTC` : iso;
}

/** How long something took, from two ISO timestamps. */
export function formatSpan(startIso: string | null, endIso: string | null): string {
  if (startIso === null || endIso === null) return DASH;
  const span = Date.parse(endIso) - Date.parse(startIso);
  return Number.isNaN(span) || span < 0 ? DASH : formatDuration(span);
}

export function formatMoney(minor: number, currency = 'USD'): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  const whole = Math.floor(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  return `${sign}${formatCount(whole)}.${cents} ${currency}`;
}

/** The distinguishing end of a UUID: version 7 IDs share their first characters within a minute. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export const EMPTY = DASH;
