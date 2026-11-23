/**
 * The example documents the editors can start from. They are the repository's own files (scenarios/ and
 * chaos-profiles/), imported as text, so a template is never a copy that can drift: saving one unchanged
 * stores exactly what `dataforge generate` and `chaos plan` read from the file.
 */

export interface Template {
  /** The file name without its extension, which is also the document's name. */
  readonly name: string;
  readonly text: string;
}

function templatesOf(files: Readonly<Record<string, string>>): readonly Template[] {
  return Object.entries(files)
    .map(([path, text]) => ({ name: path.replace(/^.*\//, '').replace(/\.json$/, ''), text }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export const SCENARIO_TEMPLATES: readonly Template[] = templatesOf(
  import.meta.glob<string>('../../../scenarios/*.json', { query: '?raw', import: 'default', eager: true }),
);

export const CHAOS_PROFILE_TEMPLATES: readonly Template[] = templatesOf(
  import.meta.glob<string>('../../../chaos-profiles/*.json', { query: '?raw', import: 'default', eager: true }),
);
