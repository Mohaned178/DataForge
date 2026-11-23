import { Fragment } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../../api/endpoints';
import { FINDING_CATEGORIES, ENTITY_TYPES, WINDOW_FINDING_CATEGORIES } from '../../api/schemas';
import { Tag } from '../../components/Badges';
import { FilterChip, FilterSelect, Pager, Section } from '../../components/Controls';
import { ResourceView } from '../../components/ResourceView';
import { useResource } from '../../hooks/use-resource';
import { formatSimTime } from '../../lib/format';
import { PAGE_SIZE, offsetOf, paramOf, wholeParamOf, withParams } from '../../lib/query';
import { FindingDetail, WindowFindingDetail } from './FindingDetail';

function OpenButton({ ordinal, openParam, open, label }: { ordinal: number; openParam: string; open: boolean; label: string }) {
  const [params, setParams] = useSearchParams();
  return (
    <button
      type="button"
      className="link-button"
      aria-expanded={open}
      aria-controls={`${openParam}-${ordinal}`}
      aria-label={`${open ? 'Hide' : 'Show'} ${label}`}
      onClick={() => {
        setParams(withParams(params, { [openParam]: open ? undefined : String(ordinal) }, null), { replace: true });
      }}
    >
      {open ? '▾' : '▸'} {ordinal + 1}
    </button>
  );
}

export function FindingsSection({ executionId, total }: { executionId: string; total: number }) {
  const [params] = useSearchParams();
  const category = paramOf(params, 'category');
  const entityType = paramOf(params, 'entityType');
  const entityId = paramOf(params, 'entityId');
  const offset = offsetOf(params);
  const open = wholeParamOf(params, 'open');
  const resource = useResource(`findings:${executionId}:${[category, entityType, entityId, offset].join('|')}`, (signal) =>
    api.findings(executionId, { category, entityType, entityId, limit: PAGE_SIZE, offset }, signal),
  );

  return (
    <Section title="Findings" id="findings">
      <div className="filters">
        <FilterSelect label="Category" name="category" options={FINDING_CATEGORIES} />
        <FilterSelect label="Entity type" name="entityType" options={ENTITY_TYPES} />
        {entityId ? <FilterChip label="Entity" name="entityId" value={entityId} /> : null}
      </div>
      <ResourceView resource={resource} what="the findings">
        {(list) =>
          list.findings.length === 0 ? (
            <p className="empty">{total === 0 ? 'No findings: the target ended in the expected state.' : 'No findings match these filters.'}</p>
          ) : (
            <>
              <table className="findings">
                <caption className="sr-only">Findings, in report order. Open one to see its differences and causes.</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Category</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Message</th>
                    <th scope="col">Cause</th>
                  </tr>
                </thead>
                <tbody>
                  {list.findings.map((finding) => {
                    const isOpen = open === finding.ordinal;
                    return (
                      <Fragment key={finding.ordinal}>
                        <tr className={isOpen ? 'is-open' : undefined}>
                          <td>
                            <OpenButton ordinal={finding.ordinal} openParam="open" open={isOpen} label={`finding ${finding.ordinal + 1}: ${finding.entityId}`} />
                          </td>
                          <td>
                            <Tag tone="bad">{finding.category}</Tag>
                          </td>
                          <td>
                            <span className="muted">{finding.entityType}</span> <code>{finding.entityId}</code>
                          </td>
                          <td>{finding.message}</td>
                          <td>
                            {finding.causes.length === 0 ? <Tag tone="warn">not explained by delivery</Tag> : <span>{finding.causes.length} delivery cause{finding.causes.length === 1 ? '' : 's'}</span>}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="detail-row" id={`open-${finding.ordinal}`}>
                            <td colSpan={5}>
                              <FindingDetail finding={finding} executionId={executionId} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <Pager total={list.total} limit={list.limit} offset={list.offset} />
            </>
          )
        }
      </ResourceView>
    </Section>
  );
}

export function WindowFindingsSection({ executionId, total }: { executionId: string; total: number }) {
  const [params] = useSearchParams();
  const category = paramOf(params, 'wcategory');
  const offset = wholeParamOf(params, 'woffset') ?? 0;
  const open = wholeParamOf(params, 'wopen');
  const resource = useResource(`window-findings:${executionId}:${[category, offset].join('|')}`, (signal) =>
    api.windowFindings(executionId, { category, limit: PAGE_SIZE, offset }, signal),
  );

  return (
    <Section title="Window findings" id="window-findings">
      <div className="filters">
        <FilterSelect label="Category" name="wcategory" options={WINDOW_FINDING_CATEGORIES} offsetParam="woffset" />
      </div>
      <ResourceView resource={resource} what="the window findings">
        {(list) =>
          list.findings.length === 0 ? (
            <p className="empty">{total === 0 ? 'No window findings: every window was counted correctly.' : 'No window findings match this filter.'}</p>
          ) : (
            <>
              <table className="findings">
                <caption className="sr-only">Window findings, in report order. Open one to see its differences and the events behind it.</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Category</th>
                    <th scope="col">Window</th>
                    <th scope="col">Message</th>
                    <th scope="col">Cause</th>
                  </tr>
                </thead>
                <tbody>
                  {list.findings.map((finding) => {
                    const isOpen = open === finding.ordinal;
                    return (
                      <Fragment key={finding.ordinal}>
                        <tr className={isOpen ? 'is-open' : undefined}>
                          <td>
                            <OpenButton ordinal={finding.ordinal} openParam="wopen" open={isOpen} label={`window finding ${finding.ordinal + 1}`} />
                          </td>
                          <td>
                            <Tag tone="bad">{finding.category}</Tag>
                          </td>
                          <td>
                            <code>
                              {formatSimTime(finding.windowStartMs)} &ndash; {formatSimTime(finding.windowEndMs)}
                            </code>
                          </td>
                          <td>{finding.message}</td>
                          <td>
                            {finding.causes.length === 0 ? <Tag tone="warn">not explained by delivery</Tag> : <span>{finding.causes.length} event{finding.causes.length === 1 ? '' : 's'}</span>}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="detail-row" id={`wopen-${finding.ordinal}`}>
                            <td colSpan={5}>
                              <WindowFindingDetail finding={finding} executionId={executionId} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <Pager total={list.total} limit={list.limit} offset={list.offset} param="woffset" />
            </>
          )
        }
      </ResourceView>
    </Section>
  );
}
