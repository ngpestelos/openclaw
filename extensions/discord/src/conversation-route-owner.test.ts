import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDiscordConversationRouteOwner } from "./conversation-route-owner.js";

describe("inspectDiscordConversationRouteOwner", () => {
  beforeEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());
  afterEach(() => sessionBindingTesting.resetSessionBindingAdaptersForTests());

  it("uses the user runtime key and native configured key for direct messages", () => {
    const touch = vi.fn();
    const resolveByConversation = vi.fn((conversation) =>
      conversation.conversationId === "user:user-1"
        ? {
            bindingId: "binding-direct",
            targetSessionKey: "agent:finance:bound",
            targetKind: "session" as const,
            conversation,
            status: "active" as const,
            boundAt: 1,
          }
        : null,
    );
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
      touch,
    });

    expect(
      inspectDiscordConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "direct", peerId: "user-1", nativeChannelId: "dm-1" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "user:user-1" }),
    );
    expect(touch).not.toHaveBeenCalled();
  });

  it("preserves plugin ownership without trusting an agent-shaped target", () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-plugin",
        targetSessionKey: "agent:review:looks-owned",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "review-plugin",
          pluginRoot: "/plugins/review",
        },
      }),
    });

    expect(
      inspectDiscordConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "channel-1", nativeChannelId: "channel-1" },
      }),
    ).toEqual({ kind: "plugin", pluginId: "review-plugin", fallbackAgentId: "main" });
  });
});
