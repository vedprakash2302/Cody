import { describe, expect, it } from "vite-plus/test";

import { planTranscriptRefresh } from "./AgentTranscriptView.logic";

describe("planTranscriptRefresh", () => {
  const settled = { currentRevision: "r2", inFlight: false, now: 10_000 };

  it("leaves a current transcript alone", () => {
    expect(planTranscriptRefresh({ ...settled, mark: { revision: "r2", at: 0 } })).toBeNull();
    expect(planTranscriptRefresh({ ...settled, mark: undefined })).toBeNull();
  });

  it("never interrupts a read in flight, however stale", () => {
    expect(
      planTranscriptRefresh({ ...settled, inFlight: true, mark: { revision: "r1", at: 0 } }),
    ).toBeNull();
  });

  it("refetches a stale or failed transcript at once after a quiet period", () => {
    expect(planTranscriptRefresh({ ...settled, mark: { revision: "r1", at: 0 } })).toBe(0);
    expect(planTranscriptRefresh({ ...settled, mark: { revision: null, at: 0 } })).toBe(0);
  });

  it("spaces a refetch from the last one", () => {
    expect(planTranscriptRefresh({ ...settled, mark: { revision: "r1", at: 9_500 } })).toBe(1_500);
  });
});
