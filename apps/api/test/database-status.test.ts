import { describeError, localMigrations } from '../src/database/database-status';

/** Shaped like the errors the Prisma 7 PostgreSQL adapter throws (observed against postgres:18.7). */
function prismaError(code: string, message: string, meta?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(meta === undefined ? {} : { meta }) });
}

describe('describeError', () => {
  it('names a refused or unknown host in words, with the system code', () => {
    expect(describeError(prismaError('ECONNREFUSED', '\nInvalid `prisma.$queryRaw()` invocation:\n\n\n'))).toBe('connection refused (ECONNREFUSED)');
    expect(describeError(prismaError('ENOTFOUND', ''))).toBe('host not found (ENOTFOUND)');
  });

  it("uses PostgreSQL's own message when the driver reports one", () => {
    const error = prismaError('P2010', '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `3D000`.', {
      driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '3D000', originalMessage: 'database "dataforge_nope" does not exist', kind: 'DatabaseDoesNotExist' } },
    });
    expect(describeError(error)).toBe('database "dataforge_nope" does not exist');
    const unreachable = prismaError('P2010', 'Raw query failed.', { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', host: 'nohost.invalid' } } });
    expect(describeError(unreachable)).toBe('DatabaseNotReachable');
  });

  it('drops the Prisma call line and keeps the rest of the message', () => {
    expect(describeError(prismaError('P1001', '\nInvalid `prisma.$queryRaw()` invocation:\n\nCan\'t reach database server'))).toBe("Can't reach database server");
    expect(describeError('plain')).toBe('plain');
  });
});

describe('localMigrations', () => {
  it('lists the committed migrations in order', () => {
    const migrations = localMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations).toEqual([...migrations].sort());
    expect(migrations[0]).toMatch(/^\d{14}_init$/);
  });
});
