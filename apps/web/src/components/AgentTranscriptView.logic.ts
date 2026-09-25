/** Shortest gap between transcript fetches while an agent streams progress. */
export const TRANSCRIPT_REFRESH_INTERVAL_MS = 2_000;

/**
 * The last fetch of one transcript: the agent's `updatedAt` it covers, or
 * null when the cached result must be replaced (it was a failure), and when
 * it started.
 */
export interface TranscriptFetchMark {
  readonly revision: string | null;
  readonly at: number;
}

/**
 * When to refetch a transcript. Returns null when nothing should start now:
 * the cached transcript is current, or a read is in flight (refetching would
 * cancel it, so a steady stream of progress could starve every read). Else
 * the delay, so bursts of progress collapse into one fetch per interval.
 */
export function planTranscriptRefresh(input: {
  readonly mark: TranscriptFetchMark | undefined;
  readonly currentRevision: string;
  readonly inFlight: boolean;
  readonly now: number;
}): number | null {
  const { mark } = input;
  if (input.inFlight || mark === undefined || mark.revision === input.currentRevision) {
    return null;
  }
  return Math.max(0, mark.at + TRANSCRIPT_REFRESH_INTERVAL_MS - input.now);
}
