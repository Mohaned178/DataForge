import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { chaosProfileHash, parseChaosProfile, type ChaosProfile } from '@dataforge/chaos';
import { PrismaService } from '../database/prisma.service';
import { isUniqueViolation } from '../persistence-errors';
import type { ChaosProfileSummaryView, ChaosProfileVersionView, ChaosProfileView, ProfileVersionSummaryView } from './chaos-profile-views';

const versionSummary = { version: true, profileHash: true, createdAt: true } as const;

/**
 * Chaos profiles and their immutable versions, like scenarios: a version stores the resolved profile
 * and its hash, the database refuses any update of it, and an identical definition is the same version.
 */
@Injectable()
export class ChaosProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(profile: ChaosProfile): Promise<ChaosProfileView> {
    const existing = await this.prisma.chaosProfile.findUnique({ where: { name: profile.name }, select: { id: true } });
    if (existing !== null) {
      throw nameTaken(profile.name, existing.id);
    }
    let id: string;
    try {
      const created = await this.prisma.chaosProfile.create({
        data: { name: profile.name, versions: { create: { version: 1, profileHash: chaosProfileHash(profile), definition: profile } } },
        select: { id: true },
      });
      id = created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw nameTaken(profile.name);
      }
      throw error;
    }
    return this.get(id);
  }

  async list(): Promise<ChaosProfileSummaryView[]> {
    const profiles = await this.prisma.chaosProfile.findMany({
      orderBy: { name: 'asc' },
      include: { versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 } },
    });
    return profiles.map(({ versions, ...profile }) => ({ ...profile, latestVersion: versions[0]?.version ?? 0 }));
  }

  async get(id: string): Promise<ChaosProfileView> {
    const profile = await this.prisma.chaosProfile.findUnique({
      where: { id },
      include: { versions: { select: versionSummary, orderBy: { version: 'asc' } } },
    });
    if (profile === null) {
      throw chaosProfileNotFound(id);
    }
    const versions: ProfileVersionSummaryView[] = profile.versions;
    return { id: profile.id, name: profile.name, createdAt: profile.createdAt, latestVersion: versions.at(-1)?.version ?? 0, versions };
  }

  /** Adds a version, or returns the existing one when its resolved definition is identical. */
  async addVersion(id: string, profile: ChaosProfile): Promise<{ created: boolean; version: ChaosProfileVersionView }> {
    const existing = await this.prisma.chaosProfile.findUnique({ where: { id }, select: { name: true } });
    if (existing === null) {
      throw chaosProfileNotFound(id);
    }
    if (profile.name !== existing.name) {
      throw new BadRequestException([
        `name: the document is named "${profile.name}" but this chaos profile is "${existing.name}"; a new name is a new profile (POST /chaos-profiles)`,
      ]);
    }
    const hash = chaosProfileHash(profile);
    const identical = await this.prisma.chaosProfileVersion.findUnique({
      where: { chaosProfileId_profileHash: { chaosProfileId: id, profileHash: hash } },
      select: { version: true },
    });
    if (identical !== null) {
      return { created: false, version: await this.getVersion(id, identical.version) };
    }
    const latest = await this.prisma.chaosProfileVersion.findFirst({ where: { chaosProfileId: id }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    try {
      await this.prisma.chaosProfileVersion.create({ data: { chaosProfileId: id, version, profileHash: hash, definition: profile } });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`Another version of chaos profile ${id} was added at the same time; retry the request.`);
      }
      throw error;
    }
    return { created: true, version: await this.getVersion(id, version) };
  }

  async getVersion(id: string, version: number): Promise<ChaosProfileVersionView> {
    const found = await this.prisma.chaosProfileVersion.findUnique({
      where: { chaosProfileId_version: { chaosProfileId: id, version } },
      include: { chaosProfile: { select: { name: true } } },
    });
    if (found === null) {
      const exists = await this.prisma.chaosProfile.count({ where: { id } });
      throw exists === 0 ? chaosProfileNotFound(id) : new NotFoundException(`Chaos profile ${id} has no version ${version}.`);
    }
    return {
      chaosProfileId: found.chaosProfileId,
      chaosProfileName: found.chaosProfile.name,
      version: found.version,
      profileHash: found.profileHash,
      createdAt: found.createdAt,
      definition: parseChaosProfile(found.definition),
    };
  }
}

export function chaosProfileNotFound(id: string): NotFoundException {
  return new NotFoundException(`Chaos profile ${id} not found.`);
}

function nameTaken(name: string, id?: string): ConflictException {
  const hint = id === undefined ? '' : ` (id ${id}); add a version with POST /chaos-profiles/${id}/versions`;
  return new ConflictException(`A chaos profile named "${name}" already exists${hint}.`);
}
