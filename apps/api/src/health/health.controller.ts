import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ENGINE_VERSION } from '@dataforge/core';
import { isDatabaseReachable } from '../database/database-status';
import { PrismaService } from '../database/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(): Promise<{ status: 'ok'; database: 'up'; engineVersion: string }> {
    const database = await isDatabaseReachable(this.prisma);
    if (!database.reachable) {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'down', engineVersion: ENGINE_VERSION, detail: database.detail });
    }
    return { status: 'ok', database: 'up', engineVersion: ENGINE_VERSION };
  }
}
