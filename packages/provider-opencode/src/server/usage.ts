import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";

import type { OpenCodeSettings } from "../settings.ts";
import { OpenCodeUsageCache, type OpenCodeCachedRow, type OpenCodeRowCache } from "./usageCache.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// OpenCode provider IDs whose bare model IDs LiteLLM prices under its own prefix.
const LITELLM_PREFIXES = new Map([["opencode-go", "opencode_go"]]);
const OPENCODE_GATEWAYS = new Set(["opencode", "opencode-go"]);

function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID);
  const providerId = text(modelReference.providerID) || text(message.providerID);
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  const prefix = LITELLM_PREFIXES.get(providerId);
  const free = OPENCODE_GATEWAYS.has(providerId) && model.endsWith("-free");
  return {
    provider: "opencode",
    timestampMs,
    model,
    ...(prefix !== undefined && !model.includes("/") ? { rateModel: `${prefix}/${model}` } : {}),
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode records zero for unknown rates and paid subscriptions alike, so only its own
    // gateways' free models report zero; shared pricing estimates every other zero.
    reportedCostUsd:
      typeof cost === "number" && Number.isFinite(cost) && (cost > 0 || (free && cost === 0))
        ? cost
        : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
  /** Whether `rowCache` changed and should be saved. */
  readonly cacheChanged: boolean;
}

const isNotFound = (cause: PlatformError.PlatformError) => cause.reason._tag === "NotFound";
const MESSAGE_PAGE_SIZE = 64;
const MARKER_PAGE_SIZE = 2048;
/** Longer than any single OpenCode turn, after which a message's usage no longer changes. */
const SETTLED_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

const isSymbolicLink = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.isSuccess(fileSystem.readLink(path));
});

const entryInfo = Effect.fn("entryInfo")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (yield* isSymbolicLink(path))
    return { type: "SymbolicLink" as const, mtime: Option.none<Date>() };
  return yield* fileSystem.stat(path);
});

const LEGACY_STAT_CONCURRENCY = 4;

// Batch stats so huge directories do not stay in memory.
const LEGACY_STAT_BATCH = 256;

