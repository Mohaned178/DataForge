import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The API's one database client. It disconnects after every other provider has stopped (the run
 * runner finishes its current run in onModuleDestroy, which Nest calls before this hook).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnApplicationShutdown {
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
