import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type { PluginHookName } from "./hook-types.js";

type TargetedPluginHookAvailability = "missing-plugin" | "no-handler" | "ready";

/** Mirrors targeted hook dispatch without executing the handler. */
export function resolveTargetedPluginHookAvailability(
  registry: Pick<GlobalHookRunnerRegistry, "plugins" | "typedHooks"> | null | undefined,
  hookName: PluginHookName,
  pluginId: string,
): TargetedPluginHookAvailability {
  if (!registry?.plugins.some((plugin) => plugin.id === pluginId && plugin.status === "loaded")) {
    return "missing-plugin";
  }
  return registry.typedHooks.some(
    (hook) => hook.hookName === hookName && hook.pluginId === pluginId,
  )
    ? "ready"
    : "no-handler";
}