export const readOpenCodeUsage = Effect.fn("readOpenCodeUsage")(function* (
  root: string,
  sinceMs: number,
  retentionCutoffMs = sinceMs,
  rowCache: OpenCodeRowCache = new Map(),
): Effect.fn.Return<OpenCodeUsageReadResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  let found = false;
  let error = false;
  let cacheChanged = false;
  let databaseRows = 0;
  let databasePages = 0;
  const now = yield* Clock.currentTimeMillis;
  const append = (records: UsageRecord[], record: UsageRecord | null) => {
    if (record === null || record.timestampMs < sinceMs) return;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) return;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  };

  const databases = yield* fileSystem.readDirectory(root).pipe(
    Effect.flatMap((names) =>
      Effect.filter(
        names.filter((name) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(name)),
        (name) =>
          entryInfo(path.join(root, name)).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.catchTags({
              PlatformError: (cause) =>
                isNotFound(cause) ? Effect.succeed(false) : Effect.fail(cause),
            }),
          ),
      ),
    ),
    Effect.map((names) =>
      names.sort((a, b) =>
        a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b),
      ),
    ),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (isNotFound(cause)) return Effect.succeed<ReadonlyArray<string> | null>([]);
        error = true;
        return Effect.succeed(null);
      },
    }),
  );
  // Forget databases that were deleted, unless the directory could not be read.
  if (databases !== null) {
    for (const key of rowCache.keys()) {
      const databasePath = key.slice(0, key.indexOf("\0"));
      if (
        path.join(root, path.basename(databasePath)) === databasePath &&
        !databases.includes(path.basename(databasePath))
      ) {
        rowCache.delete(key);
        cacheChanged = true;
      }
    }
  }
  for (const name of databases ?? []) {
    found = true;
    const file = { path: path.join(root, name), records: [] as UsageRecord[] };
    files.push(file);
    // Taken before the snapshot opens, so a write that races the scan invalidates its rows.
    const [main, wal] = yield* Effect.forEach([file.path, `${file.path}-wal`], (target) =>
      Effect.option(fileSystem.stat(target)),
    );
    const stamp = (info: Option.Option<FileSystem.File.Info>) =>
      Option.match(info, {
        onNone: () => "none",
        onSome: (stat) => `${stat.size}:${Option.getOrNull(stat.mtime)?.getTime()}`,
      });
    // A replaced database can repeat rowids and change markers, so every key includes its file.
    const identity = Option.match(main!, {
      onNone: () => "none",
      onSome: (stat) =>
        `${stat.dev}:${Option.getOrNull(stat.ino)}:${Option.getOrNull(stat.birthtime)?.getTime()}`,
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Fail promptly on live-writer locks instead of stalling the server.
      yield* sql.unsafe("PRAGMA busy_timeout = 100");
      const tables = new Set(
        (yield* sql.unsafe<{ readonly name: unknown }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )).map((row) => row.name),
      );
      if (!tables.has("message") && !tables.has("session_message")) error = true;
      const columnsOf = (table: string) =>
        sql
          .unsafe<{ readonly name: unknown }>(`PRAGMA table_info(${table})`)
          .pipe(Effect.map((rows) => new Set(rows.map((row) => row.name))));
      // A fork copies its parent's messages through the boundary under new ids, keeping
      // seq, creation time and data. Resolve each fork to its last copied seq so a copy
      // names its original as (session, seq). A fork whose boundary is gone keeps its usage.
      const forks = new Map<
        string,
        { readonly parent: string; readonly lastCopiedSeq: number; readonly created: number }
      >();
      if (
        tables.has("session_v2") &&
        tables.has("session_message") &&
        (yield* columnsOf("session_message")).has("seq") &&
        (yield* columnsOf("session_v2")).has("fork_boundary")
      ) {
        const resolved = yield* sql.unsafe<{
          readonly id: unknown;
          readonly parent: unknown;
          readonly created: unknown;
          readonly last_copied_seq: unknown;
        }>(
          `SELECT fork.id, fork.fork_session_id AS parent, fork.time_created AS created,
             (SELECT MAX(copied.seq) FROM session_message AS copied
              WHERE copied.session_id = fork.fork_session_id
                AND CASE json_extract(fork.fork_boundary, '$.type')
                  WHEN 'through' THEN copied.seq <= boundary.seq
                  WHEN 'before' THEN copied.seq < boundary.seq
                END) AS last_copied_seq
           FROM session_v2 AS fork
           JOIN session_message AS boundary
             ON boundary.session_id = fork.fork_session_id
            AND boundary.id = json_extract(fork.fork_boundary, '$.messageID')
           WHERE fork.fork_session_id IS NOT NULL AND json_valid(fork.fork_boundary)`,
        );
        for (const row of resolved) {
          if (typeof row.last_copied_seq !== "number" || typeof row.created !== "number") continue;
          forks.set(text(row.id), {
            parent: text(row.parent),
            lastCopiedSeq: row.last_copied_seq,
            created: row.created,
          });
        }
      }
      const original = (sessionId: string, seq: number, created: number) => {
        const visited = new Set<string>();
        let session = sessionId;
        for (
          let fork = forks.get(session);
          fork !== undefined &&
          seq <= fork.lastCopiedSeq &&
          created < fork.created &&
          !visited.has(session);
          fork = forks.get(session)
        ) {
          visited.add(session);
          session = fork.parent;
        }
        return `${session}:${seq}`;
      };
      const originals = new Set<string>();
      for (const table of ["message", "session_message"] as const) {
        if (!tables.has(table)) continue;
        const columns = yield* columnsOf(table);
        const timestamp = columns.has("time_created") ? "time_created" : "NULL";
        const updated = columns.has("time_updated") ? "time_updated" : "NULL";
        const seq = table === "session_message" && columns.has("seq") ? "seq" : "NULL";
        // OpenCode moves time_updated on every write, so checkpoints that rewrite the main file
        // keep rows. Without it an in-place edit can keep the length, so any write counts.
        const version =
          updated === "NULL" ? `${identity}/${stamp(main!)}/${stamp(wal!)}` : identity;
        // OpenCode 2 records a compaction request's spend on its compaction message.
        const usageRows = table === "session_message" ? "type IN ('assistant', 'compaction')" : "1";
        // The time index lists the window without reading message pages, which are scattered across
        // a multi-GB file and take tens of seconds to fetch when the page cache is cold.
        const listed = (yield* sql.unsafe<{ readonly row_id: number; readonly created: unknown }>(
          `SELECT rowid AS row_id, ${timestamp} AS created FROM ${table}
           ${timestamp === "NULL" ? "" : "WHERE time_created >= ?"}`,
          timestamp === "NULL" ? [] : [sinceMs],
        )).toSorted((a, b) => a.row_id - b.row_id);
        databaseRows += listed.length;
        const key = `${file.path}\0${table}`;
        const previous = rowCache.get(key);
        const reusable = previous?.version === version ? previous.rows : undefined;
        // Caches saved before seq was kept fill it from OpenCode's seq index in one cheap read.
        const knownSeq =
          seq !== "NULL" &&
          listed.some((row) => {
            const hit = reusable?.get(row.row_id);
            return hit !== undefined && hit.seq === undefined;
          })
            ? new Map(
                (yield* sql.unsafe<{ readonly row_id: number; readonly seq: unknown }>(
                  `SELECT rowid AS row_id, seq FROM ${table} WHERE seq IS NOT NULL`,
                )).map((row) => [row.row_id, row.seq]),
              )
            : undefined;
        const cached = new Map<number, OpenCodeCachedRow>();
        const unsettled: number[] = [];
        for (const row of listed) {
          let hit = reusable?.get(row.row_id);
          if (hit?.seq === undefined && hit !== undefined && (seq === "NULL" || knownSeq)) {
            hit = { ...hit, seq: knownSeq?.get(row.row_id) ?? null };
            cacheChanged = true;
          }
          // A message's usage stops changing when its turn ends, so older rows are trusted as cached.
          if (
            hit?.seq !== undefined &&
            typeof row.created === "number" &&
            row.created === hit.created &&
            row.created < now - SETTLED_AFTER_MS
          )
            cached.set(row.row_id, hit);
          else unsettled.push(row.row_id);
        }
        const misses: Array<{
          readonly row_id: number;
          readonly updated: unknown;
          readonly size: unknown;
          readonly created: unknown;
          readonly seq: unknown;
        }> = [];
        for (let start = 0; start < unsettled.length; start += MARKER_PAGE_SIZE) {
          const page = unsettled.slice(start, start + MARKER_PAGE_SIZE);
          // octet_length comes from the record header, so message bodies stay unread.
          const markers = yield* sql
            .unsafe<(typeof misses)[number]>(
              `SELECT rowid AS row_id, ${updated} AS updated, octet_length(data) AS size,
                 ${timestamp} AS created, ${seq} AS seq
               FROM ${table} WHERE rowid IN (${page.map(() => "?").join(", ")})`,
              page,
            )
            .pipe(Effect.withTracerEnabled(false));
          for (const row of markers) {
            const hit = reusable?.get(row.row_id);
            if (hit && hit.updated === row.updated && hit.size === row.size) {
              if (hit.seq !== row.seq) cacheChanged = true;
              cached.set(row.row_id, { ...hit, seq: row.seq });
            } else misses.push(row);
          }
        }
        // Filter and project in SQLite: user diffs and assistant bodies can be hundreds of MB.
        const validAssistant = `CASE WHEN typeof(data) = 'text' AND json_valid(data)
          THEN json_type(data, '$.role') IS NULL OR data ->> '$.role' = 'assistant' END`;
        // Omit per-page spans; the enclosing scan records row and page counts.
        for (let start = 0; start < misses.length; start += MESSAGE_PAGE_SIZE) {
          const page = misses.slice(start, start + MESSAGE_PAGE_SIZE);
          databasePages++;
          const rows = yield* sql
            .unsafe<{
              readonly row_id: number;
              readonly id: unknown;
              readonly session_id: unknown;
              readonly data: unknown;
              readonly created: unknown;
            }>(
              `SELECT rowid AS row_id, id, session_id, ${timestamp} AS created, json_object(
                 'tokens', data -> '$.tokens', 'cost', data -> '$.cost',
                 'model', data -> '$.model', 'modelID', data -> '$.modelID',
                 'providerID', data -> '$.providerID',
                 'time', data -> '$.time', 'id', data -> '$.id', 'sessionID', data -> '$.sessionID'
               ) AS data
               FROM ${table}
               WHERE rowid IN (${page.map(() => "?").join(", ")}) AND ${usageRows}
                 AND ${validAssistant}
               ORDER BY rowid`,
              page.map((row) => row.row_id),
            )
            .pipe(Effect.withTracerEnabled(false));
          const parsed = new Map<number, UsageRecord | null>();
          for (const row of rows) {
            parsed.set(
              row.row_id,
              parseOpenCodeMessage(text(row.data), {
                id: text(row.id),
                sessionId: text(row.session_id),
                ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
              }),
            );
          }
          // Rows the SQL filter dropped are cached as empty so they are not read again either.
          for (const row of page) {
            cached.set(row.row_id, {
              updated: row.updated,
              size: row.size,
              created: row.created,
              seq: row.seq,
              record: parsed.get(row.row_id) ?? null,
            });
          }
          yield* Effect.yieldNow;
        }
        for (const row of listed) {
          // A row deleted after the listing has no markers.
          const entry = cached.get(row.row_id);
          if (entry === undefined) continue;
          const record = entry.record;
          if (record !== null && forks.size > 0 && typeof entry.seq === "number") {
            const copyOf = original(record.sessionId, entry.seq, record.timestampMs);
            if (originals.has(copyOf)) continue;
            originals.add(copyOf);
          }
          append(file.records, record);
        }
        // Rows before this window were not listed; keep them for a wider window until retention.
        for (const [rowId, entry] of reusable ?? []) {
          const created = entry.created;
          if (typeof created === "number" && created < sinceMs && created >= retentionCutoffMs)
            cached.set(rowId, entry);
        }
        if (
          misses.length > 0 ||
          previous?.version !== version ||
          previous.rows.size !== cached.size
        )
          cacheChanged = true;
        rowCache.set(key, { version, rows: cached });
      }
    }).pipe(
      (read) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)),
      // Run the scan on a reader worker so large databases do not block the server's event loop.
      NodeSqliteClient.readOnly,
      Effect.provide(
        NodeSqliteClient.layer({ filename: file.path, readonly: true, readerWorker: true }),
      ),
      Effect.catchTags({
        SqlError: () => {
          error = true;
          return Effect.void;
        },
      }),
    );
  }

  const directories = [path.join(root, "storage", "message")];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    yield* Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(directory);
      for (let start = 0; start < names.length; start += LEGACY_STAT_BATCH) {
        const batch = names.slice(start, start + LEGACY_STAT_BATCH);
        const entries = batch.map((name) => path.join(directory, name));
        // stat follows symlinks; avoid expensive readLink failures unless link identity matters.
        const infos = yield* Effect.forEach(
          entries,
          (entry) =>
            fileSystem.stat(entry).pipe(
              Effect.catchTags({
                PlatformError: (cause) =>
                  isNotFound(cause)
                    ? Effect.succeed(null)
                    : isSymbolicLink(entry).pipe(
                        Effect.flatMap((link) =>
                          link ? Effect.succeed(null) : Effect.fail(cause),
                        ),
                      ),
              }),
              Effect.exit,
            ),
          { concurrency: LEGACY_STAT_CONCURRENCY },
        );
        for (const [index, name] of batch.entries()) {
          const entry = entries[index]!;
          const info = yield* infos[index]!;
          if (info?.type === "Directory") {
            if (!(yield* isSymbolicLink(entry))) directories.push(entry);
          } else if (info?.type === "File" && name.endsWith(".json")) {
            const id = name.slice(0, -5);
            // Messages cannot postdate file mtime; older files hold no in-window usage.
            const skip =
              seen.has(`opencode:${id}`) ||
              Option.exists(info.mtime, (mtime) => mtime.getTime() < sinceMs);
            if (found && skip) continue;
            if (yield* isSymbolicLink(entry)) continue;
            found = true;
            if (skip) continue;
            const file = { path: entry, records: [] as UsageRecord[] };
            files.push(file);
            yield* fileSystem.readFileString(entry).pipe(
              Effect.map((source) => append(file.records, parseOpenCodeMessage(source, { id }))),
              Effect.catchTags({
                PlatformError: (cause) => {
                  if (!isNotFound(cause)) error = true;
                  return Effect.void;
                },
              }),
            );
          }
        }
      }
    }).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (!isNotFound(cause)) error = true;
          return Effect.void;
        },
      }),
    );
  }
  yield* Effect.annotateCurrentSpan({
    "usage.database_rows": databaseRows,
    "usage.database_pages": databasePages,
  });
  return { files, missing: !found && !error, error, cacheChanged };
});

