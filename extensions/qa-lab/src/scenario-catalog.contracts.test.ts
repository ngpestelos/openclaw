// Qa Lab tests cover scenario catalog config and execution contracts.
import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioPack } from "./scenario-catalog.js";
import { flowContainsCall, requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("qa scenario catalog contracts", () => {
  it.each([
    ["otel-trace-smoke", undefined],
    ["otel-stdout-log-smoke", "stdout"],
    ["otel-both-log-smoke", "both"],
  ] as const)(
    "keeps %s OTEL content capture within the current config contract",
    (scenarioId, exporter) => {
      const scenario = readQaScenarioById(scenarioId);

      expect(scenario.gatewayConfigPatch).toMatchObject({
        diagnostics: {
          otel: {
            captureContent: false,
            ...(exporter ? { logsExporter: exporter } : {}),
          },
        },
      });
    },
  );

  it("proves OTEL trace smoke with a decoded local receiver for the same agent turn", () => {
    const scenario = requireFlowScenario(readQaScenarioById("otel-trace-smoke"));
    const serializedFlow = JSON.stringify(scenario.execution.flow);

    expect(flowContainsCall(scenario.execution.flow, "startQaOtlpTraceReceiver")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "restartGatewayWithConfigPatch")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "runAgentPrompt")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "otelReceiver.close")).toBe(false);
    expect(serializedFlow).toContain("/v1/traces");
    expect(serializedFlow).toContain("openclaw.run");
    expect(serializedFlow).toContain("otelReceiver.leakedNeedles.size === 0");
    expect(serializedFlow).not.toContain("logs exporter enabled");
  });

  it("rejects retired config keys in scenario patches and nested flow mutations", () => {
    const retiredConfigPaths = [
      "commitments session.agentToAgent agents.defaults.memorySearch",
      "agents.defaults.compaction.reserveTokens agents.defaults.compaction.reserveTokensFloor agents.defaults.compaction.maxHistoryShare",
      "memory.search.chunking memory.search.sync memory.search.query.hybrid memory.search.remote.nonBatchConcurrency",
      "memory.search.remote.batch.wait memory.search.remote.batch.concurrency memory.search.remote.batch.pollIntervalMs memory.search.remote.batch.timeoutMinutes",
      "memory.search.local.contextSize memory.search.local.modelCacheDir memory.search.store.driver memory.search.cache.maxEntries",
    ].flatMap((paths) => paths.split(" "));
    const violations: string[] = [];
    const flowPatchScenarioIds = new Set<string>();
    let gatewayPatchCount = 0;

    const checkPatch = (patch: Record<string, unknown>, scenarioId: string, source: string) => {
      for (const configPath of retiredConfigPaths) {
        let current: unknown = patch;
        let exists = true;
        for (const segment of configPath.split(".")) {
          if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
            exists = false;
            break;
          }
          current = (current as Record<string, unknown>)[segment];
        }
        if (exists) {
          violations.push(`${scenarioId}: ${source} contains retired ${configPath}`);
        }
      }
    };

    const inspectFlow = (value: unknown, scenarioId: string): void => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          inspectFlow(entry, scenarioId);
        }
        return;
      }
      if (!value || typeof value !== "object") {
        return;
      }
      const action = value as Record<string, unknown>;
      if (action.call === "patchConfig" && Array.isArray(action.args)) {
        for (const argument of action.args) {
          if (!argument || typeof argument !== "object") {
            continue;
          }
          const patch = (argument as Record<string, unknown>).patch;
          if (patch && typeof patch === "object" && !Array.isArray(patch)) {
            flowPatchScenarioIds.add(scenarioId);
            checkPatch(patch as Record<string, unknown>, scenarioId, "flow patchConfig");
          }
        }
      }
      for (const entry of Object.values(action)) {
        inspectFlow(entry, scenarioId);
      }
    };

    for (const scenario of readQaScenarioPack().scenarios) {
      if (scenario.gatewayConfigPatch) {
        gatewayPatchCount += 1;
        checkPatch(scenario.gatewayConfigPatch, scenario.id, "gatewayConfigPatch");
      }
      if (scenario.execution.kind === "flow") {
        inspectFlow(scenario.execution.flow, scenario.id);
      }
    }

    expect(gatewayPatchCount).toBeGreaterThan(0);
    expect(flowPatchScenarioIds).toContain("session-memory-ranking");
    expect(violations).toStrictEqual([]);
  });

  it("proves a one-minute cron reminder with natural scheduled execution", () => {
    const scenario = requireFlowScenario(readQaScenarioById("cron-one-minute-ping"));
    const serializedFlow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.timeoutMs).toBe(180_000);
    expect(flowContainsCall(scenario.execution.flow, "waitForCronRunCompletion")).toBe(true);
    expect(serializedFlow).not.toContain("cron.run");
    expect(serializedFlow).toContain("completedRun.runAtMs >= new Date(scheduledAt).getTime()");
    expect(serializedFlow).toContain("completedRun.ts >= runStartedAt");
    expect(serializedFlow).toContain("completedRun.ts >= completedRun.runAtMs");
    expect(serializedFlow).not.toContain("Date.now() >= new Date(scheduledAt).getTime()");
    expect(scenario.coverage?.primary).toContain("automation.isolated-cron-execution");
    expect(scenario.coverage?.primary).not.toContain("automation.agent-cron-tool");
  });

  it("proves natural cron timing and no duplicate with the actual persisted run", () => {
    const scenario = requireFlowScenario(readQaScenarioById("cron-natural-fire-no-duplicate"));
    const serializedFlow = JSON.stringify(scenario.execution.flow);

    expect(flowContainsCall(scenario.execution.flow, "waitForCronRunCompletion")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "waitForOutboundMessage")).toBe(true);
    expect(serializedFlow).toContain("completedRun.runAtMs >= scheduledAtMs");
    expect(serializedFlow).toContain("completedRun.ts >= runStartedAt");
    expect(serializedFlow).toContain("completedRun.ts >= completedRun.runAtMs");
    expect(serializedFlow).toContain("duplicateMatches.length === 1");
    expect(serializedFlow).not.toContain("Date.now() >= scheduledAtMs");
    expect(serializedFlow).not.toContain('"cron.run"');
  });
});
