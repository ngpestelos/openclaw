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

export function inspectSlackConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    context?: { teamId?: string };
  };
}) {
  const installationKind = getSlackInstallationKind(params.accountId);
  const enterpriseScope =
    installationKind === "enterprise" && params.conversation.context?.teamId
      ? { teamId: params.conversation.context.teamId }
      : undefined;
  const direct = params.conversation.kind === "direct";
  const route = resolveAgentRoute({
    cfg: normalizeSlackRouteBindingConfig(params.cfg),
    channel: "slack",
    accountId: params.accountId,
    teamId: params.conversation.context?.teamId,
    peer: {
      kind: params.conversation.kind,
      id: qualifySlackRoutePeerId({
        id: params.conversation.peerId,
        kind: direct ? "user" : "channel",
        eventScope: enterpriseScope,
      }),
    },
  });
  const baseConversationId = qualifySlackConversationId(
    direct ? `user:${params.conversation.peerId}` : params.conversation.peerId,
    enterpriseScope,
  );
  const bindingRoute = resolveSlackConversationBindingRoute({
    cfg: params.cfg,
    route,
    accountId: params.accountId,
    baseConversationId,
    runtimeBindingThreadId: params.conversation.threadId,
    bindingsEnabled: installationKind !== "enterprise",
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
