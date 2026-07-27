// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  client,
  createGatewayHarness,
  deferred,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

describe("application approval replacement races", () => {
  for (const outcome of ["success", "failure"] as const) {
    it(`keeps a refreshed approval owned by its pending decision after ${outcome}`, async () => {
      const resolveAttempt = deferred();
      const request = vi.fn<RequestFn>((method) =>
        method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
      );
      const harness = createGatewayHarness(client(request));
      const overlays = createApplicationOverlays(harness.gateway);

      harness.emitApproval("approval-refreshed", 1_000);
      const original = overlays.snapshot.approvalQueue[0];
      const decision = overlays.decideApproval("allow-once");
      harness.emitApproval("approval-refreshed", 1_000);

      expect(overlays.snapshot.approvalQueue[0]).not.toBe(original);
      expect(overlays.snapshot.approvalQueue[0]).toMatchObject({
        createdAtMs: 1_000,
        id: "approval-refreshed",
        kind: "exec",
      });

      if (outcome === "success") {
        resolveAttempt.resolve({ ok: true });
      } else {
        resolveAttempt.reject(new Error("gateway unavailable"));
      }
      await decision;

      if (outcome === "success") {
        expect(overlays.snapshot.approvalQueue).toEqual([]);
        expect(overlays.snapshot.approvalErrors).toEqual(new Map());
      } else {
        expect(overlays.snapshot.approvalQueue).toEqual([
          expect.objectContaining({ createdAtMs: 1_000, id: "approval-refreshed" }),
        ]);
        expect(overlays.snapshot.approvalErrors.get("approval-refreshed")).toBe(
          "Approval failed: gateway unavailable",
        );
      }
      expect(overlays.snapshot.approvalBusy).toBe(false);
      overlays.dispose();
    });
  }

  it("keeps a same-id replacement when the original decision succeeds", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-reused", 1_000);
    const decision = overlays.decideApproval("allow-once");
    harness.emitApproval("approval-reused", 2_000);
    resolveAttempt.resolve({ ok: true });
    await decision;

    expect(overlays.snapshot.approvalQueue).toEqual([
      expect.objectContaining({ createdAtMs: 2_000, id: "approval-reused" }),
    ]);
    expect(overlays.snapshot.approvalErrors).toEqual(new Map());
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });

  it("does not attach an old decision failure to a same-id replacement", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-reused", 1_000);
    const decision = overlays.decideApproval("allow-once");
    harness.emitApproval("approval-reused", 2_000);
    resolveAttempt.reject(new Error("gateway unavailable"));
    await decision;

    expect(overlays.snapshot.approvalQueue).toEqual([
      expect.objectContaining({ createdAtMs: 2_000, id: "approval-reused" }),
    ]);
    expect(overlays.snapshot.approvalErrors).toEqual(new Map());
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });

  it("does not refresh away a same-id replacement after a stale decision", async () => {
    const resolveAttempt = deferred();
    const request = vi.fn<RequestFn>((method) =>
      method.endsWith(".list") ? Promise.resolve([]) : resolveAttempt.promise,
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);

    harness.emitApproval("approval-reused", 1_000);
    const decision = overlays.decideApproval("allow-once");
    harness.emitApproval("approval-reused", 2_000);
    const initialListRequestCount = request.mock.calls.filter(([method]) =>
      method.endsWith(".list"),
    ).length;
    resolveAttempt.reject(new Error("unknown or expired approval id"));
    await decision;

    expect(overlays.snapshot.approvalQueue).toEqual([
      expect.objectContaining({ createdAtMs: 2_000, id: "approval-reused" }),
    ]);
    expect(overlays.snapshot.approvalErrors).toEqual(new Map());
    expect(request.mock.calls.filter(([method]) => method.endsWith(".list"))).toHaveLength(
      initialListRequestCount,
    );
    expect(overlays.snapshot.approvalBusy).toBe(false);
    overlays.dispose();
  });
});
