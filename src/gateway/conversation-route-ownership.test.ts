import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBindingMatch } from "../config/types.agents.js";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { isConversationRouteEligibleForAgent } from "./conversation-route-ownership.js";

const fallbackBinding = {
  type: "route" as const,
  agentId: "main",
  match: { channel: "reef", accountId: "default" },
};

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  resetGlobalHookRunner();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  resetGlobalHookRunner();
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});

describe("isConversationRouteEligibleForAgent", () => {
  it.each([
    {
      name: "guild and roles",
      match: {
        channel: "discord",
        accountId: "default",
        guildId: "support-guild",
        roles: ["support"],
      },
      routeContext: { guildId: "support-guild", memberRoleIds: ["support"] },
      peer: { kind: "channel" as const, id: "support-room" },
    },
    {
      name: "team",
      match: { channel: "slack", accountId: "default", teamId: "support-team" },
      routeContext: { teamId: "support-team" },
      peer: { kind: "channel" as const, id: "support-room" },
    },
    {
      name: "parent peer",
      match: {
        channel: "reef",
        accountId: "default",
        peer: { kind: "channel" as const, id: "support-parent" },
      },
      routeContext: { parentPeerId: "support-parent" },
      peer: { kind: "channel" as const, id: "support-thread" },
    },
  ])("requires session provenance for unresolved $name context", (testCase) => {
    const channel = testCase.match.channel;
    const params = {
      config: {
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          {
            type: "route" as const,
            agentId: "finance",
            match: testCase.match as AgentBindingMatch,
          },
          { ...fallbackBinding, match: { ...fallbackBinding.match, channel } },
        ],
      },
      agentId: "finance",
      conversation: {
        channel,
        accountId: "default",
        kind: testCase.peer.kind,
        peerId: testCase.peer.id,
      },
    };

    expect(isConversationRouteEligibleForAgent(params)).toBe(false);
    expect(
      isConversationRouteEligibleForAgent({
        ...params,
        conversation: {
          ...params.conversation,
          observedFromSession: true,
          routeContext: testCase.routeContext,
        },
      }),
    ).toBe(true);
  });

  it("revokes provenance when no current binding can select the agent", () => {
    expect(
      isConversationRouteEligibleForAgent({
        config: {
          agents: { entries: { main: {}, finance: {} } },
          bindings: [
            {
              type: "route",
              agentId: "finance",
              match: { channel: "reef", accountId: "default" },
            },
          ],
        },
        agentId: "main",
        conversation: {
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId: "molty",
          observedFromSession: true,
        },
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "uses an exact plugin owner",
      owner: { kind: "agent", agentId: "finance" },
      expected: true,
    },
    { name: "fails closed when the plugin recognizes no owner", owner: null, expected: false },
    { name: "falls back when the plugin declines", owner: undefined, expected: false },
  ] as const)("$name", ({ owner, expected }) => {
    const resolveConversationRouteOwner = vi.fn(() => owner);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { resolveConversationRouteOwner },
          },
        },
      ]),
    );
    const config = {
      agents: { list: [{ id: "main" }, { id: "finance" }] },
      bindings: [
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "telegram",
      accountId: "default",
      kind: "group" as const,
      peerId: "-100123:topic:42",
      threadId: "42",
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      expected,
    );
    if (owner === undefined) {
      expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
        true,
      );
    }
    expect(resolveConversationRouteOwner).toHaveBeenCalledWith({
      cfg: config,
      accountId: "default",
      conversation: {
        kind: "group",
        peerId: "-100123:topic:42",
        threadId: "42",
      },
    });
  });

  it("replays configured conversation bindings before authorizing an agent", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "discord" }),
            bindings: {
              compileConfiguredBinding: ({ conversationId }: { conversationId: string }) => ({
                conversationId,
              }),
              matchInboundConversation: ({
                compiledBinding,
                conversationId,
              }: {
                compiledBinding: { conversationId: string };
                conversationId: string;
              }) => (compiledBinding.conversationId === conversationId ? { conversationId } : null),
            },
          },
        },
      ]),
    );
    const config = {
      agents: { list: [{ id: "main" }, { id: "finance" }] },
      bindings: [
        {
          type: "acp" as const,
          agentId: "finance",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "direct" as const, id: "molty" },
          },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "discord",
      accountId: "default",
      kind: "direct" as const,
      peerId: "molty",
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      true,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      false,
    );
  });

  it("replays runtime conversation bindings without refreshing liveness", () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "reef",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => ({
        bindingId: "binding-runtime",
        targetSessionKey: "agent:finance:bound",
        targetKind: "session",
        conversation: { channel: "reef", accountId: "default", conversationId: "molty" },
        status: "active",
        boundAt: 1,
      }),
      touch,
    });
    const conversation = {
      channel: "reef",
      accountId: "default",
      kind: "direct" as const,
      peerId: "molty",
    };

    expect(
      isConversationRouteEligibleForAgent({ config: {}, agentId: "finance", conversation }),
    ).toBe(true);
    expect(isConversationRouteEligibleForAgent({ config: {}, agentId: "main", conversation })).toBe(
      false,
    );
    expect(touch).not.toHaveBeenCalled();
  });

  it("revokes detached eligibility while an adapter-owned store reloads", () => {
    const conversation = {
      channel: "discord",
      accountId: "default",
      kind: "channel" as const,
      peerId: "support-room",
    };
    const adapter = {
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => ({
        bindingId: "binding-reload",
        targetSessionKey: "agent:finance:bound",
        targetKind: "session" as const,
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "support-room",
        },
        status: "active" as const,
        boundAt: 1,
      }),
    };
    registerSessionBindingAdapter(adapter);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "discord" }),
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              bindingStore: "adapter" as const,
            },
          },
        },
      ]),
    );

    expect(
      isConversationRouteEligibleForAgent({ config: {}, agentId: "finance", conversation }),
    ).toBe(true);
    unregisterSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      adapter,
    });
    expect(
      isConversationRouteEligibleForAgent({ config: {}, agentId: "finance", conversation }),
    ).toBe(false);
    expect(isConversationRouteEligibleForAgent({ config: {}, agentId: "main", conversation })).toBe(
      false,
    );
  });

  it("denies every agent while an active plugin owns the conversation", () => {
    const resolveConversationRouteOwner = () => ({
      kind: "plugin" as const,
      pluginId: "review-plugin",
      fallbackAgentId: "main",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { resolveConversationRouteOwner },
          },
        },
      ]),
    );
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "inbound_claim", pluginId: "review-plugin", handler: vi.fn() },
      ]),
    );
    const conversation = {
      channel: "telegram",
      accountId: "default",
      kind: "group" as const,
      peerId: "-100123:topic:42",
    };

    expect(isConversationRouteEligibleForAgent({ config: {}, agentId: "main", conversation })).toBe(
      false,
    );
    expect(
      isConversationRouteEligibleForAgent({ config: {}, agentId: "finance", conversation }),
    ).toBe(false);
  });

  it("uses the canonical fallback when a plugin-owned binding has no handler", () => {
    const resolveConversationRouteOwner = () => ({
      kind: "plugin" as const,
      pluginId: "missing-plugin",
      fallbackAgentId: "main",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { resolveConversationRouteOwner },
          },
        },
      ]),
    );
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "inbound_claim", pluginId: "other-plugin", handler: vi.fn() },
      ]),
    );
    const conversation = {
      channel: "telegram",
      accountId: "default",
      kind: "group" as const,
      peerId: "-100123:topic:42",
    };

    expect(isConversationRouteEligibleForAgent({ config: {}, agentId: "main", conversation })).toBe(
      true,
    );
    expect(
      isConversationRouteEligibleForAgent({ config: {}, agentId: "finance", conversation }),
    ).toBe(false);
  });

  it("does not let an unrelated contextual binding revive a reassigned route", () => {
    expect(
      isConversationRouteEligibleForAgent({
        config: {
          agents: { entries: { main: {}, finance: {}, support: {} } },
          bindings: [
            {
              type: "route",
              agentId: "support",
              match: { channel: "discord", accountId: "default", guildId: "guild-a" },
            },
            {
              type: "route",
              agentId: "finance",
              match: { channel: "discord", accountId: "default", guildId: "guild-b" },
            },
          ],
        },
        agentId: "finance",
        conversation: {
          channel: "discord",
          accountId: "default",
          kind: "channel",
          peerId: "ops-room",
          observedFromSession: true,
          routeContext: { guildId: "guild-a" },
        },
      }),
    ).toBe(false);
  });

  it("does not let a context-free fallback share an exact contextual route", () => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: { channel: "discord", accountId: "default", guildId: "guild-a" },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "discord",
      accountId: "default",
      kind: "channel" as const,
      peerId: "ops-room",
      observedFromSession: true as const,
      routeContext: { guildId: "guild-a" },
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      true,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      false,
    );
  });

  it("does not let a directory-only route bypass a contextual binding", () => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: { channel: "discord", accountId: "default", guildId: "guild-a" },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "discord",
      accountId: "default",
      kind: "channel" as const,
      peerId: "ops-room",
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      false,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      false,
    );
  });

  it.each(["direct", "group"] as const)(
    "does not apply Discord guild bindings to a %s conversation",
    (kind) => {
      const config = {
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          {
            type: "route" as const,
            agentId: "finance",
            match: { channel: "discord", accountId: "default", guildId: "guild-a" },
          },
          {
            type: "route" as const,
            agentId: "main",
            match: { channel: "discord", accountId: "default" },
          },
        ],
      };

      expect(
        isConversationRouteEligibleForAgent({
          config,
          agentId: "main",
          conversation: {
            channel: "discord",
            accountId: "default",
            kind,
            peerId: kind === "direct" ? "user-a" : "group-dm-a",
          },
        }),
      ).toBe(true);
    },
  );

  it("ignores a compound contextual binding for a different peer", () => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel" as const, id: "finance-room" },
            guildId: "guild-a",
          },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    };

    expect(
      isConversationRouteEligibleForAgent({
        config,
        agentId: "main",
        conversation: {
          channel: "discord",
          accountId: "default",
          kind: "channel",
          peerId: "general-room",
        },
      }),
    ).toBe(true);
  });

  it("ignores an unrelated peer binding for a contextless threaded conversation", () => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: {
            channel: "feishu",
            accountId: "default",
            peer: { kind: "group" as const, id: "finance-room" },
          },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "feishu", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "feishu",
      accountId: "default",
      kind: "group" as const,
      peerId: "general-room",
      threadId: "topic-7",
      observedFromSession: true as const,
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      true,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      false,
    );
  });

  it("keeps context-free Slack direct conversations guarded by team bindings", () => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: { channel: "slack", accountId: "default", teamId: "team-a" },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "slack", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "slack",
      accountId: "default",
      kind: "direct" as const,
      peerId: "user-a",
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      false,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      false,
    );
  });

  it("keeps a context-free route when narrower bindings select the same agent", () => {
    const config = {
      agents: { entries: { main: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "slack", accountId: "default", teamId: "team-a" },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "slack", accountId: "default" },
        },
      ],
    };

    expect(
      isConversationRouteEligibleForAgent({
        config,
        agentId: "main",
        conversation: {
          channel: "slack",
          accountId: "default",
          kind: "channel",
          peerId: "ops-room",
        },
      }),
    ).toBe(true);
  });

  it.each([
    { name: "exact", peerId: "support-room" },
    { name: "wildcard", peerId: "*" },
  ])("keeps a threaded route selected by a $name current-peer binding", ({ peerId }) => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group" as const, id: peerId },
          },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "telegram",
      accountId: "default",
      kind: "group" as const,
      peerId: "support-room",
      threadId: "topic-7",
      observedFromSession: true as const,
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      true,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      false,
    );
  });
});
