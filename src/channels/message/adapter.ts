/**
 * Channel message adapter definition helper.
 *
 * Supplies manual receive acknowledgement defaults while preserving adapter-specific types.
 */
import type {
  AnyChannelMessageAdapterShape,
  ChannelMessageAdapter,
  ChannelMessageAdapterShape,
  ChannelMessageAdapterShapeV2,
  ChannelMessageReceiveAdapterShape,
} from "./types.js";

const defaultManualReceiveAdapter = {
  defaultAckPolicy: "manual",
  supportedAckPolicies: ["manual"],
} as const satisfies ChannelMessageReceiveAdapterShape;

type ChannelMessageAdapterWithDefaultReceive<
  TAdapter extends Pick<AnyChannelMessageAdapterShape, "receive">,
> = TAdapter & {
  receive: TAdapter["receive"] extends undefined
    ? typeof defaultManualReceiveAdapter
    : NonNullable<TAdapter["receive"]>;
};

function withDefaultReceive<const TAdapter extends Pick<AnyChannelMessageAdapterShape, "receive">>(
  adapter: TAdapter,
): ChannelMessageAdapterWithDefaultReceive<TAdapter> {
  return {
    ...adapter,
    receive: adapter.receive ?? defaultManualReceiveAdapter,
  } as ChannelMessageAdapterWithDefaultReceive<TAdapter>;
}

/** Defines a message adapter while defaulting receive acknowledgement to manual. */
export function defineChannelMessageAdapter<const TAdapter extends ChannelMessageAdapterShape>(
  adapter: TAdapter,
): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>> {
  return withDefaultReceive(adapter);
}

/** Defines a V2 message adapter with mandatory final-dispatch authorization support. */
export function defineChannelMessageAdapterV2<const TAdapter extends ChannelMessageAdapterShapeV2>(
  adapter: TAdapter,
): ChannelMessageAdapter<ChannelMessageAdapterWithDefaultReceive<TAdapter>> {
  return withDefaultReceive(adapter);
}
