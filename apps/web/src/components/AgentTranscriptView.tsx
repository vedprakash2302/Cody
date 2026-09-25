/**
 * One subagent's transcript, opened from its row in the Agents panel. Read on
 * demand from the provider and refreshed as the agent reports progress, at
 * most once per interval; nothing is fetched while the view is closed.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  type EnvironmentId,
  RuntimeTaskId,
  type ScopedThreadRef,
  SubagentTranscriptError,
  type SubagentTranscriptEntry,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef } from "react";

import {
  planTranscriptRefresh,
  type TranscriptFetchMark,
} from "~/components/AgentTranscriptView.logic";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { orchestrationEnvironment } from "~/state/orchestration";

/** Last fetch per transcript, env:thread:agent. Outlives the view, like the atom cache. */
const fetchMarks = new Map<string, TranscriptFetchMark>();
const FETCH_MARK_LIMIT = 256;
/**
 * Past the transcript atom's 60s idle TTL with room to spare. A younger mark
 * may describe a read still pending in a cached atom; dropping it would let a
 * reopen record the new revision as covered by that older read.
 */
const FETCH_MARK_MIN_AGE_TO_EVICT_MS = 5 * 60_000;

function rememberFetch(key: string, mark: TranscriptFetchMark) {
  fetchMarks.delete(key);
  fetchMarks.set(key, mark);
  const evictBefore = Date.now() - FETCH_MARK_MIN_AGE_TO_EVICT_MS;
  // Oldest first. Stops at the first young mark, so the map may briefly grow.
  for (const [oldestKey, oldest] of fetchMarks) {
    if (fetchMarks.size <= FETCH_MARK_LIMIT || oldest.at > evictBefore) break;
    fetchMarks.delete(oldestKey);
  }
}

export function AgentTranscriptView({
  agent,
  environmentId,
  threadId,
  markdownCwd,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Workspace that relative links and images in the transcript resolve against. */
  markdownCwd: string | undefined;
}) {
  const atom = useMemo(
    () =>
      orchestrationEnvironment.subagentTranscript({
        environmentId,
        input: { threadId, taskId: RuntimeTaskId.make(agent.id) },
      }),
    [agent.id, environmentId, threadId],
  );
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const transcriptKey = `${environmentId}:${threadId}:${agent.id}`;
  const opened = useRef({ tag: result._tag, revision: agent.updatedAt });
  // Once per open (twice under StrictMode, writing the same mark).
  useEffect(() => {
    const { tag, revision } = opened.current;
    const mark = fetchMarks.get(transcriptKey);
    if (tag === "Failure") {
      // A cached failure (say, the session was stopped) is retried on open.
      rememberFetch(transcriptKey, { revision: null, at: mark?.at ?? 0 });
    } else if (mark === undefined) {
      // No record of what the cached value covers. A first load does cover
      // this revision; a cached value might not, so refetch it once.
      rememberFetch(transcriptKey, {
        revision: tag === "Initial" ? revision : null,
        at: tag === "Initial" ? Date.now() : 0,
      });
    }
    // Otherwise keep the mark: a load still running from an earlier open
    // covers the revision it started at, not this one. At worst, after a real
    // cache eviction, this costs one extra trailing fetch.
  }, [transcriptKey]);
  // Progress rows bump updatedAt: refetch then, not on a timer.
  useEffect(() => {
    const delay = planTranscriptRefresh({
      mark: fetchMarks.get(transcriptKey),
      currentRevision: agent.updatedAt,
      inFlight: result.waiting,
      now: Date.now(),
    });
    if (delay === null) return;
    const timer = setTimeout(() => {
      rememberFetch(transcriptKey, { revision: agent.updatedAt, at: Date.now() });
      refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [agent.updatedAt, refresh, result.waiting, transcriptKey]);
  // Recovery that progress can't trigger: a finished agent's revision never
  // moves, so a failed read (say, before the session resumed) stays failed.
  const retry = () => {
    rememberFetch(transcriptKey, { revision: agent.updatedAt, at: Date.now() });
    refresh();
  };

  return (
    <div className="mx-1.5 mb-1 max-h-[28rem] overflow-auto rounded-md border border-border/60 bg-background/60 p-2">
      {result._tag === "Success" ? (
        result.value.entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {result.value.truncated ? (
              <p className="text-[.7rem] text-muted-foreground">
                Long output and older steps are trimmed.
              </p>
            ) : null}
            {result.value.entries.map((entry) => (
              <TranscriptEntry
                key={entry.id}
                entry={entry}
                threadRef={threadRef}
                markdownCwd={markdownCwd}
              />
            ))}
          </div>
        )
      ) : result._tag === "Failure" ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-destructive-foreground">
            {transcriptErrorMessage(result.cause)}
          </p>
          {isRetryable(result.cause) ? (
            <Button size="compact" variant="ghost" disabled={result.waiting} onClick={retry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}

const isSubagentTranscriptError = Schema.is(SubagentTranscriptError);

/** The server's SubagentTranscriptError carries a user-facing message. */
function transcriptErrorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return isSubagentTranscriptError(error) ? error.message : "Could not load the transcript.";
}

/** A stopped session or a failed request can succeed later; the rest cannot. */
function isRetryable(cause: Cause.Cause<unknown>): boolean {
  const error = Cause.squash(cause);
  return (
    !isSubagentTranscriptError(error) ||
    error.reason === "session-inactive" ||
    error.reason === "unavailable"
  );
}

function TranscriptEntry({
  entry,
  threadRef,
  markdownCwd,
}: {
  entry: SubagentTranscriptEntry;
  threadRef: ScopedThreadRef;
  markdownCwd: string | undefined;
}) {
  switch (entry.kind) {
    case "prompt":
      return (
        <div className="rounded-sm bg-muted/40 px-2 py-1">
          <div className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
            Task
          </div>
          <p className="whitespace-pre-wrap break-words text-xs">{entry.text}</p>
        </div>
      );
    case "reasoning":
      return (
        <p className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
          {entry.text}
        </p>
      );
    case "text":
      return (
        <ChatMarkdown
          text={entry.text}
          cwd={markdownCwd}
          threadRef={threadRef}
          className="text-xs"
        />
      );
    case "tool":
      return (
        <details className="rounded-sm border border-border/50 px-2 py-1">
          <summary className="cursor-pointer truncate font-mono text-[.7rem] text-muted-foreground">
            ▸ {entry.tool}
            {entry.title ? ` · ${entry.title}` : ""}
            {entry.status === "failed" ? " · failed" : ""}
          </summary>
          {entry.input ? (
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[.65rem] text-foreground/80">
              {entry.input}
            </pre>
          ) : null}
          {entry.output ? (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[.65rem] text-foreground/80">
              {entry.output}
            </pre>
          ) : null}
        </details>
      );
  }
}
