import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export interface OpenCodeCachedRow {
  readonly updated: unknown;
  readonly size: unknown;
  readonly created: unknown;
  readonly record: UsageRecord | null;
}

/** Parsed rows by `${databasePath}\0${table}`, then rowid, so unchanged rows are not read again. */
export type OpenCodeRowCache = Map<
  string,
  { readonly version: string; readonly rows: ReadonlyMap<number, OpenCodeCachedRow> }
>;

/** Versioned files isolate caches for different server versions sharing a state directory. */
const OPENCODE_USAGE_CACHE_FILE_NAME = "usage-opencode-cache-v1.json";
const OPENCODE_USAGE_CACHE_VERSION = 1;
const ROWS_PER_CHUNK = 2048;

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  rateModelIndex: number | null,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  reportedCostUsd: number | null,
  dedupeKey: string | null,
];

type SerializedRow = readonly [
  rowId: number,
  updated: number | null,
  size: number | null,
  created: number | null,
  record: SerializedRecord | null,
];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isMarker = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

/** Streams the cache so a large history neither builds one string nor blocks the event loop. */
function* encodeOpenCodeRowCache(cache: OpenCodeRowCache): Generator<string> {
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const intern = (value: string) => {
    let index = indexes.get(value);
    if (index === undefined) {
      index = strings.length;
      strings.push(value);
      indexes.set(value, index);
    }
    return index;
  };
  const encodeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(record.model),
    record.rateModel === undefined ? null : intern(record.rateModel),
    intern(record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.reportedCostUsd,
    record.dedupeKey,
  ];
  yield '{"tables":{';
  for (const [index, [key, table]] of [...cache].entries()) {
    yield `${index === 0 ? "" : ","}${JSON.stringify(key)}:{"version":${JSON.stringify(table.version)},"rows":[`;
    let chunk: SerializedRow[] = [];
    let first = true;
    const flush = () => {
      const encoded = JSON.stringify(chunk).slice(1, -1);
      const separator = first ? "" : ",";
      first = false;
      chunk = [];
      return separator + encoded;
    };
    for (const [rowId, row] of table.rows) {
      // Markers SQLite returns as other types cannot be compared after a round trip.
      if (!isMarker(row.updated) || !isMarker(row.size) || !isMarker(row.created)) continue;
      chunk.push([
        rowId,
        row.updated,
        row.size,
        row.created,
        row.record === null ? null : encodeRecord(row.record),
      ]);
      if (chunk.length === ROWS_PER_CHUNK) yield flush();
    }
    if (chunk.length > 0) yield flush();
    yield "]}";
  }
  yield `},"version":${OPENCODE_USAGE_CACHE_VERSION},"strings":${JSON.stringify(strings)}}`;
}

