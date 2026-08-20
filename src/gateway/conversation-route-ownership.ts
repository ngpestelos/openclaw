import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "../channels/plugins/binding-routing.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { listRouteBindings } from "../config/bindings.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasGlobalPluginHook } from "../plugins/hook-runner-global.js";
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

type OptionalConversationRouteFacts = Partial<Pick<ConversationRecord, "nativeChannelId">>;

type ConversationRouteCandidateWithFacts = ConversationRouteCandidate &
  OptionalConversationRouteFacts;

type PluginRouteOwnerResolution = { handled: false } | { handled: true; agentId?: string };

function resolvePluginRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidateWithFacts,
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
        ...(conversation.nativeChannelId ? { nativeChannelId: conversation.nativeChannelId } : {}),
        ...(conversation.routeContext ? { context: conversation.routeContext } : {}),
      },
    });
    if (route === undefined) {
      return { handled: false };
    }
    if (!route) {
      return { handled: true };
    }
    if (route.kind === "plugin") {
      return {
        handled: true,
        ...(hasGlobalPluginHook(route.pluginId, "inbound_claim")
          ? {}
          : { agentId: normalizeAgentId(route.fallbackAgentId) }),
      };
    }
    return { handled: true, agentId: normalizeAgentId(route.agentId) };
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
): ResolvedAgentRoute | undefined {
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
    return { ...route, agentId: normalizeAgentId(route.agentId) };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return undefined;
    }
    throw error;
  }
}

function resolveGenericRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  route: ResolvedAgentRoute,
  context?: NonNullable<ConversationRouteCandidate["routeContext"]>,
): { agentId?: string } {
  const bindingConversation = {
    channel: conversation.channel,
    accountId: normalizeAccountId(conversation.accountId),
    conversationId: conversation.peerId,
    ...(context?.parentPeerId ? { parentConversationId: context.parentPeerId } : {}),
  };
  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: config,
    route,
    conversation: bindingConversation,
  });
  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route: configuredRoute.route,
    touchBinding: false,
    conversation: bindingConversation,
  });
  if (runtimeRoute.pluginId) {
    return hasGlobalPluginHook(runtimeRoute.pluginId, "inbound_claim")
      ? {}
      : { agentId: normalizeAgentId(runtimeRoute.route.agentId) };
  }
  return { agentId: normalizeAgentId(runtimeRoute.route.agentId) };
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
  conversation: ConversationRouteCandidateWithFacts;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const conversation = params.conversation;
  const pluginRoute = resolvePluginRouteOwner(params.config, conversation);
  if (pluginRoute.handled) {
    return pluginRoute.agentId === agentId;
  }
  if (conversation.observedFromSession && conversation.routeContext) {
    const route = resolveRouteOwner(params.config, conversation, conversation.routeContext);
    return route
      ? resolveGenericRouteOwner(params.config, conversation, route, conversation.routeContext)
          .agentId === agentId
      : false;
  }
  const route = resolveRouteOwner(params.config, conversation);
  if (!route) {
    return false;
  }
  const resolvedOwner = resolveGenericRouteOwner(params.config, conversation, route).agentId;
  if (resolvedOwner !== agentId) {
    return false;
  }
  if (route.matchedBy === "binding.peer" || route.matchedBy === "binding.peer.wildcard") {
    return true;
  }
  return !hasUnrecordedContextualBinding(params.config, conversation, resolvedOwner);
}
