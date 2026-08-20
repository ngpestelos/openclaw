import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { listRouteBindings } from "../config/bindings.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingId } from "../routing/binding-scope.js";
import { peerKindMatches } from "../routing/peer-kind-match.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";

type ConversationRouteCandidate = Pick<
  ConversationRecord,
  | "accountId"
  | "channel"
  | "kind"
  | "observedFromSession"
  | "parentConversationRef"
  | "peerId"
  | "routeContext"
  | "threadId"
>;

type ResolvedRouteOwner = Pick<ResolvedAgentRoute, "agentId" | "matchedBy">;

type PluginRouteOwnerResolution = { handled: false } | { handled: true; agentId?: string };

function resolvePluginRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
): PluginRouteOwnerResolution {
  const channelId = normalizeChannelId(conversation.channel);
  const resolver = channelId
    ? getLoadedChannelPlugin(channelId)?.messaging?.resolveConversationRouteOwner
    : undefined;
  if (!resolver) {
    return { handled: false };
  }
  try {
    const route = resolver({
      cfg: config,
      accountId: normalizeAccountId(conversation.accountId),
      conversation: {
        kind: conversation.kind,
        peerId: conversation.peerId,
        ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
        ...(conversation.routeContext ? { context: conversation.routeContext } : {}),
      },
    });
    if (route === undefined) {
      return { handled: false };
    }
    return { handled: true, ...(route ? { agentId: normalizeAgentId(route.agentId) } : {}) };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return { handled: true };
    }
    throw error;
  }
}

function bindingPeerCouldMatchConversation(
  binding: ReturnType<typeof listRouteBindings>[number],
  conversation: ConversationRouteCandidate,
  hasThreadContext: boolean,
): boolean {
  const peer = binding.match.peer;
  if (!peer) {
    return true;
  }
  const kind = normalizeChatType(peer.kind);
  const id = normalizeRouteBindingId(peer.id);
  if (!kind || !id) {
    return false;
  }
  if (peerKindMatches(kind, conversation.kind) && (id === "*" || id === conversation.peerId)) {
    return true;
  }
  return hasThreadContext && conversation.kind !== "direct" && kind !== "direct";
}

function resolveRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  context?: NonNullable<ConversationRouteCandidate["routeContext"]>,
): ResolvedRouteOwner | undefined {
  try {
    const route = resolveAgentRoute({
      cfg: config,
      channel: conversation.channel,
      accountId: conversation.accountId,
      peer: { kind: conversation.kind, id: conversation.peerId },
      ...(context?.parentPeerId && conversation.kind !== "direct"
        ? { parentPeer: { kind: conversation.kind, id: context.parentPeerId } }
        : {}),
      ...(context?.guildId ? { guildId: context.guildId } : {}),
      ...(context?.teamId ? { teamId: context.teamId } : {}),
      ...(context?.memberRoleIds ? { memberRoleIds: context.memberRoleIds } : {}),
    });
    return { agentId: normalizeAgentId(route.agentId), matchedBy: route.matchedBy };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return undefined;
    }
    throw error;
  }
}

function hasUnrecordedContextualBinding(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  resolvedAgentId: string,
): boolean {
  const channel = normalizeLowercaseStringOrEmpty(conversation.channel);
  const accountId = normalizeAccountId(conversation.accountId);
  const hasThreadContext = Boolean(conversation.parentConversationRef || conversation.threadId);
  const hasGuildContext = conversation.kind === "channel";
  return listRouteBindings(config).some((binding) => {
    const pattern = binding.match.accountId?.trim() ?? "";
    const contextualScope = Boolean(
      (hasGuildContext && normalizeRouteBindingId(binding.match.guildId)) ||
      normalizeRouteBindingId(binding.match.teamId) ||
      (hasGuildContext && binding.match.roles?.length) ||
      (hasThreadContext &&
        binding.match.peer?.kind !== "direct" &&
        normalizeRouteBindingId(binding.match.peer?.id)),
    );
    return (
      contextualScope &&
      normalizeAgentId(binding.agentId) !== resolvedAgentId &&
      normalizeLowercaseStringOrEmpty(binding.match.channel) === channel &&
      (pattern === "*" || normalizeAccountId(pattern) === accountId) &&
      bindingPeerCouldMatchConversation(binding, conversation, hasThreadContext)
    );
  });
}

/** Checks detached outbound eligibility without treating inbound context as a reusable grant. */
export function isConversationRouteEligibleForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const conversation = params.conversation;
  const pluginRoute = resolvePluginRouteOwner(params.config, conversation);
  if (pluginRoute.handled) {
    return pluginRoute.agentId === agentId;
  }
  if (conversation.observedFromSession && conversation.routeContext) {
    return (
      resolveRouteOwner(params.config, conversation, conversation.routeContext)?.agentId === agentId
    );
  }
  const route = resolveRouteOwner(params.config, conversation);
  if (route?.agentId !== agentId) {
    return false;
  }
  if (route.matchedBy === "binding.peer" || route.matchedBy === "binding.peer.wildcard") {
    return true;
  }
  return !hasUnrecordedContextualBinding(params.config, conversation, route.agentId);
}
