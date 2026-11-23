/**
 * What the database holds for a run no longer matches what was recorded when it was generated, for
 * example a stored event that was modified. The API refuses to serve such a run (HTTP 500), because
 * the files it would send are not the run's files.
 */
export class RunIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunIntegrityError';
  }
}
