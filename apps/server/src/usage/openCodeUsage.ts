// @effect-diagnostics nodeBuiltinImport:off
/**
 * Usage records from OpenCode's own SQLite store.
 *
 * OpenCode keeps sessions in `opencode.db` rather than JSONL transcripts, and
 * every finished assistant message already carries its token counts and an
 * API-equivalent cost from OpenCode's model catalog. A 30-day query over a few
 * thousand messages takes tens of milliseconds, so this runs on every scan
 * instead of joining the per-file transcript cache.
 *
 * The database belongs to a running OpenCode process. It is only ever opened
 * read-only.
 *
 * @module openCodeUsage
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageRecord } from "./usageTranscripts.ts";

/** Stable installs use `opencode.db`; other release channels get `opencode-<channel>.db`. */
const DATABASE_FILE = /^opencode(-[A-Za-z0-9._-]+)?\.db$/;

/**
 * Database files OpenCode may be writing for this data directory, mirroring
 * OpenCode's own resolution: `OPENCODE_DB` wins, otherwise every channel's
 * database in `<data>/opencode`.
 */
export async function listOpenCodeDatabases(
  dataDir: string,
  openCodeDb: string | undefined,
): Promise<readonly string[]> {
  const override = openCodeDb?.trim();
  if (override) {
    return override === ":memory:" ? [] : [NodePath.resolve(dataDir, override)];
  }
  try {
    const entries = await NodeFSP.readdir(dataDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && DATABASE_FILE.test(entry.name))
      .map((entry) => NodePath.join(dataDir, entry.name))
      .toSorted();
  } catch {
    return [];
  }
}

export interface OpenCodeMessageRow {
  readonly sessionId: string;
  readonly createdMs: number;
  readonly model: unknown;
  readonly cost: unknown;
  readonly input: unknown;
  readonly output: unknown;
  readonly reasoning: unknown;
  readonly cacheRead: unknown;
  readonly cacheWrite: unknown;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Maps one assistant message to a usage record.
 *
 * OpenCode's `input` excludes both cache reads and writes, and its `output`
 * excludes reasoning, so reasoning is added back to output to match the
 * contract's "reasoning is a subset of output" rule.
 *
 * Forking a session copies its messages under new ids while keeping their
 * creation time and tokens, so the dedupe key is built from those instead of
 * the message id.
 */
export function openCodeRowToRecord(row: OpenCodeMessageRow): UsageRecord | null {
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!model) return null;
  const input = int(row.input);
  const output = int(row.output);
  const reasoning = int(row.reasoning);
  const cacheRead = int(row.cacheRead);
  const cacheWrite = int(row.cacheWrite);
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return null;
  const cost =
    typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost > 0 ? row.cost : null;
  return {
    provider: "opencode",
    timestampMs: row.createdMs,
    model,
    sessionId: row.sessionId,
    totals: {
      uncachedInputTokens: input,
      cachedInputTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      outputTokens: output + reasoning,
      reasoningTokens: reasoning,
    },
    // Zero means OpenCode's catalog had no price, not that the tokens were
    // free; leave it to the rate table.
    reportedCostUsd: cost,
    dedupeKey: `opencode:${row.createdMs}:${model}:${input}:${output}:${reasoning}:${cacheRead}:${cacheWrite}`,
  };
}

const MESSAGES_SQL = `
  SELECT
    session_id AS sessionId,
    time_created AS createdMs,
    json_extract(data, '$.modelID') AS model,
    json_extract(data, '$.cost') AS cost,
    json_extract(data, '$.tokens.input') AS input,
    json_extract(data, '$.tokens.output') AS output,
    json_extract(data, '$.tokens.reasoning') AS reasoning,
    json_extract(data, '$.tokens.cache.read') AS cacheRead,
    json_extract(data, '$.tokens.cache.write') AS cacheWrite
  FROM message
  WHERE time_created >= ?
    AND json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.time.completed') IS NOT NULL
`;

/**
 * Finished assistant messages created at or after `sinceMs`. Returns `null`
 * when the database cannot be opened or queried, which callers report as a
 * failed source rather than an empty one.
 */
export function readOpenCodeUsageRecords(
  databasePath: string,
  sinceMs: number,
): readonly UsageRecord[] | null {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    // A short busy timeout rides out OpenCode's WAL checkpoints.
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true, timeout: 1_000 });
    const rows = database.prepare(MESSAGES_SQL).all(sinceMs) as unknown as OpenCodeMessageRow[];
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = openCodeRowToRecord(row);
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
