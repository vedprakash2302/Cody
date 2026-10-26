import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessagesSquareIcon, XIcon } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../components/ContextChip";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useProject, useThreadShell } from "../state/entities";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The thread's chip in the side chat composer: the next message carries what the thread finished since. */
export function SideChatMainUpdateChip(props: {
  readonly parentRef: ScopedThreadRef;
  readonly responses: number;
  readonly files: number;
  readonly onRemove: () => void;
}) {
  const shell = useThreadShell(props.parentRef);
  const project = useProject(
    shell ? scopeProjectRef(props.parentRef.environmentId, shell.projectId) : null,
  );
  const title = shell?.title?.trim() || "Thread";
  const summary = [
    `${props.responses} new`,
    ...(props.files === 0 ? [] : [plural(props.files, "file", "files")]),
  ].join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip kind="thread" aria-label={`Thread update, ${title}, ${summary}`}>
            {project ? (
              <ProjectFavicon project={project} className="size-[1.17em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
            <span className="shrink-0 self-center leading-tight opacity-70">· {summary}</span>
            <ContextChipAction aria-label="Leave out the thread's update" onClick={props.onRemove}>
              <XIcon aria-hidden="true" />
            </ContextChipAction>
          </ContextChip>
        }
      />
      <TooltipPopup>
        Your next message brings the side chat up to date with the thread's{" "}
        {plural(props.responses, "new response", "new responses")}
        {props.files === 0 ? "" : ` and ${plural(props.files, "changed file", "changed files")}`}.
      </TooltipPopup>
    </Tooltip>
  );
}
