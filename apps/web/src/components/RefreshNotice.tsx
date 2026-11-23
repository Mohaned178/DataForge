import { ApiError } from '../api/client';
import { describeFailure } from '../lib/problems';

/**
 * Shown above the page when a refresh failed after the page had data: the data on screen is what the API
 * said a moment ago, and the page is already trying again.
 */
export function RefreshNotice({ error }: { error: unknown }) {
  if (error === undefined) return null;
  const detail = error instanceof ApiError ? `The API answered ${error.statusCode}: ${error.message}` : describeFailure(error);
  return (
    <p role="status" className="panel panel--warn">
      <strong>The latest refresh failed.</strong> This page shows what the API said a moment ago, and keeps trying. {detail}
    </p>
  );
}
