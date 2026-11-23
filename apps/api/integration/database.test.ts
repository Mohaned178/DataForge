import { ENGINE_VERSION } from '@dataforge/core';
import { checkDatabase, localMigrations } from '../src/database/database-status';
import { PrismaService } from '../src/database/prisma.service';
import { clearDatabase, recreateDatabase, testConfig, testDatabaseUrl } from './support';

function databaseUrlNamed(name: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

let prisma: PrismaService;
beforeAll(() => {
  prisma = new PrismaService(testConfig());
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await clearDatabase(prisma);
});

async function aRun(): Promise<{ runId: string; versionId: string }> {
  const scenario = await prisma.scenario.create({
    data: { name: `s-${Math.random().toString(36).slice(2)}`, versions: { create: { version: 1, scenarioHash: 'sha256:a', definition: {} } } },
    include: { versions: true },
  });
  const versionId = scenario.versions[0]?.id ?? '';
  const run = await prisma.simulationRun.create({ data: { scenarioVersionId: versionId, seed: '1', engineVersion: ENGINE_VERSION } });
  return { runId: run.id, versionId };
}

function event(runId: string, sequence: number, eventId: string, aggregateVersion = sequence) {
  return {
    runId,
    sequence,
    eventId,
    type: 'CustomerRegistered',
    aggregateType: 'Customer',
    aggregateId: 'cus_000001',
    aggregateVersion,
    eventTimeMs: BigInt(sequence),
    schemaVersion: 1,
    payload: {},
  };
}

describe('database status', () => {
  it('is ready when every migration of this build is applied', async () => {
    expect(localMigrations().length).toBeGreaterThan(0);
    await expect(checkDatabase(prisma)).resolves.toEqual({ state: 'ready' });
  });

  it('reports the pending migrations of an empty database', async () => {
    const url = databaseUrlNamed('dataforge_test_empty');
    await recreateDatabase(url, { migrate: false });
    const empty = new PrismaService(testConfig(url));
    try {
      await expect(checkDatabase(empty)).resolves.toEqual({ state: 'not-migrated', pending: localMigrations() });
    } finally {
      await empty.$disconnect();
    }
  });

  it('reports an unreachable server', async () => {
    const url = new URL(testDatabaseUrl());
    url.port = '1';
    const unreachable = new PrismaService(testConfig(url.toString()));
    try {
      const status = await checkDatabase(unreachable);
      expect(status.state).toBe('unreachable');
    } finally {
      await unreachable.$disconnect();
    }
  });

  it('never drops a database that is not a scratch database', async () => {
    await expect(recreateDatabase(databaseUrlNamed('dataforge'))).rejects.toThrow(/Refusing to drop database "dataforge"/);
  });
});

describe('schema constraints', () => {
  it('positions each event of a run by a unique sequence and identifies it by a unique event id', async () => {
    const { runId } = await aRun();
    await prisma.canonicalEvent.create({ data: event(runId, 1, 'evt_1') });
    await expect(prisma.canonicalEvent.create({ data: event(runId, 1, 'evt_2', 2) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.canonicalEvent.create({ data: event(runId, 2, 'evt_1', 2) })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.canonicalEvent.create({ data: event(runId, 2, 'evt_2', 1) })).rejects.toMatchObject({ code: 'P2002' });
    const other = await aRun();
    await expect(prisma.canonicalEvent.create({ data: event(other.runId, 1, 'evt_1') })).resolves.toMatchObject({ sequence: 1 });
  });

  it('keeps scenario names unique, and version numbers and definitions unique within a scenario', async () => {
    const { versionId } = await aRun();
    const version = await prisma.scenarioVersion.findUniqueOrThrow({ where: { id: versionId } });
    const scenario = await prisma.scenario.findUniqueOrThrow({ where: { id: version.scenarioId } });
    await expect(prisma.scenario.create({ data: { name: scenario.name } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.scenarioVersion.create({ data: { scenarioId: scenario.id, version: 1, scenarioHash: 'sha256:b', definition: {} } })).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(prisma.scenarioVersion.create({ data: { scenarioId: scenario.id, version: 2, scenarioHash: 'sha256:a', definition: {} } })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('refuses to update a scenario version or a stored event: both are immutable', async () => {
    const { runId, versionId } = await aRun();
    await prisma.canonicalEvent.create({ data: event(runId, 1, 'evt_1') });
    await expect(prisma.scenarioVersion.update({ where: { id: versionId }, data: { definition: { changed: true } } })).rejects.toThrow(
      /scenario_version rows are immutable/,
    );
    await expect(prisma.canonicalEvent.update({ where: { runId_sequence: { runId, sequence: 1 } }, data: { payload: { changed: true } } })).rejects.toThrow(
      /canonical_event rows are immutable/,
    );
  });

  it('deletes the events and snapshot of a deleted run, and refuses to delete a version that has runs', async () => {
    const { runId, versionId } = await aRun();
    await prisma.canonicalEvent.create({ data: event(runId, 1, 'evt_1') });
    await prisma.expectedStateSnapshot.create({ data: { runId, lastSequence: 1, document: {}, sha256: 'x' } });
    await expect(prisma.scenarioVersion.delete({ where: { id: versionId } })).rejects.toThrow();
    await prisma.simulationRun.delete({ where: { id: runId } });
    await expect(prisma.canonicalEvent.count({ where: { runId } })).resolves.toBe(0);
    await expect(prisma.expectedStateSnapshot.count({ where: { runId } })).resolves.toBe(0);
  });
});
