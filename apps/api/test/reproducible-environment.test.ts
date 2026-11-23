import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadApiConfig } from '../src/config';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const compose = read('compose.yaml');
const envExample = read('.env.example');

/** NAME=value lines of .env.example, commented-out examples (# NAME=value) included. */
function documentedVariables(): Map<string, string> {
  const variables = new Map<string, string>();
  for (const line of envExample.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      variables.set(match[1], match[2] ?? '');
    }
  }
  return variables;
}

describe('the Compose environment is reproducible', () => {
  it('pins every image to an exact version, never "latest" or a bare major', () => {
    const images = [...compose.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((match) => match[1] ?? '');
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const image of images) {
      expect(image).toMatch(/:\d+\.\d+(\.\d+)?(-[a-z]+)?$/);
      expect(image).not.toMatch(/latest/);
    }
  });

  it('gives every service a health check, so "docker compose up --wait" means ready', () => {
    const services = compose.split(/^services:\s*$/m)[1]?.split(/^volumes:\s*$/m)[0] ?? '';
    const names = [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);
    const checks = [...services.matchAll(/^ {4}healthcheck:\s*$/gm)];
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(checks).toHaveLength(names.length);
  });

  it('documents in .env.example every ${VARIABLE:-default} that compose.yaml reads, with the same default', () => {
    const documented = documentedVariables();
    const used = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+):-([^}]*)\}/g)];
    expect(used.length).toBeGreaterThanOrEqual(2);
    for (const [, name, fallback] of used) {
      expect(documented.get(name ?? '')).toBe(fallback);
    }
  });

  it('keeps the connection settings of .env.example consistent with the published ports', () => {
    const documented = documentedVariables();
    expect(documented.get('KAFKA_BROKERS')).toBe(`localhost:${documented.get('KAFKA_HOST_PORT')}`);
    expect(documented.get('DATABASE_URL')).toContain(`@localhost:${documented.get('POSTGRES_HOST_PORT')}/`);
    expect(documented.get('TEST_DATABASE_URL')).toContain(`@localhost:${documented.get('POSTGRES_HOST_PORT')}/`);
  });

  it('is a configuration the API accepts, and the Compose database credentials are the documented ones', () => {
    const documented = documentedVariables();
    const config = loadApiConfig({
      DATABASE_URL: documented.get('DATABASE_URL'),
      API_HOST: documented.get('API_HOST'),
      API_PORT: documented.get('API_PORT'),
      KAFKA_BROKERS: documented.get('KAFKA_BROKERS'),
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.kafkaBrokers).toEqual(['localhost:9092']);
    const url = new URL(documented.get('DATABASE_URL') ?? '');
    expect(compose).toContain(`POSTGRES_USER: ${url.username}`);
    expect(compose).toContain(`POSTGRES_PASSWORD: ${url.password}`);
    expect(compose).toContain(`POSTGRES_DB: ${url.pathname.slice(1)}`);
  });

  it('documents only variables the code reads', () => {
    const sources = [
      'apps/api/src/config.ts',
      'apps/api/prisma.config.ts',
      'apps/cli/src/commands/deliver.ts',
      'apps/web/vite.config.ts',
      'apps/web/vite.config.mts',
      'compose.yaml',
    ]
      .map((file) => {
        try {
          return read(file);
        } catch {
          return '';
        }
      })
      .join('\n');
    const extra = read('apps/api/integration/support.ts') + read('apps/api/integration/global-setup.js');
    for (const name of documentedVariables().keys()) {
      expect(sources + extra).toContain(name);
    }
  });
});
