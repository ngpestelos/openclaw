import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";
import { parseConversationRouteContext } from "./conversation-route-context-internal.js";
import type { ConversationRouteContext } from "./conversation-route-context.types.js";

export type { ConversationRouteContext } from "./conversation-route-context.types.js";

/** Captures only the authoritative inbound facts needed to replay current route precedence. */
export function conversationRouteContextFromMsgContext(
  ctx: MsgContext,
): ConversationRouteContext | undefined {
  const channel = normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider);
  const spaceId = normalizeOptionalString(ctx.GroupSpace);
  return parseConversationRouteContext({
    peerId: ctx.ConversationRoutePeerId,
    ...(channel === "discord" && spaceId ? { guildId: spaceId } : {}),
    ...((channel === "slack" || channel === "mattermost" || channel === "msteams") && spaceId
      ? { teamId: spaceId }
      : {}),
    parentPeerId: ctx.ThreadParentId,
    memberRoleIds: ctx.MemberRoleIds,
  });
}
