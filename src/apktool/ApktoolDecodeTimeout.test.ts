import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { afterEach, expect, it, vi } from "vitest";

import { createApktoolResourceAnalysisService } from "../application/ProviderOperationServices.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_APKTOOL_DECODE_TIMEOUT_MS,
  MAX_APKTOOL_DECODE_OUTPUT_BYTES,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  ProcessDiagnosticBudget,
  ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import { ApktoolProvider } from "./ApktoolProvider.js";

vi.mock("../process/OwnedCommand.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/OwnedCommand.js")>()),
  runOwnedCommand: vi.fn(),
}));

const YML = [
  "!!brut.androlib.meta.MetaInfo",
  "sdkInfo:",
  "  minSdkVersion: '24'",
  "  targetSdkVersion: '34'",
  "versionInfo:",
  "  versionCode: '7'",
  "  versionName: 1.2.3",
  "",
].join("\n");
const MANIFEST = [
  '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.rea.apktool.probe"/>',
  "",
].join("\n");

const decodeTimeouts: (number | null)[] = [];
const outputBudgets: ProcessDiagnosticBudget[] = [];

afterEach(() => {
  decodeTimeouts.length = 0;
  outputBudgets.length = 0;
  vi.mocked(runOwnedCommand).mockReset();
});

const completed = (text: string): ProviderProcessSnapshot => {
  const bytes = Buffer.byteLength(text);
  return {
    stdout: { text, bytes, observedBytes: bytes },
    stderr: { text: "", bytes: 0, observedBytes: 0 },
    exitCode: 0,
    signal: null,
  };
};

const installLauncher = (): void => {
  vi.mocked(runOwnedCommand).mockImplementation(async (spawn, limits) => {
    if (spawn.arguments[0] === "--version") {
      const output = completed("2.9.3\n");
      limits.observeCompleted?.(output);
      return output;
    }
    decodeTimeouts.push(limits.timeoutMs);
    outputBudgets.push(limits.diagnosticBytes);
    // Projects the deadline sentence only. A real launcher expiry and its
    // process-tree cleanup are covered by apktoolDecodeDeadline.test.ts.
    if (
      limits.timeoutMs === 200 ||
      limits.timeoutMs === MAX_NODE_TIMER_DELAY_MS
    )
      throw new OwnedCommandFailure("timeout", "Command deadline elapsed.");
    const outputIndex = spawn.arguments.indexOf("-o");
    const workspace = spawn.arguments[outputIndex + 1];
    if (workspace === undefined) throw new Error("decode output was not named");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "apktool.yml"), YML);
    await writeFile(join(workspace, "AndroidManifest.xml"), MANIFEST);
    return completed("I: Using Apktool on stub\n");
  });
};

const decode = async (
  provider: ApktoolProvider,
  path: string,
  decodeTimeoutMs?: number,
) =>
  createApktoolResourceAnalysisService(provider).execute(
    "decode_android_resources",
    {
      path,
      include_strings: false,
      ...(decodeTimeoutMs === undefined
        ? {}
        : { decode_timeout_ms: decodeTimeoutMs }),
    },
  );

it("applies the omitted 600000 ms decode deadline and a selected value on the next decode", async () => {
  const root = await createTestTempDirectory("rea-apktool-deadline-");
  const path = join(root, "probe.apk");
  await writeFile(path, "apk-bytes");
  installLauncher();
  const command =
    process.platform === "win32"
      ? "C:\\opt\\apktool\\apktool"
      : "/opt/apktool/apktool";
  const provider = new ApktoolProvider({
    environment: { REA_APKTOOL_COMMAND: command },
  });
  try {
    const omitted = await decode(provider, path);
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    expect(omitted.value.parameters).not.toHaveProperty("decode_timeout_ms");
    expect(decodeTimeouts).toEqual([DEFAULT_APKTOOL_DECODE_TIMEOUT_MS]);
    expect(outputBudgets).toEqual([4 * 1024 * 1024]);

    const timedOut = await decode(provider, path, 200);
    if (timedOut.ok) throw new Error("Expected a decode deadline");
    const projected = projectAnalysisError(timedOut.error);
    const decodeDeadline = {
      control_kind: "parameter",
      parameter: "decode_timeout_ms",
      effective_value: 200,
      unit: "ms",
      minimum: 1,
      maximum: MAX_NODE_TIMER_DELAY_MS,
      default_value: DEFAULT_APKTOOL_DECODE_TIMEOUT_MS,
      applies_at: "next_call",
    };
    expect(projected).toMatchObject({
      code: "provider_timeout",
      details: {
        timeout_ms: 200,
        limit: decodeDeadline,
      },
    });
    expect(projected.details?.limit).not.toHaveProperty("cli_flag");
    expect(projected.details).not.toHaveProperty("refusal");
    expect(decodeTimeouts).toEqual([DEFAULT_APKTOOL_DECODE_TIMEOUT_MS, 200]);
    // A selected deadline leaves the separate output capture budget unchanged.
    expect(outputBudgets).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024]);

    const selected = await decode(provider, path, 5_000);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.parameters).toMatchObject({
      decode_timeout_ms: 5_000,
    });
    expect(decodeTimeouts).toEqual([
      DEFAULT_APKTOOL_DECODE_TIMEOUT_MS,
      200,
      5_000,
    ]);

    const maximum = await decode(provider, path, MAX_NODE_TIMER_DELAY_MS);
    if (maximum.ok) throw new Error("Expected the maximum decode deadline");
    expect(projectAnalysisError(maximum.error).details?.limit).toMatchObject({
      parameter: "decode_timeout_ms",
      effective_value: MAX_NODE_TIMER_DELAY_MS,
      maximum: MAX_NODE_TIMER_DELAY_MS,
    });
  } finally {
    await provider.close();
  }
});

it("clamps an above-cap producer.output_bytes setting to the Apktool capture budget", async () => {
  const root = await createTestTempDirectory("rea-apktool-output-cap-");
  const path = join(root, "probe.apk");
  await writeFile(path, "apk-bytes");
  installLauncher();
  const command =
    process.platform === "win32"
      ? "C:\\opt\\apktool\\apktool"
      : "/opt/apktool/apktool";
  const above = String(MAX_APKTOOL_DECODE_OUTPUT_BYTES + 1);
  const seeded = new ApktoolProvider({
    environment: {
      REA_APKTOOL_COMMAND: command,
      REA_PRODUCER_OUTPUT_BYTES: above,
    },
  });
  try {
    const fromSeed = await decode(seeded, path);
    expect(fromSeed.ok).toBe(true);
    expect(outputBudgets).toEqual([MAX_APKTOOL_DECODE_OUTPUT_BYTES]);
  } finally {
    await seeded.close();
  }

  outputBudgets.length = 0;
  const runtime = new ApktoolProvider({
    environment: { REA_APKTOOL_COMMAND: command },
  });
  try {
    const fromRuntime = await runWithAnalysisOperationSnapshot(
      {
        revision: 1,
        overrides: {
          "producer.output_bytes": MAX_APKTOOL_DECODE_OUTPUT_BYTES + 1,
        },
      },
      () => decode(runtime, path),
    );
    expect(fromRuntime.ok).toBe(true);
    expect(outputBudgets).toEqual([MAX_APKTOOL_DECODE_OUTPUT_BYTES]);
  } finally {
    await runtime.close();
  }
});
