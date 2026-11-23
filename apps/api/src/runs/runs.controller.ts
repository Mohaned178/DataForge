import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, StreamableFile } from '@nestjs/common';
import type { RunFileName } from '@dataforge/core';
import { idParam, runFileParam } from '../http/params';
import {
  listRunsQuerySchema,
  runEventsQuerySchema,
  startRunSchema,
  type ListRunsQuery,
  type RunEventsQuery,
  type StartRunRequest,
} from './run-requests';
import type { RunEventsView, RunListView, RunView } from './run-views';
import { RunsService } from './runs.service';

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** Answers 202 at once: the run is generated in the background; follow it with GET /runs/:id. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body({ schema: startRunSchema }) request: StartRunRequest): Promise<RunView> {
    return this.runs.start(request);
  }

  @Get()
  list(@Query({ schema: listRunsQuerySchema }) query: ListRunsQuery): Promise<RunListView> {
    return this.runs.list(query);
  }

  @Get(':id')
  get(@Param('id', idParam('run')) id: string): Promise<RunView> {
    return this.runs.get(id);
  }

  @Get(':id/events')
  events(@Param('id', idParam('run')) id: string, @Query({ schema: runEventsQuerySchema }) query: RunEventsQuery): Promise<RunEventsView> {
    return this.runs.events(id, query);
  }

  /** The exact bytes of one run file, the same as "dataforge generate" writes for the same scenario and seed. */
  @Get(':id/files/:name')
  async file(@Param('id', idParam('run')) id: string, @Param('name', runFileParam()) name: RunFileName): Promise<StreamableFile> {
    const file = await this.runs.readFile(id, name);
    const bytes = Buffer.from(file.content, 'utf8');
    return new StreamableFile(bytes, { type: file.contentType, length: bytes.length, disposition: `attachment; filename="${file.name}"` });
  }
}
