import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessagesSquareIcon, XIcon } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../components/ContextChip";
import { ProjectFavicon } from "../components/ProjectFavicon";
import { useProject, useThreadShell } from "../state/entities";

/** Main's thread chip in the side chat composer: the next message carries main's update. */
export function SideChatMainUpdateChip(props: {
  readonly parentRef: ScopedThreadRef;
  readonly onRemove: () => void;
}) {
  const shell = useThreadShell(props.parentRef);
  const project = useProject(
    shell ? scopeProjectRef(props.parentRef.environmentId, shell.projectId) : null,
  );
  const title = shell?.title?.trim() || "Main";
  return (
    <ContextChip kind="thread" aria-label={`Thread, ${title}`}>
      {project ? (
        <ProjectFavicon project={project} className="size-[1.17em] self-center" />
      ) : (
        <MessagesSquareIcon />
      )}
      <ContextChipLabel>{title}</ContextChipLabel>
      <ContextChipAction aria-label="Remove main's update" onClick={props.onRemove}>
        <XIcon aria-hidden="true" />
      </ContextChipAction>
    </ContextChip>
  );
}
