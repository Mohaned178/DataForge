import { Logger, Module } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PrismaRunStore } from './prisma-run-store';
import { RunRunner } from './run-runner';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';

@Module({
  controllers: [RunsController],
  providers: [
    RunsService,
    {
      provide: RunRunner,
      useFactory: (prisma: PrismaService) => new RunRunner(new PrismaRunStore(prisma), { log: new Logger('RunRunner') }),
      inject: [PrismaService],
    },
  ],
})
export class RunsModule {}
