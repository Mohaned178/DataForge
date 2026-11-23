/**
 * What the database holds for an execution no longer matches what was recorded when it ran, for
 * example a stored attempt or finding that was modified. The API refuses to serve such a file
 * (HTTP 500), because it would not be the execution's file.
 */
export class ExecutionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionIntegrityError';
  }
}
