import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, writes } from '../../api/endpoints';
import type { Run } from '../../api/schemas';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Field } from '../../components/Field';
import { ProblemList, SubmitError } from '../../components/Problems';
import { useResource } from '../../hooks/use-resource';
import { useSubmit } from '../../hooks/use-submit';
import { buildExecutionRequest, buildRunRequest, type ExecutionForm, type TargetChoice, type Transport } from '../../lib/launch';
import { paramOf } from '../../lib/query';
import { shortId } from '../../lib/format';

/** One radio button whose name is its label alone; the hint is read after it (aria-describedby), not as part of the name. */
function Choice({ name, value, checked, label, hint, onSelect }: { name: string; value: string; checked: boolean; label: string; hint: string; onSelect: () => void }) {
  const id = useId();
  return (
    <div className="choice">
      <input id={id} type="radio" name={name} value={value} checked={checked} aria-describedby={`${id}-hint`} onChange={onSelect} />
      <div>
        <label htmlFor={id}>{label}</label> <small id={`${id}-hint`} className="hint">{hint}</small>
      </div>
    </div>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="muted">
      Loading {what}&hellip;
    </p>
  );
}

/** `/runs/new`: generate a world. `?scenarioId=` preselects the scenario. */
export function NewRunPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const scenarios = useResource('launch:scenarios', (signal) => api.scenarios(signal));
  const [chosenScenario, setChosenScenario] = useState<string | undefined>(undefined);
  const [version, setVersion] = useState('');
  const [seed, setSeed] = useState('');
  const [problems, setProblems] = useState<readonly string[]>([]);

  const scenarioId = chosenScenario ?? paramOf(params, 'scenarioId') ?? scenarios.data?.scenarios[0]?.id ?? '';
  const detail = useResource(`launch:scenario:${scenarioId}`, (signal) => (scenarioId === '' ? Promise.resolve(null) : api.scenario(scenarioId, signal)));

  const launching = useSubmit(async () => {
    const built = buildRunRequest({ scenarioId, version, seed });
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    setProblems([]);
    const { data } = await writes.startRun(built.request);
    await navigate(`/runs/${data.id}`);
  });

  if (scenarios.status === 'error') return <ErrorPanel error={scenarios.error} what="the scenarios" onRetry={scenarios.reload} />;
  if (scenarios.data === undefined) return <Loading what="the scenarios" />;

  if (scenarios.data.scenarios.length === 0) {
    return (
      <>
        <h1>New run</h1>
        <p className="empty">
          A run needs a scenario. <Link to="/scenarios/new">Create one first</Link>, from scratch or from an example.
        </p>
      </>
    );
  }

  const versions = detail.data?.versions ?? [];
  return (
    <>
      <h1>New run</h1>
      <p className="lede">
        Generate a world: one scenario version simulated with one seed. The same scenario version and seed always give the same events, byte for byte.
      </p>
      <form
        className="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void launching.submit();
        }}
      >
        <label className="field">
          <span>Scenario</span>
          <select
            value={scenarioId}
            onChange={(event) => {
              setChosenScenario(event.target.value);
              setVersion('');
            }}
          >
            {scenarios.data.scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Version</span>
          <select
            value={version}
            onChange={(event) => {
              setVersion(event.target.value);
            }}
          >
            <option value="">Latest{detail.data ? ` (v${detail.data.latestVersion})` : ''}</option>
            {[...versions].reverse().map((candidate) => (
              <option key={candidate.version} value={String(candidate.version)}>
                v{candidate.version}
              </option>
            ))}
          </select>
        </label>
        <Field label="Seed" hint="Any text or whole number. It is sent exactly as typed.">
          {(control) => (
            <input
              {...control}
              type="text"
              value={seed}
              placeholder="42"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setSeed(event.target.value);
              }}
            />
          )}
        </Field>

        {problems.length > 0 ? (
          <section className="panel panel--warn" role="alert">
            <h2>Complete the form</h2>
            <ProblemList messages={problems} />
          </section>
        ) : null}
        <SubmitError error={launching.error} what="the run" />
        <div className="button-row">
          <button type="submit" className="primary" disabled={launching.pending}>
            {launching.pending ? 'Starting…' : 'Start run'}
          </button>
          <Link to="/runs">Cancel</Link>
        </div>
      </form>
    </>
  );
}

