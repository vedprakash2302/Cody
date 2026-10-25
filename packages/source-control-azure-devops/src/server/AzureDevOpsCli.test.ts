import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

type ProcessInput = SourceControlHost.SourceControlProcessInput;

/** Runs real commands the way the server's process runner would, environment included. */
const makeRunReal =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => (input: ProcessInput) =>
    spawner
      .string(
        ChildProcess.make(input.command, [...input.args], {
          cwd: input.cwd,
          ...(input.env ? { env: input.env } : {}),
        }),
      )
      .pipe(Effect.map(processOutput), Effect.orDie);

const layerAzureDevOpsCliWith = (
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
) => AzureDevOpsCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run } })));

const mockRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

const layerSupport = Layer.mergeAll(
  TestSourceControlHost.layer({
    process: {
      run: (input) =>
        input.command === "git" ? Effect.succeed(processOutput("")) : mockRun(input),
    },
  }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(AzureDevOpsCli.layer.pipe(Layer.provide(layerSupport)), layerSupport);

afterEach(() => {
  mockRun.mockReset();
});

describe("AzureDevOpsCli.layer", () => {
  it.effect("resolves cwd's remotes despite inherited Git repository bindings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runReal = makeRunReal(yield* ChildProcessSpawner.ChildProcessSpawner);
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-azure-scope-" });
      const target = path.join(root, "target");
      const unrelated = path.join(root, "unrelated");
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      for (const name of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ]) {
        vi.stubEnv(name, undefined);
      }
      for (const [cwd, org] of [
        [target, "target"],
        [unrelated, "unrelated"],
      ] as const) {
        yield* runReal({
          operation: "test",
          command: "git",
          cwd: root,
          args: ["init", "--quiet", cwd],
        });
        yield* runReal({
          operation: "test",
          command: "git",
          cwd,
          args: ["remote", "add", "origin", `https://dev.azure.com/${org}/Project/_git/Repo`],
        });
      }
      vi.stubEnv("GIT_DIR", path.join(unrelated, ".git"));
      vi.stubEnv("GIT_WORK_TREE", unrelated);
      const azArgs: string[][] = [];
      const scopedLayer = layerAzureDevOpsCliWith((input) => {
        if (input.command === "git") return runReal(input);
        return Effect.sync(() => {
          azArgs.push([...input.args]);
          return processOutput("[]");
        });
      });
      yield* Effect.gen(function* () {
        const az = yield* AzureDevOpsCli.AzureDevOpsCli;
        yield* az.execute({ cwd: target, args: ["repos", "pr", "list", "--detect", "true"] });
      }).pipe(Effect.provide(scopedLayer));
      expect(azArgs[0]).toContain("https://dev.azure.com/target");
      expect(azArgs[0]).not.toContain("https://dev.azure.com/unrelated");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not inspect Git for account queries or explicitly scoped commands", () =>
    Effect.gen(function* () {
      const calls: Array<ProcessInput> = [];
      const scopedLayer = layerAzureDevOpsCliWith((input) => {
        calls.push(input);
        return Effect.succeed(processOutput("{}"));
      });
      yield* Effect.gen(function* () {
        const az = yield* AzureDevOpsCli.AzureDevOpsCli;
        for (const args of [
          ["account", "show"],
          [
            "repos",
            "pr",
            "show",
            "--detect",
            "true",
            "--organization",
            "https://dev.azure.com/explicit",
            "--id",
            "42",
          ],
          ["repos", "pr", "show", "--detect", "false", "--id", "42"],
        ]) {
          yield* az.execute({ cwd: "/repo", args });
          expect(calls.at(-1)?.args).toEqual(args);
        }
      }).pipe(Effect.provide(scopedLayer));
      expect(calls).toHaveLength(3);
      expect(calls.every((call) => call.command === "az")).toBe(true);
    }),
  );

  it.effect(
    "uses server-side Git scope for PR detail, listing, and REST reads across checkouts",
    () =>
      Effect.gen(function* () {
        const calls: Array<ProcessInput> = [];
        const scopedLayer = layerAzureDevOpsCliWith((input) => {
          calls.push(input);
          if (input.command === "git")
            return Effect.succeed(
              processOutput(
                `remote.origin.url https://${input.cwd === "/one" ? "acme" : "other"}.visualstudio.com/DefaultCollection/Project/_git/Repo\n`,
              ),
            );
          // Simulate the Windows CLI: local repository detection never works.
          if (input.args?.includes("true"))
            return Effect.fail(
              new VcsProcessExitError({
                operation: "test",
                command: "az",
                cwd: input.cwd ?? "/one",
                exitCode: 1,
                detail: "--organization must be specified",
              }),
            );
          return Effect.succeed(processOutput("[]"));
        });
        yield* Effect.gen(function* () {
          const az = yield* AzureDevOpsCli.AzureDevOpsCli;
          for (const [cwd, command] of [
            ["/one", ["repos", "pr", "show", "--id", "42"]],
            ["/two", ["repos", "pr", "list"]],
            ["/one", ["devops", "invoke", "--area", "git"]],
          ] as const) {
            yield* az.execute({ cwd, args: [...command, "--detect", "true"] });
          }
        }).pipe(Effect.provide(scopedLayer));
        const commands = calls.filter((call) => call.command === "az");
        expect(
          commands.map((call) => call.args?.slice(call.args.indexOf("--organization"))),
        ).toEqual([
          ["--organization", "https://dev.azure.com/acme"],
          [
            "--organization",
            "https://dev.azure.com/other",
            "--project",
            "Project",
            "--repository",
            "Repo",
          ],
          ["--organization", "https://dev.azure.com/acme"],
        ]);
      }),
  );

  it.effect("scopes the Pull Requests listing through the server's Azure stack", () =>
    Effect.gen(function* () {
      const calls: Array<ProcessInput> = [];
      // The same composition the server's built-in Azure DevOps driver provides.
      const serverLayer = AzureDevOpsPullRequestCli.layer.pipe(
        Layer.provideMerge(
          layerAzureDevOpsCliWith((input) => {
            calls.push(input);
            return Effect.succeed(
              processOutput(
                input.command === "git"
                  ? "remote.origin.url git@ssh.dev.azure.com:v3/acme/Platform/web\n"
                  : "[]",
              ),
            );
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const cli = yield* AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli;
        yield* cli.listPullRequests({
          cwd: "/w",
          repository: "web",
          state: "open",
          involvement: "all",
          viewer: "ved@acme.dev",
          limit: 10,
        });
      }).pipe(Effect.provide(serverLayer));
      const az = calls.filter((call) => call.command === "az");
      expect(az.length).toBeGreaterThan(0);
      for (const call of az) {
        expect(call.args).not.toContain("true");
        expect(call.args).toContain("https://dev.azure.com/acme");
        expect(call.args).toContain("Platform");
      }
    }),
  );

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              lastMergeSourceCommit: { commitId: "a".repeat(40) },
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.headSha, "a".repeat(40));
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      const { classifyFailure, ...call } = mockRun.mock.calls.at(-1)?.[0] ?? {};
      assert.strictEqual(
        classifyFailure?.("Please run az login to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("Please run 'az login' to setup account."),
        "authentication",
      );
      assert.strictEqual(
        classifyFailure?.("TF401180: The requested pull request was not found."),
        "not-found",
      );
      assert.deepStrictEqual(call, {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        notFoundDetail: "Pull request not found.",
        timeoutMs: 30_000,
      });
      assert.strictEqual(result.isCrossRepository, false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks a pull request from a fork as cross-repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 43,
              title: "From a fork",
              sourceRefName: "refs/heads/main",
              targetRefName: "refs/heads/main",
              status: "active",
              forkSource: { name: "refs/heads/main", repository: { name: "repo-fork" } },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({ cwd: "/repo", reference: "43" });

      assert.strictEqual(result.isCrossRepository, true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("builds a web URL when Azure returns only the pull request REST URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 863,
              title: "Fix Azure link",
              url: "https://dev.azure.com/saplyai/a8fe4088-ad76-4eda-aaaa-e3329713a097/_apis/git/repositories/16108a25-93a3-4eff-b77d-85e894ee0fe4/pullRequests/863",
              repository: {
                name: "CV-engine",
                project: {
                  name: "CV-engine",
                },
              },
              sourceRefName: "refs/heads/feature/azure-pr-link",
              targetRefName: "refs/heads/main",
              status: "active",
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "863",
      });

      assert.strictEqual(
        result.url,
        "https://dev.azure.com/saplyai/CV-engine/_git/CV-engine/pullrequest/863",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves VCS causes without copying upstream details into messages", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az repos list --organization sensitive-upstream-detail",
        cwd: "/repo",
        exitCode: 1,
        detail: "sensitive-upstream-detail",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.operation, "execute");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.argumentCount, 2);
      assert.strictEqual(error.detail, "Azure DevOps CLI command failed.");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes("sensitive-upstream-detail"), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not report a missing working directory as a missing Azure CLI", () =>
    Effect.gen(function* () {
      const cwd = "/missing/repo";
      const platformCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: "chdir",
        pathOrDescriptor: cwd,
      });
      const cause = new VcsProcessSpawnError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd,
        argumentCount: 2,
        cause: platformCause,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd, args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.cwd, cwd);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 2,
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCliRateLimitError);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});
