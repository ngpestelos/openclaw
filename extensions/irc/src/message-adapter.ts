// Irc plugin module implements message adapter behavior.
import { defineChannelMessageAdapterV2 } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig } from "./types.js";

type SendIrcMessageArgs = Parameters<typeof sendMessageIrc>;
type SendIrcMessageOptions = Omit<SendIrcMessageArgs[2], "cfg"> & { cfg: OpenClawConfig };

export async function sendIrcMessage(
  target: SendIrcMessageArgs[0],
  text: SendIrcMessageArgs[1],
  options: SendIrcMessageOptions,
) {
  // SAFETY: the IRC plugin schema validates the channel-owned config before dispatch.
  const { target: resolvedTarget, ...result } = await sendMessageIrc(target, text, {
    ...options,
    cfg: options.cfg as CoreConfig,
  });
  return {
    ...result,
    target: { kind: "conversation" as const, id: resolvedTarget },
  };
}

export const ircMessageAdapter = defineChannelMessageAdapterV2({
  id: "irc",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      replyTo: true,
      preDispatchAuthorization: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId, onPlatformSendDispatch }) =>
      await sendIrcMessage(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        onPlatformSendDispatch,
      }),
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId, onPlatformSendDispatch }) =>
      await sendIrcMessage(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
        cfg,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        onPlatformSendDispatch,
      }),
  },
});
