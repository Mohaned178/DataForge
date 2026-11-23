import { Logger, Module } from '@nestjs/common';
import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../database/prisma.service';
import { executionPipeline } from './execution-pipeline';
import { ExecutionRunner } from './execution-runner';
import { ExecutionsController } from './executions.controller';
import { ExecutionsService } from './executions.service';
import { PrismaExecutionStore } from './prisma-execution-store';

@Module({
  controllers: [ExecutionsController],
  providers: [
    ExecutionsService,
    {
      provide: ExecutionRunner,
      useFactory: (prisma: PrismaService, config: ApiConfig) =>
        new ExecutionRunner(new PrismaExecutionStore(prisma), executionPipeline(prisma, config), { log: new Logger('ExecutionRunner') }),
      inject: [PrismaService, API_CONFIG],
    },
  ],
})
export class ExecutionsModule {}
