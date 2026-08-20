import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMatrixConversationRouteOwner } from "./conversation-route-owner.js";

describe("resolveMatrixConversationRouteOwner", () => {
  beforeEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
  afterEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

  it("uses the native room to replay a direct-message binding", () => {
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-room",
        targetSessionKey: "agent:finance:bound",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
    });

    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: {
          kind: "direct",
          peerId: "@alice:example.org",
          nativeChannelId: "!dm:example.org",
        },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
  });

  it("fails closed when the native room is unavailable", () => {
    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "direct", peerId: "@alice:example.org" },
      }),
    ).toBeNull();
  });

  it("fails closed for a runtime target without an agent-owned session key", () => {
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-plugin",
        targetSessionKey: "plugin-binding:review:session-1",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
    });

    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: {
          kind: "channel",
          peerId: "!room:example.org",
          nativeChannelId: "!room:example.org",
        },
      }),
    ).toBeNull();
  });
});
