import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import {
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "../channels/plugins/binding-routing.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { listRouteBindings } from "../config/bindings.js";
import { getConversationDeliveryOperation } from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversation,
  resolveConversationRegistryScope,
  type ConversationRecord,
  type ConversationRegistryScope,
} from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import type { DurableDeliveryCompletion } from "../infra/outbound/delivery-completion.js";
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
  | "routeContextObserved"
  | "threadId"
>;

type OptionalConversationRouteFacts = Partial<Pick<ConversationRecord, "nativeChannelId">>;

type ConversationRouteCandidateWithFacts = ConversationRouteCandidate &
  OptionalConversationRouteFacts;

type ConversationRouteEligibility = "eligible" | "denied" | "unavailable";
type PluginRouteOwnerResolution =
  | { kind: "unhandled" }
  | { kind: "available"; agentId?: string }
  | { kind: "unavailable" };
type GenericRouteOwnerResolution =
  | { kind: "available"; agentId?: string }
  | { kind: "unavailable" };

function resolvePluginRouteOwner(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidateWithFacts,
): PluginRouteOwnerResolution {
  const channelId = normalizeChannelId(conversation.channel);
  const resolver = channelId
    ? getLoadedChannelPlugin(channelId)?.messaging?.resolveConversationRouteOwner
    : undefined;
  if (!resolver) {
    return { kind: "unhandled" };
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
      return { kind: "unhandled" };
    }
    if (!route) {
      return { kind: "available" };
    }
    if (route.kind === "unavailable") {
      return { kind: "unavailable" };
    }
    if (route.kind === "plugin") {
      return {
        kind: "available",
        ...(hasGlobalPluginHook(route.pluginId, "inbound_claim")
          ? {}
          : { agentId: normalizeAgentId(route.fallbackAgentId) }),
      };
    }
    return { kind: "available", agentId: normalizeAgentId(route.agentId) };
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return { kind: "available" };
    }
    throw error;
  }
}

function bindingPeerCouldMatchConversation(
  binding: ReturnType<typeof listRouteBindings>[number],
  conversation: ConversationRouteCandidate,
  unknownParent: boolean,
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
  return unknownParent && conversation.kind !== "direct" && kind !== "direct";
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
): GenericRouteOwnerResolution {
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
  if (!runtimeRoute.bindingOwnerAvailable) {
    // A missing custom store cannot prove the conversation was unbound; detached delivery waits
    // for its owner to return rather than reassigning it through configured/static fallback.
    return { kind: "unavailable" };
  }
  if (runtimeRoute.pluginId) {
    return hasGlobalPluginHook(runtimeRoute.pluginId, "inbound_claim")
      ? { kind: "available" }
      : { kind: "available", agentId: normalizeAgentId(runtimeRoute.route.agentId) };
  }
  return { kind: "available", agentId: normalizeAgentId(runtimeRoute.route.agentId) };
}

function hasUnrecordedContextualBinding(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  resolvedAgentId: string,
  unknownContext: boolean,
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
      bindingPeerCouldMatchConversation(binding, conversation, unknownContext && hasThreadContext)
    );
  });
}

/** Revalidates detached ownership; `unavailable` is temporary and must not be cached as denial. */
export function resolveConversationRouteEligibilityForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidateWithFacts;
}): ConversationRouteEligibility {
  const agentId = normalizeAgentId(params.agentId);
  const conversation = params.conversation;
  const hasObservedRouteContext = Boolean(
    conversation.routeContextObserved || conversation.routeContext,
  );
  const unknownContext = Boolean(conversation.observedFromSession && !hasObservedRouteContext);
  const pluginRoute = resolvePluginRouteOwner(params.config, conversation);
  if (pluginRoute.kind !== "unhandled") {
    if (pluginRoute.kind === "unavailable") {
      return "unavailable";
    }
    return pluginRoute.agentId === agentId &&
      !(
        unknownContext &&
        pluginRoute.agentId &&
        hasUnrecordedContextualBinding(params.config, conversation, pluginRoute.agentId, true)
      )
      ? "eligible"
      : "denied";
  }
  if (hasObservedRouteContext && conversation.routeContext) {
    const route = resolveRouteOwner(params.config, conversation, conversation.routeContext);
    if (!route) {
      return "denied";
    }
    const owner = resolveGenericRouteOwner(
      params.config,
      conversation,
      route,
      conversation.routeContext,
    );
    return owner.kind === "unavailable"
      ? "unavailable"
      : owner.agentId === agentId
        ? "eligible"
        : "denied";
  }
  const route = resolveRouteOwner(params.config, conversation);
  if (!route) {
    return "denied";
  }
  const owner = resolveGenericRouteOwner(params.config, conversation, route);
  if (owner.kind === "unavailable") {
    return "unavailable";
  }
  const resolvedOwner = owner.agentId;
  if (resolvedOwner !== agentId) {
    return "denied";
  }
  if (
    !unknownContext &&
    (route.matchedBy === "binding.peer" || route.matchedBy === "binding.peer.wildcard")
  ) {
    return "eligible";
  }
  return hasUnrecordedContextualBinding(params.config, conversation, resolvedOwner, unknownContext)
    ? "denied"
    : "eligible";
}

function rejectConversationPlatformSend(reference: string): never {
  const message = `Conversation is no longer available to this agent: ${reference}`;
  throw new PlatformMessageNotDispatchedError(message, {
    cause: new Error(message),
    retryable: false,
  });
}

function deferConversationPlatformSend(reference: string): never {
  const message = `Conversation ownership is temporarily unavailable: ${reference}`;
  throw new PlatformMessageNotDispatchedError(message, {
    cause: new Error(message),
    retryable: true,
  });
}

export function assertConversationPlatformSendAuthorized(params: {
  config: OpenClawConfig;
  agentId: string;
  conversationRef: string;
  scope: ConversationRegistryScope;
  resolveConversation?: typeof resolveConversation;
}): void {
  const conversation = (params.resolveConversation ?? resolveConversation)(
    params.scope,
    params.conversationRef,
  );
  if (!conversation) {
    rejectConversationPlatformSend(params.conversationRef);
  }
  const eligibility = resolveConversationRouteEligibilityForAgent({
    config: params.config,
    agentId: params.agentId,
    conversation,
  });
  if (eligibility === "unavailable") {
    deferConversationPlatformSend(params.conversationRef);
  }
  if (eligibility === "denied") {
    rejectConversationPlatformSend(params.conversationRef);
  }
}

export function assertQueuedConversationPlatformSendAuthorized(params: {
  config: OpenClawConfig;
  completion: Extract<DurableDeliveryCompletion, { kind: "conversation" }>;
}): void {
  const scope = {
    ...resolveConversationRegistryScope({
      config: params.config,
      agentId: params.completion.agentId,
    }),
    ...(params.completion.storePath ? { storePath: params.completion.storePath } : {}),
  };
  const operation = getConversationDeliveryOperation(scope, params.completion.operationId);
  if (!operation) {
    rejectConversationPlatformSend(params.completion.operationId);
  }
  assertConversationPlatformSendAuthorized({
    config: params.config,
    agentId: params.completion.agentId,
    conversationRef: operation.conversationRef,
    scope,
  });
}
