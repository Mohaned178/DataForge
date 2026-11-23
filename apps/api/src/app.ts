import 'reflect-metadata';
import { Module, StandardSchemaValidationPipe, type DynamicModule, type INestApplication, type LoggerService, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { API_CONFIG, type ApiConfig } from './config';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { RunsModule } from './runs/runs.module';
import { ScenariosModule } from './scenarios/scenarios.module';

@Module({})
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, ScenariosModule, RunsModule],
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG, useValue: config }],
      exports: [API_CONFIG],
    };
  }
}

export interface CreateApiOptions {
  readonly logger?: false | LoggerService | LogLevel[];
  /** Close the application on SIGINT/SIGTERM (Ctrl+C). The API process wants it; tests close their apps themselves. */
  readonly shutdownHooks?: boolean;
}

/**
 * Builds the API application without starting it: dependency injection is resolved, but nothing
 * runs until init() or listen() (the run runner resumes unfinished runs then). Used by main.ts and
 * the API tests, so both exercise the same application.
 */
export async function createApiApplication(config: ApiConfig, options: CreateApiOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), {
    logger: options.logger ?? ['log', 'warn', 'error'],
    abortOnError: false,
  });
  // Every body, query and path parameter with a Zod schema is validated; problems are listed by path.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  if (options.shutdownHooks ?? true) {
    app.enableShutdownHooks();
  }
  return app;
}
