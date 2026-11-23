import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUN_FILE_NAMES,
  buildRunFiles,
  parseScenario,
  runManifestSchema,
  serializeRunManifest,
  sha256Hex,
  simulate,
  type RunFileName,
} from '../src';

/**
 * The run files of scenarios/*.json with seed 42, pinned to the bytes `dataforge generate` wrote
 * before the format moved into core (Milestone 6). The CLI and the API both build them here.
 */
const PINNED: Record<string, Record<RunFileName, string>> = {
  'ecommerce-small': {
    'events.jsonl': '01b57d640ab12e33702ccb72339fd00552e6b37b3fddce4dff7a5a8c0cca42de',
    'expected-state.json': '3546842d89241f81b31bd2bfaa11916fff0ee04cc400195a70b4c2e6beff2101',
    'scenario.resolved.json': 'f642fb41261117d68dde26c14b0859b6fd01d898c1c3c0dc5fcf8354e1978714',
    'manifest.json': 'e58bd81fb8f519b236585ce1bca12cb9cd86e15638adf42eef9d292814867456',
  },
  'ecommerce-standard': {
    'events.jsonl': 'e50c2d7714c78069b4aa80e87ea084d9b5406a2474d2ea05b6ed661aa4fc4157',
    'expected-state.json': 'bddc639a821f02f995933b415c069defa972bff6bf551061145aa49ae16d67e5',
    'scenario.resolved.json': '1b8725db1100a2e956062052ba07761000a966338a9f94095e7dab3f3d5f70ea',
    'manifest.json': '8ea0a368df43ae6eee3c177f19aeaa400e7e2887fde4d4bcd2ebdcf4a0784776',
  },
};

function scenarioFile(name: string) {
  return parseScenario(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'scenarios', `${name}.json`), 'utf8')));
}

describe('buildRunFiles', () => {
  it.each(Object.keys(PINNED))('reproduces the pinned bytes of the four run files of %s, seed 42', (name) => {
    const scenario = scenarioFile(name);
    const { contents } = buildRunFiles(scenario, simulate({ scenario, seed: '42' }));
    for (const file of RUN_FILE_NAMES) {
      expect([file, sha256Hex(contents[file])]).toEqual([file, PINNED[name]?.[file]]);
    }
  });

  it('records the checksum and byte length of each file in a manifest that matches its own schema', () => {
    const scenario = scenarioFile('ecommerce-small');
    const result = simulate({ scenario, seed: 'run-files' });
    const { manifest, contents } = buildRunFiles(scenario, result);
    expect(runManifestSchema.parse(manifest)).toEqual(manifest);
    expect(serializeRunManifest(manifest)).toBe(contents['manifest.json']);
    for (const [file, entry] of Object.entries(manifest.files)) {
      const content = contents[file as RunFileName];
      expect(entry).toEqual({ sha256: sha256Hex(content), bytes: Buffer.byteLength(content, 'utf8') });
    }
    expect(manifest).toMatchObject({ seed: 'run-files', scenario: { name: 'ecommerce-small', hash: result.scenarioHash } });
    expect(manifest.counts.events).toBe(result.events.length);
  });

  it('counts multi-byte characters as UTF-8 bytes', () => {
    const scenario = parseScenario({ formatVersion: 1, name: 'café ☕', orders: { count: 1 } });
    const { manifest, contents } = buildRunFiles(scenario, simulate({ scenario, seed: 1 }));
    const resolved = contents['scenario.resolved.json'];
    expect(manifest.files['scenario.resolved.json'].bytes).toBe(Buffer.byteLength(resolved, 'utf8'));
    expect(manifest.files['scenario.resolved.json'].bytes).toBeGreaterThan(resolved.length);
  });
});
