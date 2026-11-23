import { ApiError, ApiUnreachable, ResponseShapeError } from '../api/client';
import { describeFailure, parseProblem } from '../lib/problems';

/** The API's problems, one line each, with the field in code type. */
export function ProblemList({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="problems">
      {messages.map((text) => {
        const problem = parseProblem(text);
        return (
          <li key={text}>
            {problem.path ? <code>{problem.path}</code> : null} {problem.message}
          </li>
        );
      })}
    </ul>
  );
}

interface SubmitErrorProps {
  readonly error: unknown;
  /** What was being sent ("the scenario", "the execution"), for the sentence "The API refused <what>". */
  readonly what: string;
}

/** The failure of a write: refused with problems to fix, a conflict, an API that is down, or a reply the UI cannot read. */
export function SubmitError({ error, what }: SubmitErrorProps) {
  if (error === undefined || error === null) return null;
  if (error instanceof ApiUnreachable) {
    return (
      <section className="panel panel--bad" role="alert">
        <h2>The API is not reachable</h2>
        <p>
          Nothing was sent: {what} was not saved. Start the API with <code>pnpm api</code>, then try again.
        </p>
      </section>
    );
  }
  if (error instanceof ApiError) {
    const messages = error.messages.length > 0 ? error.messages : [error.error];
    if (error.statusCode === 400) {
      return (
        <section className="panel panel--warn" role="alert">
          <h2>The API refused {what}</h2>
          <p>Fix {messages.length === 1 ? 'this problem' : 'these problems'} and try again; nothing was saved.</p>
          <ProblemList messages={messages} />
        </section>
      );
    }
    if (error.statusCode === 409) {
      return (
        <section className="panel panel--warn" role="alert">
          <h2>The API cannot do this now</h2>
          <ProblemList messages={messages} />
        </section>
      );
    }
    if (error.statusCode === 404) {
      return (
        <section className="panel panel--warn" role="alert">
          <h2>Not found</h2>
          <ProblemList messages={messages} />
        </section>
      );
    }
    return (
      <section className="panel panel--bad" role="alert">
        <h2>The API failed ({error.statusCode})</h2>
        <ProblemList messages={messages} />
      </section>
    );
  }
  if (error instanceof ResponseShapeError) {
    return (
      <section className="panel panel--bad" role="alert">
        <h2>Unexpected response from the API</h2>
        <p>The API answered, but not with what this version of the web UI expects. The request may have been accepted: check the history before sending it again.</p>
        <ProblemList messages={error.issues} />
      </section>
    );
  }
  return (
    <section className="panel panel--bad" role="alert">
      <h2>Something went wrong</h2>
      <p>{describeFailure(error)}</p>
    </section>
  );
}