/** Drops a malformed table whole; its remaining rows would be read again anyway. */
function decodeOpenCodeRowCache(document: unknown): OpenCodeRowCache {
  const cache: OpenCodeRowCache = new Map();
  if (typeof document !== "object" || document === null) return cache;
  const root = document as {
    readonly version?: unknown;
    readonly strings?: unknown;
    readonly tables?: unknown;
  };
  const strings = root.strings;
  if (
    root.version !== OPENCODE_USAGE_CACHE_VERSION ||
    !Array.isArray(strings) ||
    !strings.every((value): value is string => typeof value === "string") ||
    typeof root.tables !== "object" ||
    root.tables === null
  ) {
    return cache;
  }
  const stringAt = (index: unknown): string | undefined =>
    typeof index === "number" ? strings[index] : undefined;

  const decodeRecord = (value: unknown): UsageRecord | undefined => {
    if (!Array.isArray(value)) return undefined;
    const [
      timestampMs,
      modelIndex,
      rateModelIndex,
      sessionIndex,
      uncached,
      cached,
      creation,
      output,
      reasoning,
      cost,
      dedupeKey,
    ]: readonly unknown[] = value;
    const model = stringAt(modelIndex);
    const rateModel = rateModelIndex === null ? null : stringAt(rateModelIndex);
    const sessionId = stringAt(sessionIndex);
    if (
      !isFiniteNumber(timestampMs) ||
      model === undefined ||
      rateModel === undefined ||
      sessionId === undefined ||
      !isFiniteNumber(uncached) ||
      !isFiniteNumber(cached) ||
      !isFiniteNumber(creation) ||
      !isFiniteNumber(output) ||
      !isFiniteNumber(reasoning) ||
      (cost !== null && !isFiniteNumber(cost)) ||
      (dedupeKey !== null && typeof dedupeKey !== "string")
    ) {
      return undefined;
    }
    return {
      provider: "opencode",
      timestampMs,
      model,
      ...(rateModel === null ? {} : { rateModel }),
      sessionId,
      totals: {
        uncachedInputTokens: uncached,
        cachedInputTokens: cached,
        cacheCreationTokens: creation,
        outputTokens: output,
        reasoningTokens: reasoning,
      },
      reportedCostUsd: cost,
      speed: "standard",
      dedupeKey,
    };
  };

  for (const [key, raw] of Object.entries(root.tables)) {
    if (typeof raw !== "object" || raw === null) continue;
    const table = raw as { readonly version?: unknown; readonly rows?: unknown };
    if (typeof table.version !== "string" || !Array.isArray(table.rows)) continue;
    const rows = new Map<number, OpenCodeCachedRow>();
    for (const value of table.rows) {
      if (!Array.isArray(value)) break;
      const [rowId, updated, size, created, encoded]: readonly unknown[] = value;
      const record = encoded === null ? null : decodeRecord(encoded);
      if (
        !Number.isSafeInteger(rowId) ||
        !isMarker(updated) ||
        !isMarker(size) ||
        !isMarker(created) ||
        record === undefined
      ) {
        break;
      }
      rows.set(rowId as number, { updated, size, created, record });
    }
    if (rows.size !== table.rows.length) continue;
    cache.set(key, { version: table.version, rows });
  }
  return cache;
}

const decodeCacheFile = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class OpenCodeUsageCache extends Context.Service<
  OpenCodeUsageCache,
  {
    /** Runs scans one at a time against the saved rows, then saves them when `scan` changed them. */
    readonly use: <A, E, R>(
      scan: (rows: OpenCodeRowCache) => Effect.Effect<readonly [A, changed: boolean], E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("@t3tools/provider-opencode/server/usageCache/OpenCodeUsageCache") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;

  const cachePath = path.join(host.paths.stateDir, OPENCODE_USAGE_CACHE_FILE_NAME);
  const rows: OpenCodeRowCache = new Map();
  let cacheDirty = false;
  // Concurrent scans of the same database would each read every uncached row.
  const scanLock = yield* Semaphore.make(1);

  const ensureLoaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap(decodeCacheFile),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.map((document) => {
        for (const [key, table] of decodeOpenCodeRowCache(document)) rows.set(key, table);
      }),
    ),
  );

  // Serialize snapshots; clear dirty before encoding and restore it on failure so changes retry.
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    // Scans replace tables rather than edit them, so a snapshot of the entries stays consistent.
    const snapshot: OpenCodeRowCache = new Map(rows);
    yield* writeFileStringAtomically({
      filePath: cachePath,
      contents: encodeOpenCodeRowCache(snapshot),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("OpenCodeUsageCache.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const use: OpenCodeUsageCache["Service"]["use"] = Effect.fn("OpenCodeUsageCache.use")(function* (
    scan,
  ) {
    yield* ensureLoaded;
    const [result, changed] = yield* scan(rows);
    if (changed) {
      cacheDirty = true;
      yield* schedulePersist;
    }
    return result;
  }, scanLock.withPermit);

  return OpenCodeUsageCache.of({ use, awaitPersisted });
});

export const layer = Layer.effect(OpenCodeUsageCache, make);
