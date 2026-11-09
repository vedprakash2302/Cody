import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../state/atom-registry";
import { threadFamilies } from "../state/threads";

/**
 * Keeps `rootThreadId`'s family in the thread list while the caller shows it.
 * The shell can leave out older settled threads; a scheduled task row still
 * shows its thread's title. Upstream no longer ships this hook.
 */
export function useThreadFamily(
  environmentId: EnvironmentId | null,
  rootThreadId: ThreadId | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the thread's family into the shared thread registry while the caller shows it
  useEffect(() => {
    if (environmentId === null || rootThreadId === null) return;
    return threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId);
  }, [environmentId, rootThreadId]);
}
