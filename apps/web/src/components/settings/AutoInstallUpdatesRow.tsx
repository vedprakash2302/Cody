import { useCallback, useEffect, useState } from "react";

import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

/** Cody: lets this machine install updates by itself once no agent is running. */
export function AutoInstallUpdatesRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const getAutoInstall = bridge?.getAutoInstallUpdates;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!getAutoInstall) return;
    let cancelled = false;
    void getAutoInstall()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getAutoInstall]);

  const handleChange = useCallback((checked: boolean) => {
    const setAutoInstall = window.desktopBridge?.setAutoInstallUpdates;
    if (!setAutoInstall) return;
    setIsSaving(true);
    void setAutoInstall(checked)
      .then(setEnabled)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change automatic updates",
            description: error instanceof Error ? error.message : "Saving the setting failed.",
          }),
        );
      })
      .finally(() => setIsSaving(false));
  }, []);

  if (!getAutoInstall || enabled === null) return null;
  return (
    <SettingsRow
      title="Install updates automatically"
      description="Download new versions and restart into them after agents on this machine have been idle for 5 minutes."
      control={
        <Switch
          checked={enabled}
          disabled={isSaving}
          onCheckedChange={(checked) => handleChange(Boolean(checked))}
          aria-label="Install updates automatically"
        />
      }
    />
  );
}
