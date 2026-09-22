import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { copyThreads } from "./cody-preview.mjs";

NodeTest.test(
  "snapshot retains threads and PR links without copying sessions or changing the source",
  (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cody-preview-"));
    t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
    const source = NodePath.join(root, "live");
    const preview = NodePath.join(root, "preview");
    NodeFS.mkdirSync(NodePath.join(source, "userdata"), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(NodePath.join(source, "userdata/state.sqlite"));
    t.after(() => db.close());
    db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE projection_threads (title TEXT,pending_approval_count INTEGER,pending_user_input_count INTEGER);
    INSERT INTO projection_threads VALUES ('Real thread',1,1);
    CREATE TABLE projection_thread_pull_requests (number INTEGER);
    INSERT INTO projection_thread_pull_requests VALUES (42);
    CREATE TABLE auth_sessions (token TEXT);
    INSERT INTO auth_sessions VALUES ('production');
    CREATE TABLE provider_session_runtime (id TEXT);
    INSERT INTO provider_session_runtime VALUES ('active');
    CREATE TABLE projection_thread_sessions (status TEXT,active_turn_id TEXT);
    INSERT INTO projection_thread_sessions VALUES ('running','turn-1');`);
    copyThreads(source, preview);
    const copied = new NodeSqlite.DatabaseSync(NodePath.join(preview, "userdata/state.sqlite"));
    NodeAssert.equal(
      copied.prepare("SELECT title FROM projection_threads").get().title,
      "Real thread",
    );
    NodeAssert.equal(
      copied.prepare("SELECT number FROM projection_thread_pull_requests").get().number,
      42,
    );
    NodeAssert.equal(copied.prepare("SELECT count(*) AS n FROM auth_sessions").get().n, 0);
    NodeAssert.equal(
      copied.prepare("SELECT count(*) AS n FROM provider_session_runtime").get().n,
      0,
    );
    NodeAssert.equal(
      copied.prepare("SELECT status FROM projection_thread_sessions").get().status,
      "stopped",
    );
    copied.close();
    NodeAssert.equal(db.prepare("SELECT token FROM auth_sessions").get().token, "production");
    NodeAssert.equal(
      db.prepare("SELECT status FROM projection_thread_sessions").get().status,
      "running",
    );
    NodeAssert.throws(() => copyThreads(source, source), /must differ/);
    NodeFS.writeFileSync(
      NodePath.join(preview, "userdata/server-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    NodeAssert.throws(() => copyThreads(source, preview), /Stop the preview/);
  },
);
