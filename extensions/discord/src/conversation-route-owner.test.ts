import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  testing as sessionBindingTesting,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDiscordConversationRouteOwner } from "./conversation-route-owner.js";

describe("inspectDiscordConversationRouteOwner", () => {
  let emptyAdapter: SessionBindingAdapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            id: "discord",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              bindingStore: "adapter",
            },
          },
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    emptyAdapter = {
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    registerSessionBindingAdapter(emptyAdapter);
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

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

  it("uses the raw thread id and parent for thread binding inspection", () => {
    const resolveByConversation = vi.fn((conversation) =>
      conversation.conversationId === "thread-1" &&
      conversation.parentConversationId === "channel-1"
        ? {
            bindingId: "binding-thread",
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
    });

    expect(
      inspectDiscordConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: {
          kind: "channel",
          peerId: "thread-1",
          threadId: "thread-1",
          nativeChannelId: "thread-1",
          context: { parentPeerId: "channel-1" },
        },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "channel-1",
    });
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

  it("fails closed only while an enabled binding store is unavailable", () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    const boundAdapter: SessionBindingAdapter = {
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-reload",
        targetSessionKey: "agent:finance:bound",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
    };
    registerSessionBindingAdapter(boundAdapter);
    const conversation = { kind: "channel" as const, peerId: "channel-1" };

    expect(
      inspectDiscordConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    unregisterSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      adapter: boundAdapter,
    });
    expect(
      inspectDiscordConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "unavailable" });
    expect(
      inspectDiscordConversationRouteOwner({
        cfg: { channels: { discord: { threadBindings: { enabled: false } } } },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });
});