const INITIAL_EXECUTION: Omit<ExecutionForm, 'runId' | 'profileId'> = {
  profileVersion: '',
  chaosSeed: '',
  target: 'correct',
  transport: 'memory',
  partitions: '',
  speed: '',
  timeoutSeconds: '',
  topic: '',
  groupId: '',
};

function runLabel(run: Run): string {
  return `${run.scenario.name} v${run.scenario.version} · seed ${run.seed} · ${shortId(run.id)}${run.status === 'succeeded' ? '' : ` · ${run.status}`}`;
}

/** `/executions/new`: test a world under a chaos profile. `?runId=` and `?chaosProfileId=` preselect. */
export function NewExecutionPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requestedRunId = paramOf(params, 'runId');
  const runs = useResource(`launch:runs:${requestedRunId ?? ''}`, async (signal) => {
    const succeeded = (await api.runs({ status: 'succeeded', limit: 200 }, signal)).runs;
    // A run that is not ready can still be asked for by link: the form lists it, and the API says why it cannot be used yet.
    if (requestedRunId === undefined || succeeded.some((run) => run.id === requestedRunId)) return succeeded;
    return [await api.run(requestedRunId, signal), ...succeeded];
  });
  const profiles = useResource('launch:chaos-profiles', (signal) => api.chaosProfiles(signal));
  const [form, setForm] = useState<Omit<ExecutionForm, 'runId' | 'profileId'>>(INITIAL_EXECUTION);
  const [chosenRun, setChosenRun] = useState<string | undefined>(undefined);
  const [chosenProfile, setChosenProfile] = useState<string | undefined>(undefined);
  const [problems, setProblems] = useState<readonly string[]>([]);

  const runId = chosenRun ?? requestedRunId ?? runs.data?.[0]?.id ?? '';
  const profileId = chosenProfile ?? paramOf(params, 'chaosProfileId') ?? profiles.data?.chaosProfiles[0]?.id ?? '';
  const profile = useResource(`launch:chaos-profile:${profileId}`, (signal) => (profileId === '' ? Promise.resolve(null) : api.chaosProfile(profileId, signal)));
  const set = <K extends keyof typeof form>(name: K, value: (typeof form)[K]) => {
    setForm((previous) => ({ ...previous, [name]: value }));
  };

  const launching = useSubmit(async () => {
    const built = buildExecutionRequest({ ...form, runId, profileId });
    if (!built.ok) {
      setProblems(built.problems);
      return;
    }
    setProblems([]);
    const { data } = await writes.startExecution(built.request);
    await navigate(`/executions/${data.id}`);
  });

  if (runs.status === 'error') return <ErrorPanel error={runs.error} what="the runs" onRetry={runs.reload} />;
  if (profiles.status === 'error') return <ErrorPanel error={profiles.error} what="the chaos profiles" onRetry={profiles.reload} />;
  if (runs.data === undefined || profiles.data === undefined) return <Loading what="the runs and chaos profiles" />;

  if (runs.data.length === 0 || profiles.data.chaosProfiles.length === 0) {
    return (
      <>
        <h1>New execution</h1>
        <p className="empty">
          An execution needs a run that has succeeded and a chaos profile.{' '}
          {runs.data.length === 0 ? <Link to="/runs/new">Start a run</Link> : null}
          {runs.data.length === 0 && profiles.data.chaosProfiles.length === 0 ? ' and ' : null}
          {profiles.data.chaosProfiles.length === 0 ? <Link to="/chaos-profiles/new">create a chaos profile</Link> : null}.
        </p>
      </>
    );
  }

  const versions = profile.data?.versions ?? [];
  const kafkaOptions = form.target === 'external' || form.transport === 'kafka';
  return (
    <>
      <h1>New execution</h1>
      <p className="lede">
        Deliver a world under a chaos profile to a target, then validate what the target ended up with. One run, one profile, one chaos seed, one target.
      </p>
      <form
        className="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void launching.submit();
        }}
      >
        <label className="field">
          <span>Run</span>
          <select
            value={runId}
            onChange={(event) => {
              setChosenRun(event.target.value);
            }}
          >
            {runs.data.map((run) => (
              <option key={run.id} value={run.id}>
                {runLabel(run)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Chaos profile</span>
          <select
            value={profileId}
            onChange={(event) => {
              setChosenProfile(event.target.value);
              set('profileVersion', '');
            }}
          >
            {profiles.data.chaosProfiles.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Profile version</span>
          <select
            value={form.profileVersion}
            onChange={(event) => {
              set('profileVersion', event.target.value);
            }}
          >
            <option value="">Latest{profile.data ? ` (v${profile.data.latestVersion})` : ''}</option>
            {[...versions].reverse().map((candidate) => (
              <option key={candidate.version} value={String(candidate.version)}>
                v{candidate.version}
              </option>
            ))}
          </select>
        </label>
        <Field label="Chaos seed" hint="Independent of the run's seed: one world, many fault patterns. Sent exactly as typed.">
          {(control) => (
            <input
              {...control}
              type="text"
              value={form.chaosSeed}
              placeholder="7"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                set('chaosSeed', event.target.value);
              }}
            />
          )}
        </Field>

        <fieldset className="field-group">
          <legend>Target</legend>
          {(
            [
              ['correct', 'Reference target: correct', 'idempotent and order-aware; it should pass unless events are lost or late'],
              ['naive', 'Reference target: naive', 'assumes perfect delivery; it shows what duplicates and reordering do'],
              ['external', 'Your own pipeline', 'DataForge produces to your Kafka topic and you submit the state it ends in'],
            ] as readonly (readonly [TargetChoice, string, string])[]
          ).map(([value, label, hint]) => (
            <Choice
              key={value}
              name="target"
              value={value}
              checked={form.target === value}
              label={label}
              hint={hint}
              onSelect={() => {
                set('target', value);
              }}
            />
          ))}
          {form.target !== 'external' ? (
            <label className="field">
              <span>Transport</span>
              <select
                value={form.transport}
                onChange={(event) => {
                  set('transport', event.target.value as Transport);
                }}
              >
                <option value="memory">In memory (offline, instant)</option>
                <option value="kafka">Through Kafka (a real broker and a consumer process)</option>
              </select>
            </label>
          ) : (
            <>
              <Field label="Topic" hint="Your pipeline's input topic. It must already exist.">
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    value={form.topic}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      set('topic', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Consumer group" hint="It must be running, with no lag, before DataForge sends the first record.">
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    value={form.groupId}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => {
                      set('groupId', event.target.value);
                    }}
                  />
                )}
              </Field>
            </>
          )}
          {kafkaOptions ? (
            <>
              {form.target !== 'external' ? (
                <label className="field">
                  <span>Partitions</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={form.partitions}
                    placeholder="1"
                    onChange={(event) => {
                      set('partitions', event.target.value);
                    }}
                  />
                </label>
              ) : null}
              <Field label="Speed" hint={'"max" sends as fast as possible; a number plays the plan in compressed real time (simulated ms per real ms).'}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    value={form.speed}
                    placeholder="max"
                    onChange={(event) => {
                      set('speed', event.target.value);
                    }}
                  />
                )}
              </Field>
              <label className="field">
                <span>Timeout (seconds)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.timeoutSeconds}
                  placeholder="60"
                  onChange={(event) => {
                    set('timeoutSeconds', event.target.value);
                  }}
                />
              </label>
            </>
          ) : null}
        </fieldset>

        {problems.length > 0 ? (
          <section className="panel panel--warn" role="alert">
            <h2>Complete the form</h2>
            <ProblemList messages={problems} />
          </section>
        ) : null}
        <SubmitError error={launching.error} what="the execution" />
        <div className="button-row">
          <button type="submit" className="primary" disabled={launching.pending}>
            {launching.pending ? 'Starting…' : 'Start execution'}
          </button>
          <Link to="/executions">Cancel</Link>
        </div>
      </form>
    </>
  );
}
