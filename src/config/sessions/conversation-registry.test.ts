import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  resolveConversation,
  resolveConversationScanBoundary,
  scanConversations,
} from "./conversation-registry.js";
import { stampConversationRouteContext } from "./conversation-route-context-internal.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore as upsertCanonicalSessionEntry,
} from "./session-accessor.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry, SessionEntry, SessionOrigin } from "./types.js";

type LegacyDeliveryFixture = Partial<InternalSessionEntry> & {
  deliveryContext?: DeliveryContext;
  origin?: SessionOrigin;
};

const upsertSessionEntry = async (
  scope: Parameters<typeof upsertCanonicalSessionEntry>[0],
  entry: LegacyDeliveryFixture,
) => {
  const normalized = normalizeLegacySessionEntryDelivery(entry as SessionEntry);
  const next = { ...loadSessionEntry(scope), ...normalized } as InternalSessionEntry;
  stampConversationRouteContext(next);
  replaceSessionEntrySync(scope, next);
  return loadSessionEntry(scope);
};

describe("conversation registry", () => {
  let tempDir: string;
  let storePath: string;

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-conversations-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("links multiple direct peers to a shared main context without conflating addresses", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await upsertSessionEntry(scope, {
      sessionId: "shared-main-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-a" },
    });
    await upsertSessionEntry(scope, {
      sessionId: "shared-main-session",
      updatedAt: 200,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-b" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-b" },
    });

    const conversations = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(conversations.map((entry) => entry.target).toSorted()).toEqual([
      "reef:peer-a",
      "reef:peer-b",
    ]);
    expect(conversations.every((entry) => entry.role === "participant")).toBe(true);
    expect(conversations.every((entry) => entry.sessionKey === scope.sessionKey)).toBe(true);
    expect(conversations.every((entry) => entry.observedFromSession === true)).toBe(true);
    expect(conversations.every((entry) => entry.routeContextObserved === true)).toBe(true);

    const peerA = conversations.find((entry) => entry.target === "reef:peer-a");
    expect(peerA).toBeDefined();
    expect(resolveConversation({ agentId: "main", storePath }, peerA!.conversationRef)).toEqual(
      peerA,
    );
  });

  it("catalogs a directory address without inventing a model-context session", () => {
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-a",
      deliveryTarget: "reef:peer-a",
      nativeDirectUserId: "peer-a",
      label: "@peer-a's agent",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [identity!], 100);

    const [conversation] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(conversation).toMatchObject({
      conversationRef: identity?.conversationRef,
      target: "reef:peer-a",
      label: "@peer-a's agent",
      firstSeenAt: 100,
      lastSeenAt: 100,
    });
    expect(conversation?.sessionId).toBeUndefined();
    expect(conversation?.sessionKey).toBeUndefined();
    expect(conversation?.role).toBeUndefined();
    expect(conversation?.observedFromSession).toBeUndefined();
    expect(resolveConversation({ agentId: "main", storePath }, identity!.conversationRef)).toEqual(
      conversation,
    );
  });

  it("persists a scoped route peer separately from its delivery target", async () => {
    await upsertSessionEntry(
      {
        agentId: "main",
        sessionKey: "agent:main:feishu:group:oc-room-topic-sender",
        storePath,
      },
      {
        sessionId: "feishu-topic-sender-session",
        updatedAt: 100,
        chatType: "group",
        deliveryContext: {
          channel: "feishu",
          accountId: "default",
          to: "chat:oc_room",
          threadId: "om_root",
        },
        origin: { provider: "feishu", nativeChannelId: "oc_room", threadId: "om_root" },
        conversationRouteContext: {
          peerId: "oc_room:topic:om_root:sender:ou_sender",
          parentPeerId: "oc_room",
        },
      },
    );

    expect(listConversations({ agentId: "main", storePath }, { channel: "feishu" })).toEqual([
      expect.objectContaining({
        peerId: "oc_room:topic:om_root:sender:ou_sender",
        target: "chat:oc_room",
        nativeChannelId: "oc_room",
        routeContext: {
          peerId: "oc_room:topic:om_root:sender:ou_sender",
          parentPeerId: "oc_room",
        },
      }),
    ]);
  });

  it("keeps route context scoped to each agent in a shared store", async () => {
    const sharedStorePath = path.join(tempDir, "shared.sqlite");
    for (const [agentId, role] of [
      ["finance", "finance"],
      ["support", "support"],
    ] as const) {
      await upsertSessionEntry(
        {
          agentId,
          sessionKey: `agent:${agentId}:discord:channel:ops`,
          storePath: sharedStorePath,
        },
        {
          sessionId: `${agentId}-ops-session`,
          updatedAt: 100,
          chatType: "channel",
          deliveryContext: { channel: "discord", accountId: "default", to: "channel:ops" },
          conversationRouteContext: { guildId: "guild-a", memberRoleIds: [role] },
        },
      );
    }

    expect(
      listConversations({ agentId: "finance", storePath: sharedStorePath }, { channel: "discord" }),
    ).toEqual([
      expect.objectContaining({
        sessionKey: "agent:finance:discord:channel:ops",
        routeContext: { guildId: "guild-a", memberRoleIds: ["finance"] },
      }),
    ]);
    expect(
      listConversations({ agentId: "support", storePath: sharedStorePath }, { channel: "discord" }),
    ).toEqual([
      expect.objectContaining({
        sessionKey: "agent:support:discord:channel:ops",
        routeContext: { guildId: "guild-a", memberRoleIds: ["support"] },
      }),
    ]);
  });

  it("keeps route context scoped to each conversation in a shared session", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await upsertSessionEntry(scope, {
      sessionId: "shared-session",
      updatedAt: 100,
      chatType: "channel",
      deliveryContext: { channel: "discord", accountId: "default", to: "channel:alpha" },
      conversationRouteContext: { guildId: "guild-alpha", memberRoleIds: ["alpha"] },
    });
    await upsertSessionEntry(scope, {
      sessionId: "shared-session",
      updatedAt: 200,
      chatType: "channel",
      deliveryContext: { channel: "discord", accountId: "default", to: "channel:beta" },
      conversationRouteContext: { guildId: "guild-beta", memberRoleIds: ["beta"] },
    });

    expect(
      listConversations({ agentId: "main", storePath }, { channel: "discord" }).map(
        ({ target, routeContext }) => ({ target, routeContext }),
      ),
    ).toEqual([
      {
        target: "channel:beta",
        routeContext: { guildId: "guild-beta", memberRoleIds: ["beta"] },
      },
      {
        target: "channel:alpha",
        routeContext: { guildId: "guild-alpha", memberRoleIds: ["alpha"] },
      },
    ]);
  });

  it("rejects route context after a same-schema rollback writer advances the entry", async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:discord:channel:rollback",
      storePath,
    };
    await upsertSessionEntry(scope, {
      sessionId: "rollback-session",
      lifecycleRevision: "rollback-generation",
      updatedAt: 100,
      chatType: "channel",
      deliveryContext: { channel: "discord", accountId: "default", to: "channel:rollback" },
      conversationRouteContext: { guildId: "guild-a", memberRoleIds: ["support"] },
    });
    expect(listConversations(scope, { channel: "discord" })[0]).toMatchObject({
      routeContextObserved: true,
      routeContext: {
        guildId: "guild-a",
        memberRoleIds: ["support"],
      },
    });

    const resolved = resolveSqliteReadScope(scope);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const db = getSessionKysely(database.db);
    const node = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select("entry_json")
        .where("session_key", "=", scope.sessionKey),
    ).rows[0];
    const downgradedEntry = JSON.parse(node!.entry_json) as InternalSessionEntry;
    downgradedEntry.updatedAt = 200;
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_nodes")
        .set({ entry_json: JSON.stringify(downgradedEntry), updated_at: 200 })
        .where("session_key", "=", scope.sessionKey),
    );
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: 200 })
        .where("session_id", "=", "rollback-session"),
    );
    closeOpenClawAgentDatabasesForTest();

    expect(listConversations(scope, { channel: "discord" })[0]).toMatchObject({
      lastSeenAt: 200,
      observedFromSession: true,
    });
    expect(listConversations(scope, { channel: "discord" })[0]?.routeContext).toBeUndefined();
    expect(
      listConversations(scope, { channel: "discord" })[0]?.routeContextObserved,
    ).toBeUndefined();

    await upsertCanonicalSessionEntry(scope, { label: "after rollback" });
    expect(loadSessionEntry(scope)).toMatchObject({ label: "after rollback" });
    expect(loadSessionEntry(scope)?.conversationRouteContext).toBeUndefined();
    expect(loadSessionEntry(scope)?.conversationRouteContextFingerprint).toBeUndefined();
    expect(listConversations(scope, { channel: "discord" })[0]?.routeContext).toBeUndefined();
    expect(
      listConversations(scope, { channel: "discord" })[0]?.routeContextObserved,
    ).toBeUndefined();
  });

  it("assigns an unscoped session association only to its fixed-store owner", async () => {
    await upsertSessionEntry(
      { agentId: "main", sessionKey: "global", storePath },
      {
        sessionId: "global-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      },
    );

    const ownerScope = { agentId: "main", legacySessionOwnerAgentId: "main", storePath };
    expect(listConversations(ownerScope, { channel: "reef" })).toEqual([
      expect.objectContaining({
        sessionId: "global-session",
        sessionKey: "global",
        target: "reef:peer-a",
      }),
    ]);
    expect(
      listConversations(
        { agentId: "support", legacySessionOwnerAgentId: "main", storePath },
        { channel: "reef" },
      )[0],
    ).not.toMatchObject({
      observedFromSession: true,
      sessionId: expect.any(String),
      sessionKey: expect.any(String),
    });
  });

  it("retains a foreign-associated directory address as an unbound candidate", async () => {
    const sharedStorePath = path.join(tempDir, "shared.sqlite");
    const deliveryContext = {
      channel: "reef",
      accountId: "default",
      to: "reef:peer-a",
    } as const;
    await upsertSessionEntry(
      { agentId: "finance", sessionKey: "agent:finance:main", storePath: sharedStorePath },
      {
        sessionId: "finance-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext,
      },
    );
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-a",
      deliveryTarget: "reef:peer-a",
    });
    expect(identity).toBeDefined();
    registerConversationAddresses(
      { agentId: "support", storePath: sharedStorePath },
      [identity!],
      200,
    );

    expect(
      listConversations({ agentId: "support", storePath: sharedStorePath }, { channel: "reef" }),
    ).toEqual([
      expect.objectContaining({
        conversationRef: identity?.conversationRef,
        target: "reef:peer-a",
      }),
    ]);
    expect(
      listConversations({ agentId: "support", storePath: sharedStorePath }, { channel: "reef" })[0],
    ).not.toMatchObject({
      observedFromSession: true,
      sessionId: expect.any(String),
      sessionKey: expect.any(String),
    });
  });

  it("orders fresh directory addresses with session-backed conversation activity", async () => {
    await upsertSessionEntry(
      { agentId: "main", sessionKey: "agent:main:reef:direct:peer-a", storePath },
      {
        sessionId: "peer-a-session",
        updatedAt: 100,
        chatType: "direct",
        deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      },
    );
    const freshIdentity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-b",
      deliveryTarget: "reef:peer-b",
    });
    expect(freshIdentity).toBeDefined();
    const freshAt = Date.now() + 1_000;
    registerConversationAddresses({ agentId: "main", storePath }, [freshIdentity!], freshAt);

    expect(
      listConversations({ agentId: "main", storePath }, { channel: "reef", limit: 1 }),
    ).toEqual([
      expect.objectContaining({
        conversationRef: freshIdentity?.conversationRef,
        target: "reef:peer-b",
        lastSeenAt: freshAt,
      }),
    ]);
  });

  it("scans one frozen insertion range despite concurrent activity and inserts", () => {
    const identities = ["peer-a", "peer-b", "peer-c"]
      .map((peerId) =>
        buildConversationIdentity({
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId: `reef:${peerId}`,
          deliveryTarget: `reef:${peerId}`,
        }),
      )
      .filter((identity) => identity !== null);
    expect(identities).toHaveLength(3);
    registerConversationAddresses({ agentId: "main", storePath }, identities, 100);
    const throughCursor = resolveConversationScanBoundary({ agentId: "main", storePath });
    expect(throughCursor).toBeDefined();
    const firstPage = scanConversations(
      { agentId: "main", storePath },
      { limit: 1, throughCursor: throughCursor! },
    );
    expect(firstPage.cursor).toBeDefined();

    registerConversationAddresses({ agentId: "main", storePath }, [identities[0]!], 1_000);
    const laterIdentity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "reef:peer-later",
      deliveryTarget: "reef:peer-later",
    });
    expect(laterIdentity).toBeDefined();
    registerConversationAddresses({ agentId: "main", storePath }, [laterIdentity!], 2_000);

    const secondPage = scanConversations(
      { agentId: "main", storePath },
      { afterCursor: firstPage.cursor!, limit: 10, throughCursor: throughCursor! },
    );
    expect(
      [...firstPage.conversations, ...secondPage.conversations].map(
        (conversation) => conversation.conversationRef,
      ),
    ).toEqual(identities.map((identity) => identity!.conversationRef));
  });

  it("keeps a live binding when newer historical activity has no current entry", async () => {
    const liveSessionKey = "agent:main:reef:direct:peer-a-live";
    const staleSessionKey = "agent:main:reef:direct:peer-a-stale";
    for (const [sessionKey, sessionId] of [
      [liveSessionKey, "live-session"],
      [staleSessionKey, "stale-session"],
    ] as const) {
      await upsertSessionEntry(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId,
          updatedAt: 100,
          chatType: "direct",
          deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
          conversationRouteContext: {
            teamId: sessionId === "live-session" ? "live-team" : "stale-team",
          },
        },
      );
    }
    const resolved = resolveSqliteReadScope({ agentId: "main", storePath });
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
    const db = getSessionKysely(database.db);
    const liveLastSeenAt = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_conversations")
        .select("last_seen_at")
        .where("session_id", "=", "live-session"),
    ).rows[0]!.last_seen_at;
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: liveLastSeenAt + 1 })
        .where("session_id", "=", "stale-session"),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", staleSessionKey),
    );

    expect(
      listConversations({ agentId: "main", storePath }, { channel: "reef", limit: 1 })[0],
    ).toMatchObject({
      target: "reef:peer-a",
      sessionId: "live-session",
      sessionKey: liveSessionKey,
      routeContext: { teamId: "live-team" },
      lastSeenAt: liveLastSeenAt,
    });
  });

  it("resolves historical addresses through the current session binding after reset", async () => {
    const sessionKey = "agent:main:reef:direct:peer-a";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntry(scope, {
      sessionId: "old-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
      origin: { provider: "reef", accountId: "default", nativeDirectUserId: "peer-a" },
    });
    const [historical] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(historical?.sessionId).toBe("old-session");

    await upsertSessionEntry(scope, {
      sessionId: "current-session",
      updatedAt: 200,
      chatType: "direct",
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, historical?.conversationRef ?? "missing"),
    ).toMatchObject({
      conversationRef: historical?.conversationRef,
      sessionId: "current-session",
      sessionKey,
      target: "reef:peer-a",
    });
  });

  it("retains a deleted session's address without exposing a stale binding", async () => {
    const sessionKey = "agent:main:reef:direct:peer-a";
    const scope = { agentId: "main", sessionKey, storePath };
    await upsertSessionEntry(scope, {
      sessionId: "deleted-session",
      updatedAt: 100,
      chatType: "direct",
      deliveryContext: { channel: "reef", accountId: "default", to: "reef:peer-a" },
    });
    const [linked] = listConversations({ agentId: "main", storePath }, { channel: "reef" });
    expect(linked?.sessionId).toBe("deleted-session");

    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
    });

    expect(
      resolveConversation({ agentId: "main", storePath }, linked?.conversationRef ?? "missing"),
    ).toMatchObject({
      conversationRef: linked?.conversationRef,
      target: "reef:peer-a",
      observedFromSession: true,
    });
    expect(
      resolveConversation({ agentId: "main", storePath }, linked?.conversationRef ?? "missing"),
    ).not.toMatchObject({ sessionId: expect.any(String), sessionKey: expect.any(String) });
  });
});
