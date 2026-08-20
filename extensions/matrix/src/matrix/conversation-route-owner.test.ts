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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMatrixConversationRouteOwner } from "./conversation-route-owner.js";

describe("resolveMatrixConversationRouteOwner", () => {
  let emptyAdapter: SessionBindingAdapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
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
      channel: "matrix",
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

  it("fails closed while its binding store is unavailable", () => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    const boundAdapter: SessionBindingAdapter = {
      channel: "matrix",
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
    const conversation = {
      kind: "channel" as const,
      peerId: "!room:example.org",
      nativeChannelId: "!room:example.org",
    };

    expect(
      resolveMatrixConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    unregisterSessionBindingAdapter({
      channel: "matrix",
      accountId: "default",
      adapter: boundAdapter,
    });

    expect(
      resolveMatrixConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation,
      }),
    ).toBeNull();
  });
});
