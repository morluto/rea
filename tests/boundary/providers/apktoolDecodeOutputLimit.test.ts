import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ApktoolProvider } from "../../../src/apktool/ApktoolProvider.js";
import { runWithAnalysisOperationSnapshot } from "../../../src/domain/analysisOperationSnapshot.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES,
  MAX_APKTOOL_DECODE_OUTPUT_BYTES,
} from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

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
// One byte more progress output than the omitted budget admits.
const DECODE_OUTPUT_BYTES = DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES + 1;

// A launcher that answers the version probe, writes the decoded files a real
// `apktool d -o <dir>` leaves, and prints more progress than the default
// budget. The POSIX launcher shape is the one the sibling apktool boundary
// tests use.
it.skipIf(process.platform === "win32")(
  "refuses decode output above the default producer_limits.output_bytes with details.limit and decodes it once raised",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-decode-output-");
    const command = join(root, "apktool");
    await writeFile(
      command,
      [
        `#!${process.execPath}`,
        `const { mkdirSync, writeFileSync } = require("node:fs");`,
        `const { join } = require("node:path");`,
        `if (process.argv[2] === "--version") process.stdout.write("2.9.3\\n");`,
        `else {`,
        `  const out = process.argv[process.argv.indexOf("-o") + 1];`,
        `  mkdirSync(out, { recursive: true });`,
        `  writeFileSync(join(out, "apktool.yml"), ${JSON.stringify(YML)});`,
        `  writeFileSync(join(out, "AndroidManifest.xml"), ${JSON.stringify(MANIFEST)});`,
        `  process.stdout.write("x".repeat(${String(DECODE_OUTPUT_BYTES)}));`,
        `}`,
        "",
      ].join("\n"),
      { mode: 0o700, flag: "wx" },
    );
    const apk = join(root, "probe.apk");
    await writeFile(apk, "apk-bytes");
    const provider = new ApktoolProvider({
      environment: { REA_APKTOOL_COMMAND: command },
    });
    const decode = (producerLimits?: { output_bytes: number }) =>
      provider.execute({
        operation: "decode_android_resources",
        input: {
          path: apk,
          include_strings: false,
          ...(producerLimits === undefined
            ? {}
            : { producer_limits: producerLimits }),
        },
      });
    try {
      const outcome = await decode();
      if (outcome.ok) throw new Error("Expected the decode output refusal");
      const projected = projectAnalysisError(outcome.error);
      expect(projected).toMatchObject({
        code: "resource_constraint",
        details: {
          reported_limits: {
            max_output_bytes: DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES,
          },
        },
      });
      expect(projected.details?.limit).toEqual({
        control_kind: "parameter",
        parameter: "producer_limits.output_bytes",
        effective_value: DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES,
        unit: "bytes",
        minimum: 1,
        maximum: MAX_APKTOOL_DECODE_OUTPUT_BYTES,
        default_value: DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES,
        applies_at: "next_call",
      });
      expect(projected.details?.refusal).toMatchObject({
        kind: "adjustable_budget",
        control: "producer_limits.output_bytes",
      });
      // Capture stops at the budget, so no required value is claimed.
      expect(projected.details?.refusal).not.toHaveProperty("required_value");
      const raised = await decode({ output_bytes: DECODE_OUTPUT_BYTES });
      if (!raised.ok) throw raised.error;
      expect(raised.value.result).toMatchObject({
        metadata: { package_name: "com.rea.apktool.probe" },
      });
    } finally {
      await provider.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "uses an explicit producer.output_bytes as the omitted decode budget and clamps its reported maximum",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-output-setting-");
    const command = join(root, "apktool");
    await writeFile(
      command,
      [
        `#!${process.execPath}`,
        `const { mkdirSync, writeFileSync } = require("node:fs");`,
        `const { join } = require("node:path");`,
        `if (process.argv[2] === "--version") process.stdout.write("2.9.3\\n");`,
        `else {`,
        `  const out = process.argv[process.argv.indexOf("-o") + 1];`,
        `  mkdirSync(out, { recursive: true });`,
        `  writeFileSync(join(out, "apktool.yml"), ${JSON.stringify(YML)});`,
        `  writeFileSync(join(out, "AndroidManifest.xml"), ${JSON.stringify(MANIFEST)});`,
        `  process.stdout.write("x".repeat(${String(DECODE_OUTPUT_BYTES)}));`,
        `}`,
        "",
      ].join("\n"),
      { mode: 0o700, flag: "wx" },
    );
    const apk = join(root, "probe.apk");
    await writeFile(apk, "apk-bytes");
    const provider = new ApktoolProvider({
      environment: { REA_APKTOOL_COMMAND: command },
    });
    const decode = () =>
      provider.execute({
        operation: "decode_android_resources",
        input: { path: apk, include_strings: false },
      });
    try {
      const lowered = await runWithAnalysisOperationSnapshot(
        { revision: 1, overrides: { "producer.output_bytes": 1024 } },
        decode,
      );
      if (lowered.ok) throw new Error("Expected the session output refusal");
      expect(projectAnalysisError(lowered.error).details?.limit).toMatchObject({
        setting: "producer.output_bytes",
        parameter: "producer_limits.output_bytes",
        effective_value: 1024,
        source: "runtime",
        maximum: MAX_APKTOOL_DECODE_OUTPUT_BYTES,
      });
      const raised = await runWithAnalysisOperationSnapshot(
        {
          revision: 1,
          overrides: { "producer.output_bytes": DECODE_OUTPUT_BYTES },
        },
        decode,
      );
      if (!raised.ok) throw raised.error;
      expect(raised.value.result).toMatchObject({
        metadata: { package_name: "com.rea.apktool.probe" },
      });
    } finally {
      await provider.close();
    }
  },
);
