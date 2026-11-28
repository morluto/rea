import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { historicalHar } from "../../../tests/fixtures/historicalHar.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectWebNetworkCaptureInputSchema } from "../../domain/webNetworkCapture.js";
import {
  HAR_CAPTURE_PROVIDER_IDENTITY,
  SAZ_CAPTURE_PROVIDER_IDENTITY,
} from "./CaptureProviderIdentities.js";
import { decodeHarCapture } from "./HarCapture.js";
import { HistoricalCaptureDecoder } from "./HistoricalCaptureDecoder.js";

// The decoder's owned launcher needs the Windows job-object addon. This
// fixture runs the same reply command and leaves admission in the decoder.
vi.mock("../../process/ProviderProcess.js", async (original) => {
  const { spawn } = await import("node:child_process");
  const actual =
    await original<typeof import("../../process/ProviderProcess.js")>();
  return {
    ...actual,
    async spawnOwnedProviderProcess(
      options: Parameters<typeof actual.spawnOwnedProviderProcess>[0],
    ) {
      const env = Object.fromEntries(
        Object.entries(options.hostEnvironment ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const child = spawn(options.command, [...options.arguments], {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("capture fixture did not start");
      return {
        process: child,
        ownership: {
          runId: options.runId,
          leaderPid: pid,
          processGroupId: pid,
          expectedParentPid: process.pid,
          sweepTokenOwnedProcesses: false as const,
        },
        async cleanup() {
          if (child.exitCode === null && child.signalCode === null)
            child.kill();
          return { cleaned: true as const, signaled: false };
        },
      };
    },
  };
});

const writeReply = (body: unknown) => ({
  command: process.execPath,
  arguments: [
    "-e",
    `require("node:fs").writeFileSync(process.argv[1], process.argv[2])`,
    "",
    JSON.stringify(body),
  ],
});

const runtimeAt = async (root: string) => {
  const path = join(root, "runtime");
  await mkdir(path);
  return { path, close: () => Promise.resolve() };
};

const selectedEnvironment = (memberCount: string): NodeJS.ProcessEnv => ({
  ...process.env,
  REA_ARTIFACT_MEMBER_COUNT: memberCount,
});

it("sends the selected SAZ member count and reports that source", async () => {
  const selectedCount =
    process.env.REA_ARTIFACT_MEMBER_COUNT === "1" ? "2" : "1";
  const root = await createTestTempDirectory("rea-saz-selected-count-");
  const path = join(root, "capture.saz");
  await writeFile(path, "saz");
  let request: { member_count?: number } | undefined;
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "saz",
        identity: SAZ_CAPTURE_PROVIDER_IDENTITY,
        command: async (requestPath, runtimePath) => {
          request = JSON.parse(await readFile(requestPath, "utf8")) as {
            member_count?: number;
          };
          const reply = writeReply({
            ok: false,
            reason: "member-count",
            message: "count",
            pointer: "",
            member_count: Number(selectedCount),
          });
          reply.arguments[2] = join(runtimePath, "reply.json");
          return reply;
        },
      },
    ],
    selectedEnvironment(selectedCount),
    () => runtimeAt(root),
  );
  onTestFinished(() => decoder.close());
  const result = await decoder.inspect(
    inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "saz",
    }),
  );
  expect(request?.member_count).toBe(Number(selectedCount));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("artifact.member_count");
  expect(result.error.message).not.toContain("artifact_limits");
  expect(result.error.limit).toMatchObject({
    setting: "artifact.member_count",
    effective_value: Number(selectedCount),
    source: "setting",
    unit: "count",
  });
  expect(result.error.limit).not.toHaveProperty("parameter");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      limit: {
        setting: "artifact.member_count",
        effective_value: Number(selectedCount),
        source: "setting",
      },
    },
  });
});

it("leaves HAR admission independent of the ZIP member-count seed", async () => {
  const root = await createTestTempDirectory("rea-har-member-count-");
  const path = join(root, "capture.har");
  const text = JSON.stringify(historicalHar());
  await writeFile(path, text);
  let request: { member_count?: number } | undefined;
  let commanded = false;
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "har",
        identity: HAR_CAPTURE_PROVIDER_IDENTITY,
        command: async (requestPath, runtimePath) => {
          commanded = true;
          request = JSON.parse(await readFile(requestPath, "utf8")) as {
            member_count?: number;
          };
          const reply = writeReply({
            ok: true,
            value: decodeHarCapture(text, []),
          });
          reply.arguments[2] = join(runtimePath, "reply.json");
          return reply;
        },
      },
    ],
    selectedEnvironment("not-a-count"),
    () => runtimeAt(root),
  );
  onTestFinished(() => decoder.close());
  const result = await decoder.inspect(
    inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
    }),
  );
  expect(commanded).toBe(true);
  expect(request).toBeDefined();
  expect(request).not.toHaveProperty("member_count");
  expect(result.ok).toBe(true);
});
