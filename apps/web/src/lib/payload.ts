import { formatMoney, formatValue } from './format';

/** The scalar fields of an event payload as short "name value" pairs; money is shown in major units. */
export function summarizePayload(payload: Readonly<Record<string, unknown>>, limit = 4): string[] {
  const currency = typeof payload['currency'] === 'string' ? payload['currency'] : undefined;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(payload)) {
    if (name === 'currency') continue;
    if (Array.isArray(value)) {
      parts.push(`${name}: ${value.length} item${value.length === 1 ? '' : 's'}`);
    } else if (typeof value === 'number' && name.endsWith('Minor')) {
      parts.push(`${name.slice(0, -'Minor'.length)}: ${formatMoney(value, currency)}`);
    } else if (value !== null && typeof value === 'object') {
      parts.push(`${name}: {…}`);
    } else {
      parts.push(`${name}: ${formatValue(value)}`);
    }
  }
  return parts.slice(0, limit);
}
