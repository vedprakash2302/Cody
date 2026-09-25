import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

export const WindowsSsoPath = Context.Reference<string | undefined>(
  "@t3tools/desktop/preview/WindowsSsoPath",
  { defaultValue: () => undefined },
);

export const layer = Layer.effect(
  WindowsSsoPath,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    if (environment.platform !== "win32") return undefined;
    const fs = yield* FileSystem.FileSystem;
    const relative = environment.path.join("windows-sso", "t3-windows-sso.exe");
    const candidates = environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, relative)]
      : [
          environment.path.join(
            environment.rootDir,
            "native/windows-browser-sso/build",
            environment.processArch,
            "t3-windows-sso.exe",
          ),
          ...environment.resolveResourcePathCandidates(relative),
        ];
    for (const candidate of candidates) {
      if (yield* fs.exists(candidate)) return candidate;
    }
    return undefined;
  }),
);
