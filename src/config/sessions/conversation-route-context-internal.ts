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

type ConversationRouteContextObservation = {
  context?: ConversationRouteContext;
};

export function inspectConversationRouteContextFromSessionEntry(
  entry: ConversationRouteSessionEntry | null | undefined,
): ConversationRouteContextObservation | undefined {
  if (
    !entry?.conversationRouteContextFingerprint ||
    entry.conversationRouteContextFingerprint !== conversationRouteContextFingerprint(entry)
  ) {
    return undefined;
  }
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  return context ? { context } : {};
}

export function conversationRouteContextFromSessionEntry(
  entry: ConversationRouteSessionEntry | null | undefined,
): ConversationRouteContext | undefined {
  return inspectConversationRouteContextFromSessionEntry(entry)?.context;
}

export function stampConversationRouteContext(entry: ConversationRouteSessionEntry): void {
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  entry.conversationRouteContext = context;
  entry.conversationRouteContextFingerprint = conversationRouteContextFingerprint(entry);
}

/** Carry private route facts only from an entry that this build can still validate. */
export function reconcileConversationRouteContext(
  entry: ConversationRouteSessionEntry,
  previousEntry?: ConversationRouteSessionEntry | null,
): void {
  const context = parseConversationRouteContext(entry.conversationRouteContext);
  if (inspectConversationRouteContextFromSessionEntry(entry)) {
    return;
  }
  const previousObservation = inspectConversationRouteContextFromSessionEntry(previousEntry);
  if (
    previousObservation &&
    JSON.stringify(previousObservation.context) === JSON.stringify(context)
  ) {
    stampConversationRouteContext(entry);
    return;
  }
  entry.conversationRouteContext = undefined;
  entry.conversationRouteContextFingerprint = undefined;
}

type StoredConversationRouteContext = {
  version: 1;
  observedAt: number;
  context: ConversationRouteContext | null;
};

export function serializeStoredConversationRouteContext(
  context: ConversationRouteContext | undefined,
  observedAt: number,
): string {
  return JSON.stringify({
    version: 1,
    observedAt,
    context: context ?? null,
  } satisfies StoredConversationRouteContext);
}

export function parseStoredConversationRouteContext(
  value: unknown,
  expectedObservedAt: number | null,
): ConversationRouteContextObservation | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.observedAt !== "number" ||
    value.observedAt !== expectedObservedAt
  ) {
    return undefined;
  }
  const context = parseConversationRouteContext(value.context);
  if (value.context !== null && !context) {
    return undefined;
  }
  return context ? { context } : {};
}
