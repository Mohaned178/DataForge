import { z } from 'zod';

/** The API is not reachable: the network failed, or the web server's proxy answered 502 with no body. */
export class ApiUnreachable extends Error {
  readonly kind = 'unreachable';
  constructor(detail: string) {
    super(`The API could not be reached: ${detail}`);
    this.name = 'ApiUnreachable';
  }
}

/** The API answered with an error status and, normally, its error shape. */
export class ApiError extends Error {
  readonly kind = 'api';
  constructor(
    readonly statusCode: number,
    /** The API's error name, for example "Not Found" or "Run Integrity Error". */
    readonly error: string,
    readonly messages: readonly string[],
  ) {
    super(messages.length > 0 ? messages.join('; ') : error);
    this.name = 'ApiError';
  }

  /** A stored run or execution that no longer matches its recorded checksum. */
  get isIntegrityError(): boolean {
    return this.statusCode === 500 && /integrity error/i.test(this.error);
  }
}

/** The API answered successfully, but not with what this version of the UI reads. */
export class ResponseShapeError extends Error {
  readonly kind = 'shape';
  constructor(
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(`Unexpected response from ${path}: ${issues.join('; ')}`);
    this.name = 'ResponseShapeError';
  }
}

export type ApiFailure = ApiUnreachable | ApiError | ResponseShapeError;

export function isApiFailure(value: unknown): value is ApiFailure {
  return value instanceof ApiUnreachable || value instanceof ApiError || value instanceof ResponseShapeError;
}

/** Where the web server forwards to the API (vite.config.mts); the prefix keeps the UI's own routes apart. */
export const API_BASE = '/api';

const errorBodySchema = z.object({ statusCode: z.number(), error: z.string(), message: z.union([z.string(), z.array(z.string())]) });

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('json');
}

async function failureOf(response: Response): Promise<ApiFailure> {
  if (isJson(response)) {
    const body = errorBodySchema.safeParse(await response.json().catch(() => null));
    if (body.success) {
      const { message } = body.data;
      return new ApiError(response.status, body.data.error, typeof message === 'string' ? [message] : message);
    }
    return new ApiError(response.status, response.statusText || `HTTP ${response.status}`, []);
  }
  // A plain-text or empty error is not the API talking: the proxy could not reach it.
  if (response.status >= 500) {
    return new ApiUnreachable(`${response.status} ${response.statusText}`.trim());
  }
  return new ApiError(response.status, response.statusText || `HTTP ${response.status}`, []);
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiUnreachable(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw await failureOf(response);
  return response;
}

async function parseBody<S extends z.ZodType>(path: string, response: Response, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ResponseShapeError(path, ['the body is not JSON']);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ResponseShapeError(
      path,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/** GET a JSON resource from the API and validate it against `schema`. */
export async function getJson<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
  const response = await request(path, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
  return parseBody(path, response, schema);
}

/** The answer of a write: the HTTP status says more than the body (201 created a version, 200 returned the existing one). */
export interface Written<T> {
  readonly status: number;
  readonly data: T;
}

/**
 * POST a JSON body and validate the answer against `schema`. A refusal is an `ApiError` whose `messages`
 * are the API's own, one per problem, as "path: message".
 */
export async function postJson<S extends z.ZodType>(path: string, body: unknown, schema: S, signal?: AbortSignal): Promise<Written<z.output<S>>> {
  const response = await request(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return { status: response.status, data: await parseBody(path, response, schema) };
}

/** A query string from the defined values only ("" when there are none). */
export function queryString(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}
