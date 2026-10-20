import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const question = (requestId: string) => ({
  requestId: RuntimeRequestId.make(requestId),
  createdAt: "2026-10-20T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [
    {
      id: "question",
      header: "Approach",
      question: "Which approach?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: false,
    },
  ],
});

const onMainToggle = vi.fn();
const onScopedToggle = vi.fn();

function TwoQuestions() {
  const shared = {
    cwd: "/repo",
    threadRef,
    respondingRequestIds: [],
    answers: {},
    questionIndex: 0,
    onAdvance: () => {},
    onDismiss: () => {},
  };
  return (
    <>
      <ComposerPendingUserInputPanel
        {...shared}
        pendingUserInputs={[question("main")]}
        onToggleOption={onMainToggle}
      />
      <div data-composer-shortcut-scope="side">
        <button type="button">Inside the side composer</button>
        <ComposerPendingUserInputPanel
          {...shared}
          pendingUserInputs={[question("side")]}
          onToggleOption={onScopedToggle}
          shortcutScope="side"
        />
      </div>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onMainToggle.mockClear();
  onScopedToggle.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<TwoQuestions />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const pressOne = (target: EventTarget) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
  });

it("answers only the unscoped question for a key pressed outside every scope", async () => {
  await pressOne(document.body);
  expect(onMainToggle).toHaveBeenCalledWith("question", "Incremental");
  expect(onScopedToggle).not.toHaveBeenCalled();
});

it("answers only the scoped question for a key pressed inside its scope", async () => {
  const inside = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Inside the side composer",
  )!;
  await pressOne(inside);
  expect(onScopedToggle).toHaveBeenCalledWith("question", "Incremental");
  expect(onMainToggle).not.toHaveBeenCalled();
});
