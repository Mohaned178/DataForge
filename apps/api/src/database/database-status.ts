import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaService } from './prisma.service';

/** prisma/migrations of this app; src/database and dist/database are both two levels below it. */
export const MIGRATIONS_DIRECTORY = resolve(__dirname, '..', '..', 'prisma', 'migrations');

export type DatabaseStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'unreachable'; readonly detail: string }
  | { readonly state: 'not-migrated'; readonly pending: readonly string[] };

export function localMigrations(directory = MIGRATIONS_DIRECTORY): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function isDatabaseReachable(prisma: PrismaService): Promise<{ reachable: true } | { reachable: false; detail: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { reachable: true };
  } catch (error) {
    return { reachable: false, detail: describeError(error) };
  }
}

/** Whether the database answers and has every migration of this build applied. */
export async function checkDatabase(prisma: PrismaService, migrations = localMigrations()): Promise<DatabaseStatus> {
  const reachable = await isDatabaseReachable(prisma);
  if (!reachable.reachable) {
    return { state: 'unreachable', detail: reachable.detail };
  }
  const [table] = await prisma.$queryRaw<{ name: string | null }[]>`SELECT to_regclass('public._prisma_migrations')::text AS name`;
  if (table?.name === null || table?.name === undefined) {
    return { state: 'not-migrated', pending: migrations };
  }
  const applied = await prisma.$queryRaw<{ name: string }[]>`
    SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const appliedNames = new Set(applied.map((row) => row.name));
  const pending = migrations.filter((name) => !appliedNames.has(name));
  return pending.length === 0 ? { state: 'ready' } : { state: 'not-migrated', pending };
}

const NETWORK_ERRORS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  ETIMEDOUT: 'connection timed out',
};

/**
 * One line for a person: Prisma wraps driver errors in a message that starts with the call that
 * failed ("Invalid `prisma.$queryRaw()` invocation"), and keeps PostgreSQL's own message in its meta.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code !== undefined && code in NETWORK_ERRORS) {
    return `${NETWORK_ERRORS[code]} (${code})`;
  }
  const cause = driverCause(error);
  if (cause?.originalMessage !== undefined) {
    return cause.originalMessage;
  }
  if (cause?.kind !== undefined) {
    return cause.kind;
  }
  const lines = error.message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Invalid `prisma'));
  return lines.join(' ') || code || error.name;
}

function driverCause(error: Error): { originalMessage?: string; kind?: string } | undefined {
  const meta = 'meta' in error ? error.meta : undefined;
  if (typeof meta !== 'object' || meta === null || !('driverAdapterError' in meta)) {
    return undefined;
  }
  const adapterError = meta.driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null || !('cause' in adapterError)) {
    return undefined;
  }
  const cause = adapterError.cause;
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  return {
    ...('originalMessage' in cause && typeof cause.originalMessage === 'string' ? { originalMessage: cause.originalMessage } : {}),
    ...('kind' in cause && typeof cause.kind === 'string' ? { kind: cause.kind } : {}),
  };
}
