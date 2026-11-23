/** Rows per page of every list. The API caps a page at 200 (lists) or 1,000 (events, attempts, findings). */
export const PAGE_SIZE = 25;

/** The `offset` of the current page from the URL: a whole number, 0 when absent or invalid. */
export function offsetOf(params: URLSearchParams): number {
  const raw = params.get('offset');
  if (raw === null || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * A copy of the URL's query with `changes` applied (an undefined value removes the parameter). The
 * list's paging parameter (`offsetParam`, "offset" unless a page has several lists) is removed unless
 * the change sets it, so a new filter returns to the first page instead of landing on a page that no
 * longer exists, while another list's paging is left alone. `null` leaves every paging parameter as
 * it is (opening a row of the current page).
 */
export function withParams(
  params: URLSearchParams,
  changes: Readonly<Record<string, string | undefined>>,
  offsetParam: string | null = 'offset',
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined || value === '') next.delete(name);
    else next.set(name, value);
  }
  if (offsetParam !== null && !(offsetParam in changes)) next.delete(offsetParam);
  return next;
}

/** The first value of a parameter, or undefined when absent or empty. */
export function paramOf(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  return value === null || value === '' ? undefined : value;
}

/** A non-negative whole-number parameter (an ordinal), or undefined when absent or invalid. */
export function wholeParamOf(params: URLSearchParams, name: string): number | undefined {
  const value = params.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}
