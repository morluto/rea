import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveReaLaunch } from "@rea-studio/agent";
import { parseJobSpec, StudioStore } from "@rea-studio/core";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";

import { processJob } from "./runner.js";

const fixture = fileURLToPath(
  new URL("../../../packages/agent/test/fixtures/notes-app", import.meta.url),
);

const textModel = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "Phase done." }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
      warnings: [],
    }),
  });

const spec = parseJobSpec({
  title: "Worker test",
  target: { kind: "javascript", path: fixture },
  access: { mode: "none" },
  scope: { mode: "full", description: "" },
  enhancement: { hardening: [] },
  budget: { maxStepsPerPhase: 5 },
  approvals: { destructiveTools: "auto", commands: "auto", specReview: true },
  authorizationAttested: true,
});

const waitFor = async <T>(probe: () => T | undefined, timeoutMs = 60_000): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting.");
    await new Promise((done) => setTimeout(done, 200));
  }
};

describe.skipIf(resolveReaLaunch().source === "npx")("processJob", () => {
  let home: string | undefined;
  let store: StudioStore | undefined;
  afterEach(async () => {
    store?.close();
    if (home) await rm(home, { recursive: true, force: true });
  });

  const setup = async () => {
    home = await mkdtemp(join(tmpdir(), "studio-home-"));
    store = new StudioStore(home);
    const model = store.createModel({
      name: "Mock",
      provider: "openai",
      model: "mock",
      apiKey: "sk-worker-test-key",
    });
    expect(store.listModels()[0]).toMatchObject({ hasApiKey: true });
    expect(JSON.stringify(store.listModels())).not.toContain("sk-worker-test-key");
    const job = store.createJob({
      spec,
      secrets: {},
      analysisModelId: model.id,
      buildModelId: model.id,
    });
    const claimed = store.claimNextJob();
    expect(claimed?.id).toBe(job.id);
    return { store, job: claimed ?? job };
  };

  it("waits for the spec approval, then runs every phase to a report", async () => {
    const { store: db, job } = await setup();
    const run = processJob(db, job, { createModel: textModel });
    const pending = await waitFor(() => db.listApprovals(job.id, "pending")[0]);
    expect(pending.kind).toBe("spec");
    expect(db.getJob(job.id)?.status).toBe("waiting_approval");
    db.decideApproval(pending.id, true);

    const result = await run;
    expect(result.status).toBe("succeeded");
    expect(db.getJob(job.id)?.status).toBe("succeeded");
    expect(db.getJob(job.id)?.usage.totalTokens).toBeGreaterThan(0);
    expect(existsSync(join(job.workspace, "output", "REPORT.md"))).toBe(true);
    const types = db.listEvents(job.id).map(({ event }) =>
      event.type === "approval" ? `approval:${event.status}` : event.type,
    );
    expect(types).toContain("approval:requested");
    expect(types).toContain("approval:approved");
    expect(types.at(-1)).toBe("done");
  });

  it("cancels a job that is waiting for approval", async () => {
    const { store: db, job } = await setup();
    const run = processJob(db, job, { createModel: textModel });
    await waitFor(() => db.listApprovals(job.id, "pending")[0]);
    db.requestCancel(job.id);
    const result = await run;
    expect(result.status).toBe("cancelled");
    expect(db.getJob(job.id)?.status).toBe("cancelled");
  });
});
