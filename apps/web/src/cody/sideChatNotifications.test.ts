import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  threadCompletionIsQuiet,
  type ThreadNotificationObservation,
} from "../components/ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed: ThreadNotificationObservation = { attention: null, settled: true, completedAt: 1 };
const approval: ThreadNotificationObservation = {
  attention: "run-1:approval",
  settled: false,
  completedAt: null,
};

function observeSequence(
  thread: Parameters<typeof threadCompletionIsQuiet>[0],
  sequence: ReadonlyArray<ThreadNotificationObservation>,
) {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  for (const next of sequence) {
    gate.observe("thread", prior, next, {
      archived: false,
      quiet: threadCompletionIsQuiet(thread),
    });
    prior = next;
  }
  vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
  return notify.mock.calls.map(([, kind]) => kind);
}

describe("side chat notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not announce a side chat's finished answer", () => {
    expect(observeSequence({ codySideChat: true }, [working, completed])).toEqual([]);
  });

  it("still announces a side chat's approval request", () => {
    expect(observeSequence({ codySideChat: true }, [working, approval])).toEqual(["input"]);
  });

  it("announces an ordinary thread's finished answer", () => {
    expect(observeSequence({}, [working, completed])).toEqual(["completion"]);
  });
});
