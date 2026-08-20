// Telegram route-owner tests cover pure revalidation of plugin-owned routing.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  testing,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.js";

describe("inspectTelegramConversationRouteOwner", () => {
  let emptyAdapter: SessionBindingAdapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              bindingStore: "adapter",
            },
          },
        },
      ]),
    );
    testing.resetSessionBindingAdaptersForTests();
    emptyAdapter = {
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    registerSessionBindingAdapter(emptyAdapter);
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    testing.resetSessionBindingAdaptersForTests();
  });

  it("revalidates forum topics through their parent group binding", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route",
          agentId: "finance",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "-100123" },
          },
        },
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    };

    expect(
      inspectTelegramConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
  });

  it("uses current forum and direct-topic agent overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          groups: { "-100123": { topics: { "42": { agentId: "finance" } } } },
          direct: { "12345": { topics: { "99": { agentId: "support" } } } },
        },
      },
    };

    expect(
      inspectTelegramConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(
      inspectTelegramConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "direct", peerId: "12345:direct-topic:99", threadId: "99" },
      }),
    ).toEqual({ kind: "agent", agentId: "support" });
  });

  it("reflects topic reassignment from the current config", () => {
    const base = {
      channels: {
        telegram: {
          groups: { "-100123": { topics: { "42": { agentId: "finance" } } } },
        },
      },
    } satisfies OpenClawConfig;
    const conversation = { kind: "group" as const, peerId: "-100123:topic:42", threadId: "42" };

    expect(
      inspectTelegramConversationRouteOwner({ cfg: base, accountId: "default", conversation }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          channels: {
            telegram: {
              groups: { "-100123": { topics: { "42": { agentId: "support" } } } },
            },
          },
        },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "agent", agentId: "support" });
  });

  it("inspects runtime bindings without refreshing their liveness", () => {
    const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => ({
        bindingId: "binding-topic",
        targetSessionKey: "agent:review:acp:session-1",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100123:topic:42",
        },
        status: "active",
        boundAt: 1,
      }),
      touch,
    });

    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "agent", agentId: "review" });
    expect(touch).not.toHaveBeenCalled();
  });

  it("classifies plugin-owned bindings independently of their session key", () => {
    const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => ({
        bindingId: "binding-plugin",
        targetSessionKey: "agent:review:looks-agent-owned",
        targetKind: "session",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100123:topic:42",
        },
        status: "active",
        boundAt: 1,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "review-plugin",
          pluginRoot: "/plugins/review",
        },
      }),
      touch,
    });

    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "plugin", pluginId: "review-plugin", fallbackAgentId: "main" });
    expect(touch).not.toHaveBeenCalled();
  });

  it("fails closed only while an enabled binding store is unavailable", () => {
    testing.resetSessionBindingAdaptersForTests();
    const boundAdapter: SessionBindingAdapter = {
      channel: "telegram",
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
    const conversation = { kind: "group" as const, peerId: "-100123:topic:42", threadId: "42" };

    expect(
      inspectTelegramConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    unregisterSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      adapter: boundAdapter,
    });
    expect(
      inspectTelegramConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "unavailable" });
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: { channels: { telegram: { threadBindings: { enabled: false } } } },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });
});
