import { describe, expect, it } from "vite-plus/test";

import messagesTimeline from "../components/chat/MessagesTimeline.tsx?raw";
import sideChatPanel from "./SideChatPanel.tsx?raw";

// Upstream answers approvals on their timeline row, so a side chat
// whose panel stops handing its requests to the timeline has no way to answer one.
describe("side chat approvals", () => {
  it("reach the side chat's timeline with a way to answer them", () => {
    const timeline = sideChatPanel.slice(sideChatPanel.indexOf("<MessagesTimeline"));
    expect(timeline).toContain("pendingApprovals={requests.pendingApprovals}");
    expect(timeline).toContain("onRespondToApproval={requests.respondToApproval}");
    expect(timeline).toContain("respondingRequestIds={requests.respondingRequestIds}");
    expect(timeline).toContain("canOperateThread={canOperate}");
  });

  it("are answered on the timeline row the main thread uses", () => {
    expect(messagesTimeline).toContain("<TimelinePendingApprovalRow");
    expect(messagesTimeline).toContain("pendingApprovals = EMPTY_PENDING_APPROVALS");
  });
});
