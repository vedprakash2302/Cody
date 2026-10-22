import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { openSideChatsOf } from "./codySideChats.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const environmentId = EnvironmentId.make("environment-side-chats");
const main = v2ThreadShell;
const sideChat = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) => ({
  ...main,
  id: ThreadId.make(id),
  codySideChat: true,
  lineage: { ...main.lineage, parentThreadId: main.id, relationshipToParent: "fork" as const },
  ...overrides,
});

describe("Cody side chats in client state", () => {
  it("keeps side chats out of every thread list but still resolves them by ref", () => {
    const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make<OrchestrationV2ShellSnapshot | null>({
        ...v2ShellSnapshot,
        threads: [main, sideChat("side")],
      }),
    );
    const catalogValueAtom = Atom.make({
      isReady: true,
      entries: new Map([
        [
          environmentId,
          {
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Environment",
              httpBaseUrl: "https://example.test",
              wsBaseUrl: "wss://example.test",
            }),
            profile: Option.none(),
            enabled: true,
          },
        ],
      ]),
    });
    const threads = createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom });
    const registry = AtomRegistry.make();

    expect(registry.get(threads.threadShellsAtom).map((thread) => thread.id)).toEqual([main.id]);
    expect(registry.get(threads.navigationThreadShellsAtom).map((thread) => thread.id)).toEqual([
      main.id,
    ]);
    expect(registry.get(threads.quietThreadShellsAtom).map((thread) => thread.id)).toEqual([
      main.id,
    ]);
    expect(
      registry.get(threads.threadShellAtom({ environmentId, threadId: ThreadId.make("side") }))
        ?.source.codySideChat,
    ).toBe(true);
    registry.dispose();
  });

  it("lists a thread's open side chats, newest activity first", () => {
    const later = DateTime.add(main.updatedAt, { minutes: 5 });
    const open = openSideChatsOf(
      [
        main,
        sideChat("older"),
        sideChat("newer", { updatedAt: later }),
        sideChat("closed", { archivedAt: later }),
        sideChat("other-parent", {
          lineage: { ...main.lineage, parentThreadId: ThreadId.make("elsewhere") },
        }),
        { ...sideChat("plain-fork"), codySideChat: false },
      ],
      main.id,
    );
    expect(open.map((thread) => thread.id)).toEqual(["newer", "older"]);
  });
});
