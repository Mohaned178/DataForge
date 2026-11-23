import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../api/client';
import type { DocumentCheck, DocumentKind, DocumentVersionSummary } from '../documents/kinds';
import { useSubmit } from '../hooks/use-submit';
import { formatJson, parseJsonText } from '../lib/json-text';
import { ProblemList, SubmitError } from './Problems';

/** How long the text must rest before the API is asked to check it. */
export const CHECK_DELAY_MS = 400;

interface Props {
  readonly kind: DocumentKind;
  /** Set to add a version to this document; absent to create a new one. */
  readonly target?: { readonly id: string; readonly name: string };
  readonly initialText: string;
  /** The versions that exist, to say in advance that a document is identical to one of them. */
  readonly versions?: readonly DocumentVersionSummary[];
}

/** The API's answer for the text it was asked about: stored with that text, so a stale answer is never read as current. */
type Checked = { readonly forText: string; readonly data: DocumentCheck } | { readonly forText: string; readonly error: unknown };

function blankDocument(kind: DocumentKind): string {
  return formatJson({ formatVersion: 1, name: `my-${kind.id}` });
}

/**
 * A JSON text editor for a scenario or a chaos profile. The browser checks the syntax (with the line and
 * column of a mistake); the API checks everything else with the very schema that saving uses (a dry run that
 * stores nothing), so the problems listed are exactly the ones a save would give. Save is enabled only for
 * text the API has just accepted.
 */
export function DocumentEditor({ kind, target, initialText, versions = [] }: Props) {
  const navigate = useNavigate();
  const [text, setText] = useState(initialText);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [identical, setIdentical] = useState<{ readonly forText: string; readonly version: number } | null>(null);
  const parsed = useMemo(() => parseJsonText(text), [text]);

  useEffect(() => {
    if (!parsed.ok) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      kind.check(parsed.value, controller.signal).then(
        (data) => {
          if (!controller.signal.aborted) setChecked({ forText: text, data });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setChecked({ forText: text, error });
        },
      );
    }, CHECK_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, parsed, text]);

  const current = checked !== null && checked.forText === text ? checked : null;
  const accepted = current !== null && 'data' in current ? current.data : null;
  const sameAs = accepted === null ? undefined : versions.find((version) => version.hash === accepted.hash);

  const saving = useSubmit(async () => {
    if (!parsed.ok) return;
    if (target === undefined) {
      const created = await kind.create(parsed.value);
      await navigate(`${kind.route}/${created.id}?saved=1`);
      return;
    }
    const { status, data } = await kind.addVersion(target.id, parsed.value);
    if (status === 201) {
      await navigate(`${kind.route}/${target.id}?saved=${data.version}`);
    } else {
      setIdentical({ forText: text, version: data.version });
    }
  });

  const heading = target === undefined ? `New ${kind.noun}` : `New version of ${target.name}`;
  const showIdentical = identical !== null && identical.forText === text;

  return (
    <>
      <h1>{heading}</h1>
      <p className="lede">
        {target === undefined
          ? `Write the ${kind.noun} as JSON, the same file the command line takes, or start from an example.`
          : `Change the ${kind.noun} and save it as its next version. Versions are never edited: a changed document is a new version, an identical one is the version that exists.`}
      </p>

      <div className="editor">
        <div className="editor__bar">
          {target === undefined ? (
            <label className="field">
              <span>Start from</span>
              <select
                value=""
                onChange={(event) => {
                  const template = kind.templates.find((candidate) => candidate.name === event.target.value);
                  setText(template === undefined ? blankDocument(kind) : template.text);
                }}
              >
                <option value="">Choose&hellip;</option>
                <option value="__blank__">A blank document</option>
                {kind.templates.map((template) => (
                  <option key={template.name} value={template.name}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            disabled={!parsed.ok}
            onClick={() => {
              if (parsed.ok) setText(formatJson(parsed.value));
            }}
          >
            Format
          </button>
        </div>

        <label className="field field--wide">
          <span>Document (JSON)</span>
          <textarea
            className="editor__text"
            spellCheck={false}
            rows={22}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            aria-describedby="editor-status"
          />
        </label>

        <div id="editor-status" aria-live="polite">
          {!parsed.ok ? (
            <p className="panel panel--warn" role="alert">
              <strong>Not valid JSON.</strong> {parsed.message}
              {parsed.line !== undefined && parsed.column !== undefined ? ` (line ${parsed.line}, column ${parsed.column})` : ''}
            </p>
          ) : current === null ? (
            <p className="muted" role="status">
              Checking with the API&hellip;
            </p>
          ) : 'error' in current ? (
            current.error instanceof ApiError && current.error.statusCode === 400 ? (
              <section className="panel panel--warn" role="alert">
                <h2>
                  {current.error.messages.length === 1 ? '1 problem' : `${current.error.messages.length} problems`} in the {kind.noun}
                </h2>
                <p>The API checked it with the schema saving uses. Nothing is saved until it accepts the document.</p>
                <ProblemList messages={current.error.messages} />
              </section>
            ) : (
              <SubmitError error={current.error} what={`the ${kind.noun}`} />
            )
          ) : (
            <section className="panel panel--good" role="status">
              <h2>Valid</h2>
              <p>
                The API accepts this {kind.noun}: <strong>{current.data.name}</strong>, hash <code title={current.data.hash}>{current.data.hash.slice(0, 19)}&hellip;</code>.
              </p>
              {sameAs !== undefined ? (
                <p>
                  It is identical to <strong>version {sameAs.version}</strong>: saving returns that version and stores nothing new.
                </p>
              ) : null}
              <details>
                <summary>The resolved definition (every default filled in)</summary>
                <pre>{formatJson(current.data.definition)}</pre>
              </details>
            </section>
          )}
        </div>

        {showIdentical ? (
          <p className="panel panel--info" role="status">
            This document is identical to version {identical.version}, so nothing new was stored.{' '}
            {target !== undefined ? <Link to={`${kind.route}/${target.id}`}>Open the {kind.noun}</Link> : null}
          </p>
        ) : null}
        <SubmitError error={saving.error} what={`the ${kind.noun}`} />

        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={accepted === null || saving.pending}
            onClick={() => {
              void saving.submit();
            }}
          >
            {saving.pending ? 'Saving…' : target === undefined ? `Save as a new ${kind.noun}` : 'Save as a new version'}
          </button>
          <Link to={target === undefined ? kind.route : `${kind.route}/${target.id}`}>Cancel</Link>
        </div>
      </div>
    </>
  );
}
