import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveDiscordConversationIdentity } from "./conversation-identity.js";
import { resolveDiscordConversationBindingRoute } from "./monitor/conversation-binding-route.js";
import { resolveDiscordConversationRoute } from "./monitor/route-resolution.js";

export function inspectDiscordConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    nativeChannelId?: string;
    context?: {
      parentPeerId?: string;
      guildId?: string;
      memberRoleIds?: string[];
    };
  };
}) {
  const direct = params.conversation.kind === "direct";
  const nativeConversationId = params.conversation.nativeChannelId ?? params.conversation.peerId;
  const runtimeConversationId =
    resolveDiscordConversationIdentity({
      isDirectMessage: direct,
      userId: direct ? params.conversation.peerId : undefined,
      channelId: direct ? undefined : nativeConversationId,
    }) ?? nativeConversationId;
  const route = resolveDiscordConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    guildId: params.conversation.context?.guildId,
    memberRoleIds: params.conversation.context?.memberRoleIds,
    peer: { kind: params.conversation.kind, id: params.conversation.peerId },
    parentConversationId: params.conversation.context?.parentPeerId,
  });
  const { runtimeRoute, configuredRoute } = resolveDiscordConversationBindingRoute({
    cfg: params.cfg,
    route,
    accountId: params.accountId,
    runtimeConversationId,
    configuredConversationId: nativeConversationId,
    parentConversationId: params.conversation.context?.parentPeerId,
    touchBinding: false,
  });
  if (
    !runtimeRoute.bindingOwnerAvailable &&
    // Disabled bindings intentionally have no adapter, so static/configured routing stays valid.
    resolveThreadBindingSpawnPolicy({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      kind: "subagent",
    }).enabled
  ) {
    return null;
  }
  if (runtimeRoute.pluginId) {
    return {
      kind: "plugin" as const,
      pluginId: runtimeRoute.pluginId,
      fallbackAgentId: route.agentId,
    };
  }
  return {
    kind: "agent" as const,
    agentId: runtimeRoute.boundAgentId ?? configuredRoute?.boundAgentId ?? route.agentId,
  };
}