const resolveOpenCodeDataDirs = Effect.fn("resolveOpenCodeDataDirs")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const roots = environment["OPENCODE_DATA_DIR"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const defaults = [
    path.join(
      dataHome && path.isAbsolute(dataHome)
        ? dataHome
        : path.join(homeDirectory, ".local", "share"),
      "opencode",
    ),
  ];
  const canonical = new Set<string>();
  for (const root of roots?.length ? roots : defaults) {
    const resolved = path.resolve(expandHomePath(root, homeDirectory));
    canonical.add(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
  }
  return [...canonical];
});

export type OpenCodeUsageReaderEnv = FileSystem.FileSystem | Path.Path | OpenCodeUsageCache;

export const openCodeUsageReader: ProviderUsageReader<OpenCodeSettings, OpenCodeUsageReaderEnv> = {
  kind: "scan",
  provider: "opencode",
  scan: Effect.fn("openCodeUsageReader.scan")(function* ({
    instances,
    windowStartMs,
    retentionCutoffMs,
  }) {
    const cache = yield* OpenCodeUsageCache;
    const roots = new Set<string>();
    for (const instance of instances) {
      for (const root of yield* resolveOpenCodeDataDirs(instance.environment)) roots.add(root);
    }
    return yield* Effect.forEach(
      roots,
      (dir) =>
        cache
          .use((rows) =>
            readOpenCodeUsage(dir, windowStartMs, retentionCutoffMs, rows).pipe(
              Effect.map((result) => [result, result.cacheChanged] as const),
            ),
          )
          .pipe(
            Effect.map((result) => ({
              dir,
              files: result.missing && !result.error ? null : result.files,
              status: result.error ? ("partial" as const) : ("ok" as const),
              ...(result.error ? { message: "Some OpenCode history could not be read." } : {}),
            })),
          ),
      { concurrency: "unbounded" },
    );
  }),
};
