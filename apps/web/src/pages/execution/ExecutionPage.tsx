import { Link, useParams } from 'react-router';
import { api } from '../../api/endpoints';
import type { Execution } from '../../api/schemas';
import { StatusBadge, VerdictBadge } from '../../components/Badges';
import { Facts, Section } from '../../components/Controls';
import { ExternalSubmission } from '../../components/ExternalSubmission';
import { RefreshNotice } from '../../components/RefreshNotice';
import { ResourceView } from '../../components/ResourceView';
import { useLiveResource } from '../../hooks/use-live-resource';
import { useNow } from '../../hooks/use-now';
import { formatCount, formatSpan, formatTimestamp, formatWaited, shortId } from '../../lib/format';
import { describeTarget } from '../../lib/target';
import { DeliverySection } from './DeliverySection';
import { FindingsSection, WindowFindingsSection } from './FindingsSection';
import { ValidationSection } from './ValidationSection';

/** An execution that has not ended is still moving: this page follows it until it does. */
export function isExecutionLive(execution: Execution): boolean {
  return execution.status === 'queued' || execution.status === 'running';
}

function Waiting({ execution }: { execution: Execution }) {
  const now = useNow(true);
  const waited = Math.max(0, now - Date.parse(execution.requestedAt));
  return (
    <p role="status" className="panel panel--info">
      This execution is {execution.status}: waiting for {formatWaited(waited)}. DataForge runs one execution at a time in the
      background, and this page updates by itself until it ends.
    </p>
  );
}

function StatusNotice({ execution, onSubmitted }: { execution: Execution; onSubmitted: () => void }) {
  switch (execution.status) {
    case 'queued':
    case 'running':
      return <Waiting execution={execution} />;
    case 'awaiting_actual_state':
      return (
        <div role="status" className="panel panel--info">
          <p>
            <strong>Waiting for the pipeline&apos;s final state.</strong> DataForge delivered the plan to{' '}
            {execution.target.type === 'external' ? (
              <>
                topic <code>{execution.target.topic}</code> and saw consumer group <code>{execution.target.groupId}</code> reach zero lag.
              </>
            ) : (
              'the target.'
            )}{' '}
            It now needs what the pipeline ended up with.
          </p>
          <p>
            Choose the files your pipeline wrote below, or submit them with <code>POST /executions/{execution.id}/actual-state</code> and the body{' '}
            <code>{'{ "actualState": …, "actualWindows": … }'}</code> (the contents of <code>actual-state.json</code>, and <code>actual-windows.json</code>{' '}
            for a windowed profile). The report appears here once it is validated.
          </p>
          <ExternalSubmission execution={execution} onSubmitted={onSubmitted} />
        </div>
      );
    case 'failed':
      return (
        <div role="alert" className="panel panel--bad">
          <h2>This execution could not complete</h2>
          <p>{execution.error ?? 'No reason was recorded.'}</p>
          <p className="muted">A failed execution has no verdict: it says nothing about the target. Start another one to test again.</p>
        </div>
      );
    case 'completed':
      return null;
  }
}

function FilesSection({ execution }: { execution: Execution }) {
  const files = Object.entries(execution.files);
  if (files.length === 0) return null;
  return (
    <Section title="Files">
      <p className="muted">
        The exact bytes the command line writes for the same inputs. Each is rebuilt from the database and checked against the checksum recorded
        when it was made.
      </p>
      <table>
        <caption className="sr-only">Files of the execution, with checksums</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col" className="num">
              Bytes
            </th>
            <th scope="col">SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {files.map(([name, entry]) => (
            <tr key={name}>
              <td>
                <a href={api.executionFileUrl(execution.id, name)} download={name}>
                  {name}
                </a>
              </td>
              <td className="num">{formatCount(entry.bytes)}</td>
              <td>
                <code title={entry.sha256}>{entry.sha256.slice(0, 16)}&hellip;</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

export function ExecutionPage() {
  const { executionId = '' } = useParams();
  const resource = useLiveResource(`execution:${executionId}`, (signal) => api.execution(executionId, signal), isExecutionLive);

  return (
    <>
      <p className="crumbs">
        <Link to="/executions">Executions</Link> / <code>{shortId(executionId)}</code>
      </p>
      <h1>Execution</h1>
      <RefreshNotice error={resource.refreshError} />
      <ResourceView resource={resource} what="this execution">
        {(execution) => (
          <>
            <Section title="Summary">
              <Facts
                items={[
                  { label: 'Status', value: <StatusBadge status={execution.status} /> },
                  { label: 'Verdict', value: <VerdictBadge verdict={execution.verdict} /> },
                  {
                    label: 'Run',
                    value: (
                      <>
                        <Link to={`/runs/${execution.run.id}`}>{execution.run.scenario.name}</Link> v{execution.run.scenario.version}, seed{' '}
                        <code>{execution.run.seed}</code>
                      </>
                    ),
                  },
                  {
                    label: 'Chaos profile',
                    value: (
                      <>
                        {execution.chaosProfile.name} v{execution.chaosProfile.version}{' '}
                        <code title={execution.chaosProfile.profileHash}>{execution.chaosProfile.profileHash.slice(0, 15)}&hellip;</code>
                      </>
                    ),
                  },
                  { label: 'Chaos seed', value: <code>{execution.chaosSeed}</code> },
                  { label: 'Target', value: describeTarget(execution.target) },
                  { label: 'Planner version', value: execution.plannerVersion },
                  { label: 'Requested', value: formatTimestamp(execution.requestedAt) },
                  { label: 'Started', value: formatTimestamp(execution.startedAt) },
                  { label: 'Delivered', value: formatTimestamp(execution.deliveredAt) },
                  { label: 'Finished', value: formatTimestamp(execution.finishedAt) },
                  { label: 'Took', value: formatSpan(execution.startedAt, execution.finishedAt) },
                ]}
              />
              <StatusNotice execution={execution} onSubmitted={resource.reload} />
            </Section>

            <DeliverySection execution={execution} />

            {execution.status === 'completed' ? (
              <>
                <ValidationSection executionId={execution.id} />
                <FindingsSection executionId={execution.id} total={execution.findingCount ?? 0} />
                {execution.windowFindingCount !== null ? (
                  <WindowFindingsSection executionId={execution.id} total={execution.windowFindingCount} />
                ) : null}
              </>
            ) : null}

            <FilesSection execution={execution} />
          </>
        )}
      </ResourceView>
    </>
  );
}
