import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: mocks }),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  },
}));

vi.mock("~/components/preview/usePreviewBridge", () => ({
  usePreviewBridge: () => undefined,
}));

vi.mock("./browserRecording", () => ({
  useActiveBrowserRecordingTabIds: () => mocks.activeRecordings,
  stopBrowserRecording: async () => null,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

let renderer: ReactTestRenderer | undefined;

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useFakeTimers();
  await act(() => renderer?.unmount());
  renderer = undefined;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HostedBrowserWebview settings hydration", () => {
  it("starts a retained background tab only after a settings read succeeds on retry", async () => {
    const firstRead = deferred<ClientSettings | null>();
    const retryRead = deferred<ClientSettings | null>();
    const tabCreation = deferred<void>();
    mocks.getClientSettings
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retryRead.promise);
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const acquire = vi.spyOn(desktopTabLifetime, "acquireDesktopTab");
    const createGuest = vi.fn((_attributes: unknown) =>
      Object.assign(new EventTarget(), { getWebContentsId: () => 41 }),
    );
    const threadRef = {
      environmentId: EnvironmentId.make("host-settings-retry"),
      threadId: ThreadId.make("thread-settings-retry"),
    };
    const runtimeTabId = "retained-background-tab";
    useBrowserSurfaceStore.getState().acquireActivity(runtimeTabId);

    await act(() => {
      renderer = create(
        <HostedBrowserWebview
          threadRef={threadRef}
          tabId="server-tab"
          runtimeTabId={runtimeTabId}
          initialUrl="https://example.com"
          viewport={FILL_PREVIEW_VIEWPORT}
          pictureInPicture={false}
          profileId="work"
          zoomFactor={1.25}
        />,
        {
          createNodeMock: (element) =>
            element.type === "webview"
              ? createGuest(element.props)
              : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
        },
      );
    });

    expect(mocks.getClientSettings).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    const failure = new Error("Saved settings are unavailable");
    await act(async () => {
      const hydration = ensureClientSettingsHydrated();
      firstRead.reject(failure);
      await expect(hydration).rejects.toBe(failure);
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    let retry!: Promise<void>;
    await act(() => {
      retry = ensureClientSettingsHydrated();
    });
    expect(mocks.getClientSettings).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
    expect(mocks.createTab).not.toHaveBeenCalled();

    await act(async () => {
      retryRead.resolve({
        ...DEFAULT_CLIENT_SETTINGS,
        browserDefaultZoomFactor: 1.25,
        browserDefaultAppearance: "dark",
        browserProfiles: [{ id: "work", name: "Work", kind: "persistent" }],
        browserDefaultProfileId: "work",
      });
      await retry;
    });

    expect(acquire).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(
      threadRef.environmentId,
      "work",
      {
        tunnel: false,
      },
    );
    expect(createGuest).toHaveBeenCalledOnce();
    expect(createGuest).toHaveBeenCalledWith(
      expect.objectContaining({
        partition: "persist:t3-preview-work",
        src: "https://example.com",
      }),
    );
    expect(mocks.createTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId, {
      zoomFactor: 1.25,
      colorScheme: "dark",
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();

    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
    });
    expect(mocks.registerWebview).toHaveBeenCalledExactlyOnceWith(runtimeTabId, 41);
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.setClientSettings).not.toHaveBeenCalled();
  });
});

describe("HostedBrowserWebview guest loss", () => {
  const runtimeTabId = "guest-loss-tab";

  /** Mounts a hydrated tab whose guests get ids 41, 42, ... in creation order. */
  async function mountGuestTab() {
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const guests: Array<EventTarget & { isConnected: boolean }> = [];
    const createGuest = vi.fn((_attributes: unknown) => {
      const webContentsId = 41 + guests.length;
      const guest = Object.assign(new EventTarget(), {
        isConnected: true,
        getWebContentsId: () => webContentsId,
      });
      guests.push(guest);
      return guest;
    });
    const element = (initialUrl: string) => (
      <HostedBrowserWebview
        threadRef={{
          environmentId: EnvironmentId.make("host-guest-loss"),
          threadId: ThreadId.make("thread-guest-loss"),
        }}
        tabId="server-tab"
        runtimeTabId={runtimeTabId}
        initialUrl={initialUrl}
        viewport={FILL_PREVIEW_VIEWPORT}
        pictureInPicture={false}
        profileId={undefined}
        zoomFactor={1}
      />
    );
    await act(async () => {
      await ensureClientSettingsHydrated();
      renderer = create(element("http://localhost:3211/candidates"), {
        createNodeMock: (node) =>
          node.type === "webview"
            ? createGuest(node.props)
            : { scrollLeft: 0, scrollTop: 0, scrollTo: () => undefined },
      });
    });
    expect(mocks.registerWebview).toHaveBeenLastCalledWith(runtimeTabId, 41);
    return {
      guests,
      createGuest,
      navigate: (url: string) => act(() => renderer!.update(element(url))),
    };
  }

  it("attaches a new guest at the tab's latest URL when the mounted webview loses its page", async () => {
    const { guests, createGuest, navigate } = await mountGuestTab();
    await navigate("http://localhost:3211/candidates/maya");

    vi.useFakeTimers();
    await act(async () => {
      guests[0]!.dispatchEvent(new Event("destroyed"));
      await vi.runAllTimersAsync();
    });

    expect(createGuest).toHaveBeenCalledTimes(2);
    expect(createGuest).toHaveBeenLastCalledWith(
      expect.objectContaining({ src: "http://localhost:3211/candidates/maya" }),
    );
    expect(mocks.registerWebview).toHaveBeenLastCalledWith(runtimeTabId, 42);

    // Removing the element destroys its guest too; that is not a lost page.
    await act(async () => {
      guests[1]!.isConnected = false;
      guests[1]!.dispatchEvent(new Event("destroyed"));
      await vi.runAllTimersAsync();
    });
    expect(createGuest).toHaveBeenCalledTimes(2);
  });

  it("remounts once when a crashed guest is then destroyed", async () => {
    const { guests, createGuest } = await mountGuestTab();

    vi.useFakeTimers();
    await act(async () => {
      guests[0]!.dispatchEvent(new Event("render-process-gone"));
      guests[0]!.dispatchEvent(new Event("destroyed"));
      await vi.runAllTimersAsync();
    });

    expect(createGuest).toHaveBeenCalledTimes(2);
    expect(mocks.registerWebview).toHaveBeenLastCalledWith(runtimeTabId, 42);
  });
});
