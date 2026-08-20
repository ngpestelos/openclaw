import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectSlackConversationRouteOwner } from "./conversation-route-owner.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

describe("inspectSlackConversationRouteOwner", () => {
  let releaseInstallation: (() => void) | undefined;

  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    releaseInstallation = registerSlackInstallationState("default", "workspace").release;
  });
  afterEach(() => {
    releaseInstallation?.();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("checks a thread binding before the parent conversation without touching it", () => {
    const touch = vi.fn();
    const resolveByConversation = vi.fn((conversation) =>
      conversation.conversationId === "thread-1"
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
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
      touch,
    });

    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "channel-1", threadId: "thread-1" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "channel-1",
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it("uses the direct-user binding identity", () => {
    const resolveByConversation = vi.fn(() => null);
    registerSessionBindingAdapter({
      channel: "slack",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
    });

    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "direct", peerId: "user-1" },
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
    expect(resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "user:user-1" }),
    );
  });

  it("normalizes persisted and directory Enterprise peers exactly once", () => {
    releaseInstallation?.();
    releaseInstallation = registerSlackInstallationState("default", "enterprise").release;
    const cfg = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "channel" as const, id: "team:T123:channel:C456" },
          },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "slack", accountId: "default" },
        },
      ],
    };

    expect(
      inspectSlackConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: {
          kind: "channel",
          peerId: "team:T123:channel:C456",
          nativeChannelId: "C456",
          context: { teamId: "T123" },
        },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(
      inspectSlackConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "channel", peerId: "team:T123:channel:C456" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(
      inspectSlackConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: {
          kind: "channel",
          peerId: "team:T123:channel:C456",
          context: { teamId: "T999" },
        },
      }),
    ).toBeNull();
  });

  it("keeps qualified Enterprise ownership through degraded and released monitor state", () => {
    releaseInstallation?.();
    const installation = registerSlackInstallationState("default", "enterprise");
    releaseInstallation = installation.release;
    const cfg = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "channel" as const, id: "team:T123:channel:C456" },
          },
        },
      ],
    };
    const conversation = { kind: "channel" as const, peerId: "team:T123:channel:C456" };

    expect(inspectSlackConversationRouteOwner({ cfg, accountId: "default", conversation })).toEqual(
      { kind: "agent", agentId: "finance" },
    );
    installation.update("degraded");
    expect(inspectSlackConversationRouteOwner({ cfg, accountId: "default", conversation })).toEqual(
      { kind: "agent", agentId: "finance" },
    );
    installation.release();
    releaseInstallation = undefined;
    expect(inspectSlackConversationRouteOwner({ cfg, accountId: "default", conversation })).toEqual(
      { kind: "agent", agentId: "finance" },
    );
  });

  it("fails closed only when installation state conflicts with the target dialect", () => {
    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "team:T123:channel:C456" },
      }),
    ).toBeNull();

    releaseInstallation?.();
    const installation = registerSlackInstallationState("default", "degraded");
    releaseInstallation = installation.release;
    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "C456" },
      }),
    ).toBeNull();

    installation.release();
    releaseInstallation = undefined;
    expect(
      inspectSlackConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "C456" },
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });
});
