import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { scenarioHash, scenarioSchema, type ScenarioConfig } from '@dataforge/core';
import { idParam, positiveIntParam } from '../http/params';
import type { ScenarioSummaryView, ScenarioValidationView, ScenarioVersionView, ScenarioView } from './scenario-views';
import { ScenariosService } from './scenarios.service';

/** The part of the HTTP response the versions endpoint sets: 201 for a new version, 200 for an existing one. */
interface StatusResponse {
  status(code: number): unknown;
}

@Controller('scenarios')
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  /** The body is a scenario file, exactly as in scenarios/; the core scenario schema validates it. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body({ schema: scenarioSchema }) config: ScenarioConfig): Promise<ScenarioView> {
    return this.scenarios.create(config);
  }

  /**
   * A dry run of POST /scenarios: the same schema and the same validation pipe, so an invalid document gets
   * exactly the 400 the create endpoint gives; a valid one is answered with its resolved definition and hash,
   * and nothing is stored.
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate(@Body({ schema: scenarioSchema }) config: ScenarioConfig): ScenarioValidationView {
    return { valid: true, name: config.name, scenarioHash: scenarioHash(config), definition: config };
  }

  @Get()
  async list(): Promise<{ scenarios: ScenarioSummaryView[] }> {
    return { scenarios: await this.scenarios.list() };
  }

  @Get(':id')
  get(@Param('id', idParam('scenario')) id: string): Promise<ScenarioView> {
    return this.scenarios.get(id);
  }

  @Post(':id/versions')
  async addVersion(
    @Param('id', idParam('scenario')) id: string,
    @Body({ schema: scenarioSchema }) config: ScenarioConfig,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<ScenarioVersionView> {
    const { created, version } = await this.scenarios.addVersion(id, config);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return version;
  }

  @Get(':id/versions/:version')
  getVersion(@Param('id', idParam('scenario')) id: string, @Param('version', positiveIntParam('version')) version: number): Promise<ScenarioVersionView> {
    return this.scenarios.getVersion(id, version);
  }
}
