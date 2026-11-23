import { Link, useParams, useSearchParams } from 'react-router';
import { DocumentEditor } from '../../components/DocumentEditor';
import { Facts, Section } from '../../components/Controls';
import { ResourceView } from '../../components/ResourceView';
import { useResource } from '../../hooks/use-resource';
import type { DocumentKind } from '../../documents/kinds';
import { formatTimestamp, shortId } from '../../lib/format';
import { formatJson } from '../../lib/json-text';
import { wholeParamOf } from '../../lib/query';

/** `/scenarios` and `/chaos-profiles`: the documents, by name. */
export function DocumentListPage({ kind }: { kind: DocumentKind }) {
  const resource = useResource(`documents:${kind.id}`, (signal) => kind.list(signal));
  return (
    <>
      <div className="title-row">
        <h1>{kind.title}</h1>
        <Link className="button primary" to={`${kind.route}/new`}>
          New {kind.noun}
        </Link>
      </div>
      <p className="lede">
        {kind.id === 'scenario'
          ? 'Business worlds to simulate. A scenario never changes: a changed document is a new version.'
          : 'Fault configurations to deliver a world under. A profile never changes: a changed document is a new version.'}
      </p>
      <ResourceView resource={resource} what={`the ${kind.plural}`}>
        {(documents) =>
          documents.length === 0 ? (
            <p className="empty">
              No {kind.plural} yet. <Link to={`${kind.route}/new`}>Create the first one</Link>, from scratch or from an example.
            </p>
          ) : (
            <table>
              <caption className="sr-only">{kind.title}, by name</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="num">
                    Latest version
                  </th>
                  <th scope="col">Created</th>
                  <th scope="col">Id</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <Link to={`${kind.route}/${document.id}`}>{document.name}</Link>
                    </td>
                    <td className="num">v{document.latestVersion}</td>
                    <td>{formatTimestamp(document.createdAt)}</td>
                    <td>
                      <code title={document.id}>{shortId(document.id)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </ResourceView>
    </>
  );
}

function VersionDefinition({ kind, id, version }: { kind: DocumentKind; id: string; version: number }) {
  const resource = useResource(`document-version:${kind.id}:${id}:${version}`, (signal) => kind.getVersion(id, version, signal));
  return (
    <ResourceView resource={resource} what={`version ${version}`}>
      {(found) => (
        <>
          <p className="muted">
            The resolved definition of version {found.version}: the submitted document with every default filled in, exactly as stored. Hash{' '}
            <code>{found.hash}</code>.
          </p>
          <pre className="definition">{formatJson(found.definition)}</pre>
        </>
      )}
    </ResourceView>
  );
}

/** `/scenarios/:id` and `/chaos-profiles/:id`: the versions, one definition, and where to go next. */
export function DocumentPage({ kind }: { kind: DocumentKind }) {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const saved = wholeParamOf(params, 'saved');
  const resource = useResource(`document:${kind.id}:${id}`, (signal) => kind.get(id, signal));
  return (
    <ResourceView resource={resource} what={`the ${kind.noun}`}>
      {(document) => {
        const shown = wholeParamOf(params, 'version') ?? document.latestVersion;
        return (
          <>
            <p className="crumbs">
              <Link to={kind.route}>{kind.title}</Link> / {document.name}
            </p>
            <div className="title-row">
              <h1>{document.name}</h1>
              <span className="button-row">
                <Link className="button" to={`${kind.route}/${document.id}/versions/new`}>
                  New version
                </Link>
                <Link className="button primary" to={`${kind.launch.route}?${kind.launchParam}=${document.id}`}>
                  {kind.launch.label}
                </Link>
              </span>
            </div>
            {saved !== undefined ? (
              <p className="panel panel--good" role="status">
                Saved as version {saved}.
              </p>
            ) : null}
            <Section title="Summary">
              <Facts
                items={[
                  { label: 'Id', value: <code>{document.id}</code> },
                  { label: 'Latest version', value: `v${document.latestVersion}` },
                  { label: 'Created', value: formatTimestamp(document.createdAt) },
                ]}
              />
            </Section>
            <Section title="Versions">
              <table>
                <caption className="sr-only">Versions of {document.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Hash</th>
                    <th scope="col">Created</th>
                    <th scope="col">Definition</th>
                  </tr>
                </thead>
                <tbody>
                  {[...document.versions].reverse().map((version) => (
                    <tr key={version.version} className={version.version === shown ? 'is-active' : undefined}>
                      <th scope="row">v{version.version}</th>
                      <td>
                        <code title={version.hash}>{version.hash.slice(0, 19)}&hellip;</code>
                      </td>
                      <td>{formatTimestamp(version.createdAt)}</td>
                      <td>
                        {version.version === shown ? (
                          'shown below'
                        ) : (
                          <Link to={{ search: `?version=${version.version}` }} aria-label={`Show version ${version.version}`}>
                            Show
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
            <Section title={`Version ${shown}`}>
              <VersionDefinition kind={kind} id={document.id} version={shown} />
            </Section>
          </>
        );
      }}
    </ResourceView>
  );
}

/** `/scenarios/new` and `/chaos-profiles/new`: a new document, from a blank page or an example. */
export function NewDocumentPage({ kind }: { kind: DocumentKind }) {
  return <DocumentEditor kind={kind} initialText={formatJson({ formatVersion: 1, name: `my-${kind.id}` })} />;
}

/** `/scenarios/:id/versions/new`: the editor, starting from the latest version's resolved definition. */
export function NewVersionPage({ kind }: { kind: DocumentKind }) {
  const { id = '' } = useParams();
  const resource = useResource(`document-latest:${kind.id}:${id}`, async (signal) => {
    const document = await kind.get(id, signal);
    const latest = await kind.getVersion(id, document.latestVersion, signal);
    return { document, latest };
  });
  return (
    <ResourceView resource={resource} what={`the ${kind.noun}`}>
      {({ document, latest }) => (
        <DocumentEditor
          kind={kind}
          target={{ id: document.id, name: document.name }}
          initialText={formatJson(latest.definition)}
          versions={document.versions}
        />
      )}
    </ResourceView>
  );
}
