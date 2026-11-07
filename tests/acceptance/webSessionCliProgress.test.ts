import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";

import { parseEvidence } from "../../src/domain/evidence.js";
import { webObservationSessionSchema } from "../../src/domain/browserSession.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../fixtures/fakeCdpBrowser.js";
import {
  processTest,
  type TestProcesses,
} from "../support/process/processFixture.js";

const entrypoint = fileURLToPath(
  new URL("../../scripts/rea.mjs", import.meta.url),
);
const progressSchema = z.object({
  rea_progress: z.object({
    phase: z.literal("browser_observation"),
    completed: z.union([z.literal(1), z.literal(2)]),
    total: z.literal(2),
    message: z.string(),
    terminal: z.boolean().optional(),
  }),
});
type Progress = z.infer<typeof progressSchema>["rea_progress"];

const observe = async (
  processes: TestProcesses,
  browser: FakeCdpBrowser,
  onProgress: (update: Progress) => void = () => {},
) => {
  const child = processes.spawn(
    process.execPath,
    [
      entrypoint,
      "observe-web-session",
      browser.endpoint,
      "allowed-page",
      "--allowed-origins",
      browser.allowedOrigin,
      "--observation-ms",
      "1000",
      "--json",
    ],
    { env: { ...process.env, REA_LOG_LEVEL: "silent" } },
  );
  child.stdin.end();
  let stdout = "";
  let stderr = "";
  let pending = "";
  const updates: Progress[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const update = progressSchema.safeParse(value);
      if (!update.success) continue;
      updates.push(update.data.rea_progress);
      onProgress(update.data.rea_progress);
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 20_000);
  try {
    const [code, signal] = await once(child, "close");
    expect(timedOut, stderr).toBe(false);
    expect(signal, stderr).toBeNull();
    expect(stdout).not.toContain("rea_progress");
    return { code, stdout, stderr, updates };
  } finally {
    clearTimeout(timer);
  }
};

processTest(
  "arms the CLI caller before accepting its action and keeps final Evidence on stdout",
  async ({ processes }) => {
    const browser = await startFakeCdpBrowser({ commandEvents: () => [] });
    onTestFinished(() => browser.close());
    const url = `${browser.allowedOrigin}/action-after-ready`;
    let actions = 0;
    const result = await observe(processes, browser, (update) => {
      if (update.completed !== 1) return;
      actions += 1;
      const sessionId = browser.commands.find(
        ({ method }) => method === "Page.enable",
      )?.sessionId;
      browser.emitEvent({
        method: "Page.navigatedWithinDocument",
        ...(sessionId === undefined ? {} : { sessionId }),
        params: { frameId: "frame-main", url, navigationType: "historyApi" },
      });
    });
    expect(result.code, result.stderr).toBe(0);
    expect(actions).toBe(1);
    expect(
      result.updates.map(({ message: _message, ...facts }) => facts),
    ).toEqual([
      {
        phase: "browser_observation",
        completed: 1,
        total: 2,
      },
      {
        phase: "browser_observation",
        completed: 2,
        total: 2,
        terminal: true,
      },
    ]);
    const capture = webObservationSessionSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    expect(capture.window.end_reason).toBe("window_elapsed");
    expect(capture.timeline).toContainEqual(
      expect.objectContaining({ type: "same_document_navigation", url }),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({ method: "Target.detachFromTarget" }),
    );
  },
);

processTest(
  "does not announce arming or completion when CDP preparation fails",
  async ({ processes }) => {
    const browser = await startFakeCdpBrowser({
      commandError: ({ method }) =>
        method === "Performance.enable"
          ? { code: -32000, message: "authored preparation failure" }
          : undefined,
    });
    onTestFinished(() => browser.close());
    const result = await observe(processes, browser);
    expect(result.code).not.toBe(0);
    expect(
      result.updates.map(({ message: _message, ...facts }) => facts),
    ).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: expect.any(String),
      category: expect.any(String),
    });
    expect(browser.commands).toContainEqual(
      expect.objectContaining({ method: "Target.detachFromTarget" }),
    );
  },
);

processTest(
  "keeps a failure after arming distinct from a successfully ended window",
  async ({ processes }) => {
    const browser = await startFakeCdpBrowser({ commandEvents: () => [] });
    onTestFinished(() => browser.close());
    const result = await observe(processes, browser, (update) => {
      if (update.completed === 1) browser.emitRawMessage("{not-json");
    });
    expect(result.code).not.toBe(0);
    expect(result.updates.map(({ completed }) => completed)).toEqual([1]);
    expect(result.updates.every(({ terminal }) => terminal !== true)).toBe(
      true,
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: expect.any(String),
      category: expect.any(String),
    });
  },
);

const stoppedPreparations = [
  { event: "outside-origin", endReason: "target_left_scope" },
  { event: "session-detached", endReason: "session_detached" },
  { event: "target-crashed", endReason: "target_terminated" },
] as const;

processTest.for(stoppedPreparations)(
  "does not arm when preparation already stopped collection: $event",
  async ({ event, endReason }, { processes }) => {
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["Page.setLifecycleEventsEnabled"],
      commandEvents: (command) => {
        if (command.method !== "Page.setLifecycleEventsEnabled") return [];
        const sessionId = z.string().parse(command.sessionId);
        if (event === "outside-origin")
          return [
            {
              method: "Page.navigatedWithinDocument",
              sessionId,
              params: {
                frameId: "frame-main",
                url: "https://outside.example/withheld",
                navigationType: "historyApi",
              },
            },
          ];
        if (event === "session-detached")
          return [
            {
              method: "Target.detachedFromTarget",
              params: { sessionId, targetId: "allowed-page" },
            },
          ];
        return [{ method: "Inspector.targetCrashed", sessionId, params: {} }];
      },
    });
    onTestFinished(() => browser.close());
    let actions = 0;
    const result = await observe(processes, browser, ({ completed }) => {
      if (completed === 1) actions += 1;
    });
    expect(result.code, result.stderr).toBe(0);
    expect(actions).toBe(0);
    expect(
      result.updates.map(({ message: _message, ...facts }) => facts),
    ).toEqual([
      { phase: "browser_observation", completed: 2, total: 2, terminal: true },
    ]);
    const capture = webObservationSessionSchema.parse(
      parseEvidence(JSON.parse(result.stdout)).normalized_result,
    );
    expect(capture.window.end_reason).toBe(endReason);
    expect(result.stdout).not.toContain("https://outside.example/withheld");
  },
);
