import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSlackInstallationKind } from "./installation-identity-state.js";
import {
  normalizeSlackRouteBindingConfig,
  resolveSlackConversationBindingRoute,
} from "./monitor/message-handler/prepare-routing.js";
import {
  qualifySlackConversationId,
  qualifySlackRoutePeerId,
} from "./monitor/workspace-routing.js";
import { parseSlackTarget } from "./targets.js";

export function inspectSlackConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    nativeChannelId?: string;
    context?: { teamId?: string };
  };
}) {
  const installationKind = getSlackInstallationKind(params.accountId);
  const direct = params.conversation.kind === "direct";
  const target = parseSlackTarget(params.conversation.peerId, {
    defaultKind: direct ? "user" : "channel",
  });
  if (!target || target.kind !== (direct ? "user" : "channel")) {
    return null;
  }
  // Qualified targets are durable Enterprise evidence even after monitor state is released;
  // degraded state makes only an unqualified target ambiguous.
  const targetIsEnterprise = Boolean(target.teamId);
  if (
    (targetIsEnterprise && installationKind === "workspace") ||
    (!targetIsEnterprise && installationKind === "degraded")
  ) {
    return null;
  }
  const contextTeamId = params.conversation.context?.teamId?.trim();
  if (
    contextTeamId &&
    target.teamId &&
    contextTeamId.toLowerCase() !== target.teamId.toLowerCase()
  ) {
    return null;
  }
  const teamId = contextTeamId ?? target.teamId;
  if (
    !direct &&
    params.conversation.nativeChannelId &&
    params.conversation.nativeChannelId.toLowerCase() !== target.id.toLowerCase()
  ) {
    return null;
  }
  const enterpriseRoute = installationKind === "enterprise" || targetIsEnterprise;
  if (enterpriseRoute && !teamId) {
    return null;
  }
  const enterpriseScope = enterpriseRoute && teamId ? { teamId } : undefined;
  const route = resolveAgentRoute({
    cfg: normalizeSlackRouteBindingConfig(params.cfg),
    channel: "slack",
    accountId: params.accountId,
    teamId,
    peer: {
      kind: params.conversation.kind,
      id: qualifySlackRoutePeerId({
        id: target.id,
        kind: direct ? "user" : "channel",
        eventScope: enterpriseScope,
      }),
    },
  });
  const baseConversationId = qualifySlackConversationId(
    direct ? `user:${target.id}` : target.id,
    enterpriseScope,
  );
  const bindingRoute = resolveSlackConversationBindingRoute({
    cfg: params.cfg,
    route,
    accountId: params.accountId,
    baseConversationId,
    runtimeBindingThreadId: params.conversation.threadId,
    bindingsEnabled: !enterpriseRoute,
    touchBinding: false,
  });
  if (bindingRoute.runtimeRoute.pluginId) {
    return {
      kind: "plugin" as const,
      pluginId: bindingRoute.runtimeRoute.pluginId,
      fallbackAgentId: route.agentId,
    };
  }
  return {
    kind: "agent" as const,
    agentId:
      bindingRoute.runtimeRoute.boundAgentId ??
      bindingRoute.configuredRoute?.boundAgentId ??
      route.agentId,
  };
}
