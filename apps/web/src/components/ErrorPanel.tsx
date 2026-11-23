import { ApiError, ApiUnreachable, ResponseShapeError } from '../api/client';

interface Props {
  readonly error: unknown;
  /** What was being loaded, for the sentence "Could not load <what>". */
  readonly what: string;
  readonly onRetry?: (() => void) | undefined;
}

function Messages({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul>
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

/** Each failure kind says what it means and what to do about it. */
export function ErrorPanel({ error, what, onRetry }: Props) {
  const retry = onRetry ? (
    <button type="button" onClick={onRetry}>
      Try again
    </button>
  ) : null;

  if (error instanceof ApiUnreachable) {
    return (
      <section className="panel panel--bad" role="alert">
        <h2>The API is not reachable</h2>
        <p>
          DataForge could not load {what}. The web server forwards <code>/api</code> to the API (by default{' '}
          <code>http://127.0.0.1:3000</code>, or <code>WEB_API_URL</code>), and nothing answered there.
        </p>
        <p>
          Start the API with <code>pnpm api</code> and check that PostgreSQL is running (<code>docker compose ps</code>).
        </p>
        {retry}
      </section>
    );
  }

  if (error instanceof ApiError) {
    if (error.isIntegrityError) {
      return (
        <section className="panel panel--bad" role="alert">
          <h2>Integrity error: stored data no longer matches its checksum</h2>
          <p>
            DataForge refuses to show {what}: what is stored was changed after it was written, so it can no longer be trusted. Do not use
            results built from it.
          </p>
          <Messages messages={error.messages} />
          <p>Restore the database from a backup, or generate the run again and test it again.</p>
        </section>
      );
    }
    if (error.statusCode === 404) {
      return (
        <section className="panel" role="alert">
          <h2>Not found</h2>
          <p>
            Could not load {what}: the API has nothing with that identifier. It may have been mistyped, or belong to another database.
          </p>
          <Messages messages={error.messages} />
        </section>
      );
    }
    if (error.statusCode === 409) {
      return (
        <section className="panel panel--warn" role="alert">
          <h2>Not available yet</h2>
          <p>The API cannot give {what} in the state it is in now.</p>
          <Messages messages={error.messages} />
          {retry}
        </section>
      );
    }
    if (error.statusCode === 400) {
      return (
        <section className="panel panel--warn" role="alert">
          <h2>The API rejected this request</h2>
          <p>Could not load {what}; a value in the address is not valid.</p>
          <Messages messages={error.messages} />
        </section>
      );
    }
    return (
      <section className="panel panel--bad" role="alert">
        <h2>The API failed ({error.statusCode})</h2>
        <p>Could not load {what}.</p>
        <Messages messages={error.messages.length > 0 ? error.messages : [error.error]} />
        {retry}
      </section>
    );
  }

  if (error instanceof ResponseShapeError) {
    return (
      <section className="panel panel--bad" role="alert">
        <h2>Unexpected response from the API</h2>
        <p>
          The API answered, but not with what this version of the web UI expects for {what}. The UI and the API are probably out of step: update
          and rebuild both.
        </p>
        <Messages messages={error.issues} />
      </section>
    );
  }

  return (
    <section className="panel panel--bad" role="alert">
      <h2>Something went wrong</h2>
      <p>
        Could not load {what}: {error instanceof Error ? error.message : String(error)}
      </p>
      {retry}
    </section>
  );
}
