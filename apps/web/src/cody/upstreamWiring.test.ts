// @effect-diagnostics nodeBuiltinImport:off - reads real source files on disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// Cody's side chat extras and scheduled task thread labels each hang off a few lines
// in an upstream file. A sync that takes upstream's file whole drops them
// without breaking a type or another test, so this checks the lines are there.
const source = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

describe("Cody's hooks into upstream files", () => {
  it.each([
    [
      "../components/chat/SideChatPane.tsx",
      ["<CodySideChatBar", "CODY_SIDE_CHAT_BAR ?", "<CodySideChatTitle", "<CodySideChatComposers"],
    ],
    [
      "../components/chat/AssistantSelectionToolbar.tsx",
      ["<CodyAskInSideChat", "sourceAnchor={selection.sourceAnchor}"],
    ],
    ["../components/chat/TimelineAssistantRows.tsx", ["<CodyAssistantActions"]],
    [
      "../components/chat/useSideChat.ts",
      ["...(fromRunId === undefined ? {} : { runId: fromRunId })"],
    ],
    ["../lib/assistantTextSelection.ts", ["export function readAssistantText"]],
    [
      "../../../../packages/client-runtime/src/operations/commands.ts",
      [
        'input.runId === undefined ? { type: "latest_stable" } : { type: "run", runId: input.runId }',
      ],
    ],
    [
      "../components/CommandPalette.tsx",
      ["useCodySideChatPaletteItems(activeThread)", "actionItems.push(...codySideChatItems)"],
    ],
    ["../components/ChatView.tsx", ['"thread.sideChat": ({ event }) =>']],
    [
      "../components/settings/ScheduledTasksSettings.tsx",
      ['from "../../cody/useThreadFamily"', "useThreadFamily(environmentId, task.threadId)"],
    ],
    [
      "../../../mobile/src/features/settings/SettingsScheduledTasksRouteScreen.tsx",
      [
        'from "../../cody/useThreadFamily"',
        "useThreadFamily(props.environmentId, props.threadId)",
        "<ScheduledTaskThreadLabel environmentId={environmentId} threadId={task.threadId} />",
      ],
    ],
  ] as const)("%s keeps Cody's lines", (path, lines) => {
    const text = source(path);
    for (const line of lines) expect(text).toContain(line);
  });
});
