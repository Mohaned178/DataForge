import { RUN_FILE_NAMES } from '@dataforge/core';
import { z } from 'zod';

/** A path parameter that must be the UUID of a stored record. */
export function idParam(record: string) {
  return { schema: z.uuid({ error: `must be a ${record} id (a UUID)` }) };
}

/** A path parameter that must be a whole number of at least 1. */
export function positiveIntParam(name: string) {
  return { schema: z.coerce.number({ error: `${name} must be a number` }).int(`${name} must be a whole number`).min(1, `${name} must be at least 1`) };
}

/** A path parameter naming one of the four files of a run. */
export function runFileParam() {
  return { schema: z.enum(RUN_FILE_NAMES, { error: `must be one of the run files: ${RUN_FILE_NAMES.join(', ')}` }) };
}
