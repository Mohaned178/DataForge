export type ParsedJson =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string; readonly line?: number; readonly column?: number };

/** The line and column (both 1-based) of a character offset in `text`. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines.at(-1) ?? '').length + 1 };
}

/** Whether `prefix` already contains a mistake, as opposed to being a document that is merely not finished yet. */
function hasMistake(prefix: string): boolean {
  try {
    JSON.parse(prefix);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const position = /position (\d+)/i.exec(message);
    if (position) return Number(position[1]) < prefix.length;
    return /^Unexpected token/i.test(message);
  }
}

/**
 * Where a mistake is, for the messages that do not say ("Unexpected token '}', ...snippet... is not valid
 * JSON"). A mistake stays a mistake in every longer prefix, so the shortest prefix that has one ends at the
 * offending character, found by bisection.
 */
function locateMistake(text: string): number | undefined {
  if (!hasMistake(text)) return undefined;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (hasMistake(text.slice(0, middle))) high = middle;
    else low = middle + 1;
  }
  return high - 1;
}

/**
 * Parses a document typed into an editor. The browsers word a syntax error differently ("at position 33",
 * "(line 3 column 5)", "at line 3 column 5 of the JSON data", or no place at all), so the place is read from
 * whichever form the message has, found by bisection when it has none, and otherwise left out; the message
 * itself is always kept.
 */
export function parseJsonText(text: string): ParsedJson {
  if (text.trim() === '') return { ok: false, message: 'The document is empty.' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lineAndColumn = /line (\d+) column (\d+)/i.exec(message);
    if (lineAndColumn) return { ok: false, message, line: Number(lineAndColumn[1]), column: Number(lineAndColumn[2]) };
    const position = /position (\d+)/i.exec(message);
    if (position) return { ok: false, message, ...positionOf(text, Number(position[1])) };
    const located = locateMistake(text);
    return located === undefined ? { ok: false, message } : { ok: false, message, ...positionOf(text, located) };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: 'The document must be a JSON object ({ ... }).' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** The document, indented the way the repository's example files are. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
