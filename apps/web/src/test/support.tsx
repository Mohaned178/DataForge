import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { vi } from 'vitest';
import { AppRoutes } from '../App';

/** One stubbed API route: the path (below /api) and, optionally, query parameters it must carry. */
export interface StubRoute {
  readonly path: string;
  /** Parameters the request must have with these values; others are ignored. */
  readonly query?: Readonly<Record<string, string>>;
  readonly respond: (url: URL) => Response | Promise<Response>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** The API's error shape, as Nest sends it. */
export function apiErrorResponse(status: number, error: string, message: string | string[]): Response {
  return jsonResponse({ statusCode: status, error, message }, status);
}

/** What the web server's proxy answers when the API is down: 502, plain text, no body. */
export function proxyDownResponse(): Response {
  return new Response(null, { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain' } });
}

export function ok(body: unknown): () => Response {
  return () => jsonResponse(body);
}

export interface ApiStub {
  /** Every request the page made, as "/path?query" below /api, in order. */
  readonly calls: string[];
}

/**
 * Replaces `fetch` for one test. A request no route matches fails the test with its URL, so a page
 * cannot quietly call an endpoint the test did not expect.
 */
export function stubApi(routes: readonly StubRoute[]): ApiStub {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(target, 'http://web.test');
      const path = url.pathname.replace(/^\/api/, '');
      calls.push(`${path}${url.search}`);
      const route = routes.find(
        (candidate) => candidate.path === path && Object.entries(candidate.query ?? {}).every(([name, value]) => url.searchParams.get(name) === value),
      );
      if (route === undefined) return Promise.reject(new Error(`Unstubbed API request: ${path}${url.search}`));
      return Promise.resolve(route.respond(url));
    }),
  );
  return { calls };
}

/** Shows the router's current path and query, so a test can assert where a click led. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

/** Renders the whole application at `url`, as the browser would after following a link. */
export function renderApp(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** A paged answer from a list fixture: the slice the request's offset and limit ask for, with the fixture's total. */
export function pagedRoute<T extends { findings: unknown[]; total: number }>(path: string, fixture: T): StubRoute {
  return {
    path,
    respond: (url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return jsonResponse({ ...fixture, findings: fixture.findings.slice(offset, offset + limit), limit, offset });
    },
  };
}
