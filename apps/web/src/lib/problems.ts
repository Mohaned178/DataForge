export interface Problem {
  /** The field the API names ("orders.count", "target.name"), when the message starts with one. */
  readonly path?: string;
  readonly message: string;
}

/**
 * The API lists problems as "path: message" (an unknown key has no path: `Unrecognized key: "colour"`).
 * Splits the first form; leaves anything else whole, so no word of the API's message is ever lost.
 */
export function parseProblem(text: string): Problem {
  const match = /^([A-Za-z0-9_$.[\]-]+): ([\s\S]+)$/.exec(text);
  if (match && match[1] !== undefined && match[2] !== undefined) return { path: match[1], message: match[2] };
  return { message: text };
}

/** Any thrown value as a sentence: an Error's message, a string as it is, anything else as JSON. */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unknown failure';
}
