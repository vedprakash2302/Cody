import { BearerConnectionTarget } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment-remote");
const target = new BearerConnectionTarget({
  environmentId,
  label: "Cloud PC",
  connectionId: "saved:cloud-pc",
});

const catalogAtom = Atom.make({ isReady: true, entries: new Map([[environmentId, { target }]]) });
const configsAtom = Atom.make(
  new Map<EnvironmentId, { environment: { capabilities: { previewTunnel?: boolean } } }>(),
);

vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: catalogAtom } }));
vi.mock("~/state/server", () => ({ environmentServerConfigsAtom: configsAtom }));

describe("preview tunnel decision across a reconnect", () => {
  it("keeps tabs on the environment's machine while its server config reloads", async () => {
    const { appAtomRegistry } = await import("~/rpc/atomRegistry");
    const { readPreviewTunnel } = await import("./previewTunnel");

    // Unknown until the server reports its capabilities.
    expect(readPreviewTunnel(environmentId)).toBe(false);
    appAtomRegistry.set(
      configsAtom,
      new Map([[environmentId, { environment: { capabilities: { previewTunnel: true } } }]]),
    );
    expect(readPreviewTunnel(environmentId)).toBe(true);

    // A reconnect drops the config before the new session reports it again.
    appAtomRegistry.set(configsAtom, new Map());
    expect(readPreviewTunnel(environmentId)).toBe(true);

    // A server that stops advertising the tunnel is followed.
    appAtomRegistry.set(
      configsAtom,
      new Map([[environmentId, { environment: { capabilities: {} } }]]),
    );
    expect(readPreviewTunnel(environmentId)).toBe(false);
  });
});
