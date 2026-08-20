// Nextcloud Talk plugin module implements message adapter behavior.
import { defineChannelMessageAdapterV2 } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

type SendNextcloudTalkArgs = Parameters<typeof sendMessageNextcloudTalk>;
type SendNextcloudTalkOptions = Omit<SendNextcloudTalkArgs[2], "cfg"> & {
  cfg: OpenClawConfig;
};

export async function sendNextcloudTalkMessage(
  target: SendNextcloudTalkArgs[0],
  text: SendNextcloudTalkArgs[1],
  options: SendNextcloudTalkOptions,
) {
  // SAFETY: the plugin schema validates the channel-owned config before dispatch.
  return await sendMessageNextcloudTalk(target, text, {
    ...options,
    cfg: options.cfg as CoreConfig,
  });
}

export const nextcloudTalkMessageAdapter = defineChannelMessageAdapterV2({
  id: "nextcloud-talk",
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
      await sendNextcloudTalkMessage(to, text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        cfg,
        onPlatformSendDispatch,
      }),
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId, onPlatformSendDispatch }) =>
      await sendNextcloudTalkMessage(to, mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text, {
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        cfg,
        onPlatformSendDispatch,
      }),
  },
});
