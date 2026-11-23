import { useState } from 'react';
import { writes } from '../api/endpoints';
import type { Execution } from '../api/schemas';
import { useSubmit } from '../hooks/use-submit';
import { ProblemList, SubmitError } from './Problems';

/** A file the user chose, parsed as JSON; a syntax error is reported against the file's own name. */
async function readJsonFile(file: File, label: string): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string }> {
  try {
    return { ok: true, value: JSON.parse(await file.text()) as unknown };
  } catch (error) {
    return { ok: false, problem: `${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

interface Props {
  readonly execution: Execution;
  /** Called once the API has accepted the state: the page loads the finished execution. */
  readonly onSubmitted: () => void;
}

/**
 * What an external pipeline ended up with, handed to the API from the browser. Only the JSON syntax is
 * checked here; the contract (actual-state.json and actual-windows.json, data-formats.md) is the API's, which
 * lists every problem with its path and changes nothing when it refuses.
 */
export function ExternalSubmission({ execution, onSubmitted }: Props) {
  const [stateFile, setStateFile] = useState<File | null>(null);
  const [windowsFile, setWindowsFile] = useState<File | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const windowed = execution.delivery?.windowing !== undefined;

  const submission = useSubmit(async () => {
    if (stateFile === null) return;
    const found: string[] = [];
    const state = await readJsonFile(stateFile, 'actual-state.json');
    const windows = windowsFile === null ? null : await readJsonFile(windowsFile, 'actual-windows.json');
    if (!state.ok) found.push(state.problem);
    if (windows !== null && !windows.ok) found.push(windows.problem);
    setProblems(found);
    if (!state.ok || (windows !== null && !windows.ok)) return;
    await writes.submitActualState(execution.id, { actualState: state.value, ...(windows === null || !windows.ok ? {} : { actualWindows: windows.value }) });
    onSubmitted();
  });

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void submission.submit();
      }}
    >
      <h3>Submit the pipeline&apos;s final state</h3>
      <label className="field">
        <span>actual-state.json</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            setStateFile(event.target.files?.[0] ?? null);
          }}
        />
      </label>
      <label className="field">
        <span>actual-windows.json {windowed ? '(this profile has windows: required)' : '(only for a windowed profile)'}</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            setWindowsFile(event.target.files?.[0] ?? null);
          }}
        />
      </label>
      {problems.length > 0 ? (
        <section className="panel panel--warn" role="alert">
          <h2>These files cannot be sent</h2>
          <ProblemList messages={problems} />
        </section>
      ) : null}
      <SubmitError error={submission.error} what="the state" />
      <div className="button-row">
        <button type="submit" className="primary" disabled={stateFile === null || submission.pending}>
          {submission.pending ? 'Submitting…' : 'Submit and validate'}
        </button>
      </div>
    </form>
  );
}
