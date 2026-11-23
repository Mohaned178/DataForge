import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { parseScenario, scenarioHash, type ScenarioConfig } from '@dataforge/core';
import { PrismaService } from '../database/prisma.service';
import { isUniqueViolation } from '../persistence-errors';
import type { ScenarioSummaryView, ScenarioVersionView, ScenarioView, VersionSummaryView } from './scenario-views';

const versionSummary = { version: true, scenarioHash: true, createdAt: true } as const;

/**
 * Scenarios and their immutable versions. A version stores the resolved definition and its hash;
 * the database refuses any update of it (a trigger), so a changed definition is always a new version.
 */
@Injectable()
export class ScenariosService {
  constructor(private readonly prisma: PrismaService) {}

  async create(config: ScenarioConfig): Promise<ScenarioView> {
    const existing = await this.prisma.scenario.findUnique({ where: { name: config.name }, select: { id: true } });
    if (existing !== null) {
      throw nameTaken(config.name, existing.id);
    }
    let id: string;
    try {
      const created = await this.prisma.scenario.create({
        data: {
          name: config.name,
          versions: { create: { version: 1, scenarioHash: scenarioHash(config), definition: config } },
        },
        select: { id: true },
      });
      id = created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw nameTaken(config.name);
      }
      throw error;
    }
    return this.get(id);
  }

  async list(): Promise<ScenarioSummaryView[]> {
    const scenarios = await this.prisma.scenario.findMany({
      orderBy: { name: 'asc' },
      include: { versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 } },
    });
    return scenarios.map(({ versions, ...scenario }) => ({ ...scenario, latestVersion: versions[0]?.version ?? 0 }));
  }

  async get(id: string): Promise<ScenarioView> {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id },
      include: { versions: { select: versionSummary, orderBy: { version: 'asc' } } },
    });
    if (scenario === null) {
      throw scenarioNotFound(id);
    }
    const versions: VersionSummaryView[] = scenario.versions;
    return { id: scenario.id, name: scenario.name, createdAt: scenario.createdAt, latestVersion: versions.at(-1)?.version ?? 0, versions };
  }

  /** Adds a version, or returns the existing one when its resolved definition is identical. */
  async addVersion(id: string, config: ScenarioConfig): Promise<{ created: boolean; version: ScenarioVersionView }> {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { name: true } });
    if (scenario === null) {
      throw scenarioNotFound(id);
    }
    if (config.name !== scenario.name) {
      throw new BadRequestException([
        `name: the document is named "${config.name}" but this scenario is "${scenario.name}"; a new name is a new scenario (POST /scenarios)`,
      ]);
    }
    const hash = scenarioHash(config);
    const identical = await this.prisma.scenarioVersion.findUnique({
      where: { scenarioId_scenarioHash: { scenarioId: id, scenarioHash: hash } },
      select: { version: true },
    });
    if (identical !== null) {
      return { created: false, version: await this.getVersion(id, identical.version) };
    }
    const latest = await this.prisma.scenarioVersion.findFirst({ where: { scenarioId: id }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    try {
      await this.prisma.scenarioVersion.create({ data: { scenarioId: id, version, scenarioHash: hash, definition: config } });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`Another version of scenario ${id} was added at the same time; retry the request.`);
      }
      throw error;
    }
    return { created: true, version: await this.getVersion(id, version) };
  }

  async getVersion(id: string, version: number): Promise<ScenarioVersionView> {
    const found = await this.prisma.scenarioVersion.findUnique({
      where: { scenarioId_version: { scenarioId: id, version } },
      include: { scenario: { select: { name: true } } },
    });
    if (found === null) {
      const exists = await this.prisma.scenario.count({ where: { id } });
      throw exists === 0 ? scenarioNotFound(id) : new NotFoundException(`Scenario ${id} has no version ${version}.`);
    }
    return {
      scenarioId: found.scenarioId,
      scenarioName: found.scenario.name,
      version: found.version,
      scenarioHash: found.scenarioHash,
      createdAt: found.createdAt,
      definition: parseScenario(found.definition),
    };
  }
}

export function scenarioNotFound(id: string): NotFoundException {
  return new NotFoundException(`Scenario ${id} not found.`);
}

function nameTaken(name: string, id?: string): ConflictException {
  const hint = id === undefined ? '' : ` (id ${id}); add a version with POST /scenarios/${id}/versions`;
  return new ConflictException(`A scenario named "${name}" already exists${hint}.`);
}
