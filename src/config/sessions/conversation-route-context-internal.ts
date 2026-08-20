import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ConversationRouteContext } from "./conversation-route-context.types.js";
import type { InternalSessionEntry } from "./types.js";

function normalizeRoleIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const roleIds = [
    ...new Set(
      value.flatMap((roleId) => {
        const normalized = normalizeOptionalString(roleId);
        return normalized ? [normalized] : [];
      }),
    ),
  ].toSorted();
  return roleIds.length > 0 ? roleIds : undefined;
}

export function parseConversationRouteContext(
  value: unknown,
): ConversationRouteContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const peerId = normalizeOptionalString(value.peerId);
  const guildId = normalizeOptionalString(value.guildId);
  const teamId = normalizeOptionalString(value.teamId);
  const parentPeerId = normalizeOptionalString(value.parentPeerId);
  const memberRoleIds = normalizeRoleIds(value.memberRoleIds);
  if (!peerId && !guildId && !teamId && !parentPeerId && !memberRoleIds) {
    return undefined;
  }
  return {
    ...(peerId ? { peerId } : {}),
    ...(guildId ? { guildId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(parentPeerId ? { parentPeerId } : {}),
    ...(memberRoleIds ? { memberRoleIds } : {}),
  };
}

type ConversationRouteSessionEntry = Pick<
  InternalSessionEntry,
  | "sessionId"
  | "lifecycleRevision"
  | "updatedAt"
  | "conversationRouteContext"
  | "conversationRouteContextFingerprint"
>;

function conversationRouteContextFingerprint(entry: ConversationRouteSessionEntry): string {
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  const source = JSON.stringify([
    entry.sessionId ?? null,
    entry.lifecycleRevision ?? null,
    entry.updatedAt ?? null,
    context ?? null,
  ]);
  return `sha256:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

export function conversationRouteContextFromSessionEntry(
  entry: ConversationRouteSessionEntry | null | undefined,
): ConversationRouteContext | undefined {
  if (!entry?.conversationRouteContextFingerprint) {
    return undefined;
  }
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  return context &&
    entry.conversationRouteContextFingerprint === conversationRouteContextFingerprint(entry)
    ? context
    : undefined;
}

export function stampConversationRouteContext(entry: ConversationRouteSessionEntry): void {
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  if (!context) {
    entry.conversationRouteContext = undefined;
    entry.conversationRouteContextFingerprint = undefined;
    return;
  }
  entry.conversationRouteContext = context;
  entry.conversationRouteContextFingerprint = conversationRouteContextFingerprint(entry);
}

/** Carry private route facts only from an entry that this build can still validate. */
export function reconcileConversationRouteContext(
  entry: ConversationRouteSessionEntry,
  previousEntry?: ConversationRouteSessionEntry | null,
): void {
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  if (!context) {
    stampConversationRouteContext(entry);
    return;
  }
  if (conversationRouteContextFromSessionEntry(entry)) {
    return;
  }
  const previousContext = conversationRouteContextFromSessionEntry(previousEntry);
  if (previousContext && JSON.stringify(previousContext) === JSON.stringify(context)) {
    stampConversationRouteContext(entry);
    return;
  }
  entry.conversationRouteContext = undefined;
  entry.conversationRouteContextFingerprint = undefined;
}

type StoredConversationRouteContext = {
  version: 1;
  observedAt: number;
  context: ConversationRouteContext;
};

export function serializeStoredConversationRouteContext(
  context: ConversationRouteContext | undefined,
  observedAt: number,
): string | null {
  return context
    ? JSON.stringify({ version: 1, observedAt, context } satisfies StoredConversationRouteContext)
    : null;
}

export function parseStoredConversationRouteContext(
  value: unknown,
  expectedObservedAt: number | null,
): ConversationRouteContext | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.observedAt !== "number" ||
    value.observedAt !== expectedObservedAt
  ) {
    return undefined;
  }
  return parseConversationRouteContext(value.context);
}
