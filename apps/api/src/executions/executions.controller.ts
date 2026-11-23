import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { idParam } from '../http/params';
import {
  attemptsQuerySchema,
  findingsQuerySchema,
  listExecutionsQuerySchema,
  startExecutionSchema,
  submitActualStateSchema,
  windowFindingsQuerySchema,
  type AttemptsQuery,
  type FindingsQuery,
  type ListExecutionsQuery,
  type StartExecutionRequest,
  type SubmitActualStateRequest,
  type WindowFindingsQuery,
} from './execution-requests';
import type { AttemptsView, ExecutionListView, ExecutionView, FindingsView, ReportView, WindowFindingsView } from './execution-views';
import { EXECUTION_FILE_NAMES, ExecutionsService, type ExecutionFileName } from './executions.service';

function executionFileParam() {
  return { schema: z.enum(EXECUTION_FILE_NAMES, { error: `must be one of the execution files: ${EXECUTION_FILE_NAMES.join(', ')}` }) };
}

@Controller('executions')
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  /** Answers 202 at once: the execution runs in the background; follow it with GET /executions/:id. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body({ schema: startExecutionSchema }) request: StartExecutionRequest): Promise<ExecutionView> {
    return this.executions.start(request);
  }

  @Get()
  list(@Query({ schema: listExecutionsQuerySchema }) query: ListExecutionsQuery): Promise<ExecutionListView> {
    return this.executions.list(query);
  }

  @Get(':id')
  get(@Param('id', idParam('execution')) id: string): Promise<ExecutionView> {
    return this.executions.get(id);
  }

  /** The state an external pipeline ended in; the execution is validated and completed in this request. */
  @Post(':id/actual-state')
  @HttpCode(HttpStatus.OK)
  submitActualState(
    @Param('id', idParam('execution')) id: string,
    @Body({ schema: submitActualStateSchema }) submission: SubmitActualStateRequest,
  ): Promise<ExecutionView> {
    return this.executions.submitActualState(id, submission);
  }

  @Get(':id/attempts')
  attempts(@Param('id', idParam('execution')) id: string, @Query({ schema: attemptsQuerySchema }) query: AttemptsQuery): Promise<AttemptsView> {
    return this.executions.attempts(id, query);
  }

  @Get(':id/report')
  report(@Param('id', idParam('execution')) id: string): Promise<ReportView> {
    return this.executions.report(id);
  }

  @Get(':id/findings')
  findings(@Param('id', idParam('execution')) id: string, @Query({ schema: findingsQuerySchema }) query: FindingsQuery): Promise<FindingsView> {
    return this.executions.findings(id, query);
  }

  @Get(':id/window-findings')
  windowFindings(
    @Param('id', idParam('execution')) id: string,
    @Query({ schema: windowFindingsQuerySchema }) query: WindowFindingsQuery,
  ): Promise<WindowFindingsView> {
    return this.executions.windowFindings(id, query);
  }

  /** The exact bytes of one file, the same as "dataforge chaos plan", "deliver" and "validate --report" write for the same inputs. */
  @Get(':id/files/:name')
  async file(@Param('id', idParam('execution')) id: string, @Param('name', executionFileParam()) name: ExecutionFileName): Promise<StreamableFile> {
    const file = await this.executions.readFile(id, name);
    const bytes = Buffer.from(file.content, 'utf8');
    return new StreamableFile(bytes, { type: file.contentType, length: bytes.length, disposition: `attachment; filename="${file.name}"` });
  }
}
