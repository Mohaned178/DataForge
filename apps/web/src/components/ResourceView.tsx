import type { ReactNode } from 'react';
import type { Resource } from '../hooks/use-resource';
import { ErrorPanel } from './ErrorPanel';

interface Props<T> {
  readonly resource: Resource<T>;
  /** What is being loaded ("the run history"), for the loading text and the error panel. */
  readonly what: string;
  readonly children: (data: T) => ReactNode;
}

/** Shows the loading state, the failure, or the data; previous data stays visible while a reload is in flight. */
export function ResourceView<T>({ resource, what, children }: Props<T>) {
  if (resource.status === 'error') return <ErrorPanel error={resource.error} what={what} onRetry={resource.reload} />;
  if (resource.data === undefined) {
    return (
      <p role="status" className="muted">
        Loading {what}&hellip;
      </p>
    );
  }
  return (
    <div aria-busy={resource.status === 'loading'} className={resource.status === 'loading' ? 'is-refreshing' : undefined}>
      {children(resource.data)}
    </div>
  );
}
