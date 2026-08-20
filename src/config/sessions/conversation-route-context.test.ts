import { describe, expect, it } from "vitest";
import {
  conversationRouteContextFromSessionEntry,
  inspectConversationRouteContextFromSessionEntry,
  reconcileConversationRouteContext,
  stampConversationRouteContext,
} from "./conversation-route-context-internal.js";
import { conversationRouteContextFromMsgContext } from "./conversation-route-context.js";
import type { InternalSessionEntry } from "./types.js";

describe("conversationRouteContextFromMsgContext", () => {
  it("captures Discord guild, role, and parent facts deterministically", () => {
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "Discord",
        GroupSpace: "guild-a",
        ThreadParentId: "parent-a",
        MemberRoleIds: ["support", "admin", "support"],
      }),
    ).toEqual({
      guildId: "guild-a",
      parentPeerId: "parent-a",
      memberRoleIds: ["admin", "support"],
    });
  });

  it.each(["slack", "mattermost", "msteams"])(
    "captures %s workspace identity as a team route fact",
    (channel) => {
      expect(
        conversationRouteContextFromMsgContext({
          OriginatingChannel: channel,
          GroupSpace: "team-a",
        }),
      ).toEqual({ teamId: "team-a" });
    },
  );

  it("does not invent a scope dialect for channels without one", () => {
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "reef",
        GroupSpace: "space-a",
      }),
    ).toBeUndefined();
  });

  it("captures the channel owner's canonical peer independently of route scope", () => {
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "feishu",
        ConversationRoutePeerId: "oc_room:topic:om_root:sender:ou_sender",
      }),
    ).toEqual({ peerId: "oc_room:topic:om_root:sender:ou_sender" });
  });
});

describe("session route context provenance", () => {
  const createEntry = (): InternalSessionEntry => ({
    sessionId: "session-a",
    lifecycleRevision: "revision-a",
    updatedAt: 100,
    conversationRouteContext: { guildId: "guild-a" },
  });

  it("rejects route context that was not stamped by its authoritative producer", () => {
    const entry = createEntry();

    reconcileConversationRouteContext(entry);

    expect(entry.conversationRouteContext).toBeUndefined();
    expect(entry.conversationRouteContextFingerprint).toBeUndefined();
  });

  it("restamps unchanged context after a current writer advances activity", () => {
    const previousEntry = createEntry();
    stampConversationRouteContext(previousEntry);
    const entry = { ...previousEntry, updatedAt: 200 };

    reconcileConversationRouteContext(entry, previousEntry);

    expect(conversationRouteContextFromSessionEntry(entry)).toEqual({ guildId: "guild-a" });
    expect(entry.conversationRouteContextFingerprint).not.toBe(
      previousEntry.conversationRouteContextFingerprint,
    );
  });

  it("distinguishes authoritative empty context from unstamped input", () => {
    const authoritativeEmpty: InternalSessionEntry = {
      sessionId: "session-empty",
      lifecycleRevision: "revision-empty",
      updatedAt: 100,
    };
    stampConversationRouteContext(authoritativeEmpty);

    expect(inspectConversationRouteContextFromSessionEntry(authoritativeEmpty)).toEqual({});
    expect(conversationRouteContextFromSessionEntry(authoritativeEmpty)).toBeUndefined();

    const unstampedEmpty: InternalSessionEntry = {
      sessionId: "session-unknown",
      lifecycleRevision: "revision-unknown",
      updatedAt: 100,
    };
    reconcileConversationRouteContext(unstampedEmpty);

    expect(inspectConversationRouteContextFromSessionEntry(unstampedEmpty)).toBeUndefined();
    expect(unstampedEmpty.conversationRouteContextFingerprint).toBeUndefined();
  });
});
