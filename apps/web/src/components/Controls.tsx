import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { withParams } from '../lib/query';

interface FilterSelectProps {
  readonly label: string;
  readonly name: string;
  readonly options: readonly string[];
  /** The paging parameter of the list this filter belongs to; a new filter returns it to the first page. */
  readonly offsetParam?: string;
}

export function FilterSelect({ label, name, options, offsetParam = 'offset' }: FilterSelectProps) {
  const [params, setParams] = useSearchParams();
  return (
    <label className="field">
      <span>{label}</span>
      <select
        value={params.get(name) ?? ''}
        onChange={(event) => {
          setParams(withParams(params, { [name]: event.target.value }, offsetParam));
        }}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A filter set by a link (a run, a chaos profile): shown as a chip that removes it. */
export function FilterChip({ label, name, value, offsetParam = 'offset' }: { label: string; name: string; value: string; offsetParam?: string }) {
  const [params] = useSearchParams();
  return (
    <span className="chip">
      {label} <code>{value}</code>
      <Link to={{ search: withParams(params, { [name]: undefined }, offsetParam).toString() }} aria-label={`Remove the ${label} filter`}>
        &times;
      </Link>
    </span>
  );
}

interface PagerProps {
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** The name of the query parameter holding the offset ("offset" unless a page has several lists). */
  readonly param?: string;
}

/** Previous and next links over an offset-paged list; the offset lives in the URL. */
export function Pager({ total, limit, offset, param = 'offset' }: PagerProps) {
  const [params] = useSearchParams();
  if (total === 0) return null;
  const first = offset + 1;
  const last = Math.min(offset + limit, total);
  const to = (value: number) => ({ search: withParams(params, { [param]: value === 0 ? undefined : String(value) }, param).toString() });
  return (
    <nav className="pager" aria-label="Pages">
      <span>
        Showing {first}&ndash;{last} of {total}
      </span>
      {offset > 0 ? <Link to={to(Math.max(0, offset - limit))}>Previous</Link> : <span className="pager__off">Previous</span>}
      {offset + limit < total ? <Link to={to(offset + limit)}>Next</Link> : <span className="pager__off">Next</span>}
    </nav>
  );
}

export function Section({ title, id, children, aside }: { title: string; id?: string; children: ReactNode; aside?: ReactNode }) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section className="section" {...(id ? { id, 'aria-labelledby': headingId } : {})}>
      <div className="section__head">
        <h2 {...(headingId ? { id: headingId } : {})}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Facts({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
