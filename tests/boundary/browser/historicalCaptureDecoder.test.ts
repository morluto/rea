import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import {
  access,
  chmod,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { HistoricalCaptureDecoder } from "../../../src/browser/history/HistoricalCaptureDecoder.js";
import { HAR_CAPTURE_PROVIDER_IDENTITY } from "../../../src/browser/history/CaptureRelease.js";
import {
  inspectWebNetworkCaptureInputSchema,
  WEB_NETWORK_CAPTURE_LIMITS,
} from "../../../src/domain/webNetworkCapture.js";
import { historicalHar } from "../../fixtures/historicalHar.js";
import { decodeHarCapture } from "../../../src/browser/history/HarCapture.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

it.each([true, false])(
  "binds decoder replies to the complete selected provider identity (matching name: %s)",
  async (matching) => {
    const root = await mkdtemp(join(tmpdir(), "rea-capture-identity-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "capture.har");
    const text = JSON.stringify(historicalHar());
    await writeFile(path, text);
    const decoder = new HistoricalCaptureDecoder(
      [
        {
          format: "har",
          identity: HAR_CAPTURE_PROVIDER_IDENTITY,
          command: async (_, runtimePath) => {
            const value = decodeHarCapture(text, []);
            if (!matching) value.decoder.name = "different adapter";
            await writeFile(
              join(runtimePath, "reply.json"),
              JSON.stringify({ ok: true, value }),
            );
            return { command: process.execPath, arguments: ["-e", ""] };
          },
        },
      ],
      process.env,
    );
    const result = await decoder.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: path,
        format: "har",
      }),
    );
    expect(result.ok).toBe(matching);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
    else expect(result.value.decoder).toEqual(HAR_CAPTURE_PROVIDER_IDENTITY);
  },
);

it("classifies an oversized selected capture before creating an owned decoder", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-historical-limit-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "input.har");
  await writeFile(path, "");
  await truncate(path, WEB_NETWORK_CAPTURE_LIMITS.inputBytes + 1);
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "har",
        identity: HAR_CAPTURE_PROVIDER_IDENTITY,
        command: async () => {
          throw new Error("Oversized input must not launch decoding");
        },
      },
    ],
    process.env,
  );
  const result = await decoder.inspect(
    inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
    }),
  );
  if (result.ok) throw new Error("Oversized input must fail");
  expect(result.error._tag).toBe("AnalysisInputError");
  expect(projectAnalysisError(result.error)).toMatchObject({
    category: "invalid_input",
    details: {
      issues: [
        {
          path: ["capture_path"],
          reason: "out_of_range",
          expected: {
            maximum_capture_bytes: WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
          },
        },
      ],
    },
  });
});

it("does not misclassify decoder filesystem failures as missing selected input", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-historical-command-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "input.har");
  await writeFile(path, JSON.stringify(historicalHar()));
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "har",
        identity: HAR_CAPTURE_PROVIDER_IDENTITY,
        command: async () => {
          throw Object.assign(
            new Error("Configured decoder command file missing"),
            { code: "ENOENT" },
          );
        },
      },
    ],
    process.env,
  );
  const result = await decoder.inspect(
    inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
    }),
  );
  if (result.ok) throw new Error("Failed decoder command must fail");
  expect(result.error._tag).toBe("ProviderAdapterError");
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      diagnostics: {
        phase: "decoder",
        reason: "Configured decoder command file missing",
      },
    },
  });
});

it.each(["missing-capture", "missing-reply", "failed-command"])(
  "redacts declared paths and diagnostics while preserving the %s failure",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "rea-historical-sensitive-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "explicit-private-value.har");
    if (mode !== "missing-capture")
      await writeFile(path, JSON.stringify(historicalHar()));
    const decoder = new HistoricalCaptureDecoder(
      [
        {
          format: "har",
          identity: HAR_CAPTURE_PROVIDER_IDENTITY,
          command: async () => ({
            command: process.execPath,
            arguments: [
              "-e",
              mode === "failed-command"
                ? 'process.stderr.write("explicit-private-value ordinary diagnostic"); process.exit(2)'
                : "process.exit(0)",
            ],
          }),
        },
      ],
      process.env,
    );
    const result = await decoder.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: path,
        format: "har",
        sensitive_values: ["explicit-private-value", "REDACTED"],
      }),
    );
    if (result.ok) throw new Error("Failure required");
    const projected = projectAnalysisError(result.error);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("explicit-private-value");
    expect(serialized).not.toContain("REDACTED");
    expect(result.error._tag).toBe(
      mode === "missing-capture"
        ? "AnalysisInputError"
        : mode === "missing-reply"
          ? "AnalysisOutputError"
          : "ProviderAdapterError",
    );
    if (mode === "missing-capture") expect(serialized).toContain("ENOENT");
    if (mode === "failed-command")
      expect(serialized).toContain('"exit_code":2');
  },
);

it("reports an absent owned reply as output failure and removes its private snapshot root", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-historical-decoder-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "input.har");
  await writeFile(path, JSON.stringify(historicalHar()));
  let privatePath: string | undefined;
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "har",
        identity: HAR_CAPTURE_PROVIDER_IDENTITY,
        command: async (_, runtimePath) => {
          privatePath = runtimePath;
          return {
            command: process.execPath,
            arguments: ["-e", "process.exit(0)"],
          };
        },
      },
    ],
    process.env,
  );
  const result = await decoder.inspect(
    inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
    }),
  );
  if (result.ok) throw new Error("Owned reply is required");
  expect(result.error._tag).toBe("AnalysisOutputError");
  expect(result.error.message).toContain("ENOENT");
  if (privatePath === undefined)
    throw new Error("Private root was not acquired");
  await expect(access(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("cancels after snapshot acquisition before launch and removes private input declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-historical-cancel-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "input.har");
  await writeFile(path, JSON.stringify(historicalHar()));
  let privatePath: string | undefined;
  const controller = new AbortController();
  const decoder = new HistoricalCaptureDecoder(
    [
      {
        format: "har",
        identity: HAR_CAPTURE_PROVIDER_IDENTITY,
        command: async (_, runtimePath) => {
          privatePath = runtimePath;
          controller.abort();
          return {
            command: process.execPath,
            arguments: ["-e", "process.exit(3)"],
          };
        },
      },
    ],
    process.env,
  );
  const result = await decoder.inspect(
    inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
      sensitive_values: ["explicit-private-declaration"],
    }),
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Cancelled acquisition must fail");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  if (privatePath === undefined)
    throw new Error("Private root was not acquired");
  await expect(access(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([
  { reason: "input-limit", tag: "AnalysisInputError" },
  { reason: "resource-limit", tag: "ProviderAdapterError" },
  { reason: "decoder", tag: "ProviderAdapterError" },
  { reason: "limit", tag: "AnalysisOutputError" },
])(
  "preserves $reason decoder failures through the public error boundary",
  async ({ reason, tag }) => {
    const root = await mkdtemp(join(tmpdir(), "rea-historical-reply-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "input.har");
    await writeFile(path, JSON.stringify(historicalHar()));
    let privatePath: string | undefined;
    const decoder = new HistoricalCaptureDecoder(
      [
        {
          format: "har",
          identity: HAR_CAPTURE_PROVIDER_IDENTITY,
          command: async (_, runtimePath) => {
            privatePath = runtimePath;
            await writeFile(
              join(runtimePath, "reply.json"),
              JSON.stringify({
                ok: false,
                reason,
                message: "Specific decoder constraint",
                pointer: "/extension/child",
              }),
            );
            return {
              command: process.execPath,
              arguments: ["-e", "process.exit(0)"],
            };
          },
        },
      ],
      process.env,
    );
    const result = await decoder.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: path,
        format: "har",
      }),
    );
    if (result.ok) throw new Error("Failure required");
    expect(result.error._tag).toBe(tag);
    const projected = projectAnalysisError(result.error);
    if (reason === "input-limit") {
      expect(projected).toMatchObject({
        category: "invalid_input",
        details: {
          issues: [
            {
              path: ["capture_path", "/extension/child"],
              reason: "out_of_range",
              expected: {
                maximum_capture_nesting: WEB_NETWORK_CAPTURE_LIMITS.depth,
              },
            },
          ],
        },
      });
    } else if (tag === "ProviderAdapterError") {
      expect(projected).toMatchObject({
        details: {
          diagnostics: {
            phase: "decoder",
            reason: "Specific decoder constraint",
            failure_kind: reason,
            pointer: "/extension/child",
          },
        },
      });
    }
    if (privatePath === undefined)
      throw new Error("Private root was not acquired");
    await expect(access(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports a real filesystem permission denial separately from missing capture input",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-historical-denied-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "unreadable.har");
    await writeFile(path, JSON.stringify(historicalHar()), { mode: 0o000 });
    const decoder = new HistoricalCaptureDecoder(
      [
        {
          format: "har",
          identity: HAR_CAPTURE_PROVIDER_IDENTITY,
          command: async () => {
            throw new Error("Permission-denied input must not launch decoding");
          },
        },
      ],
      process.env,
    );
    const result = await decoder.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: path,
        format: "har",
      }),
    );
    await chmod(path, 0o600);
    if (result.ok) throw new Error("Permission denial required");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "access_denied",
      category: "unavailable",
      retryable: false,
      details: {
        operation: "inspect_web_network_capture",
        path,
        system_code: "EACCES",
      },
    });
    expect(projectAnalysisError(result.error).remediation.action).toContain(
      "read access",
    );
  },
);

it.each(["format", "process"])(
  "preserves the structured %s failure when runtime cleanup fails",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "rea-historical-cleanup-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "capture-private.har");
    await writeFile(path, JSON.stringify(historicalHar()));
    const decoder = new HistoricalCaptureDecoder(
      [
        {
          format: "har",
          identity: HAR_CAPTURE_PROVIDER_IDENTITY,
          command: async (_, runtimePath) => {
            if (kind === "format")
              await writeFile(
                join(runtimePath, "reply.json"),
                JSON.stringify({
                  ok: false,
                  reason: "format",
                  message: "Malformed retained record",
                  pointer: "/metadata/capture-private",
                }),
              );
            return {
              command: process.execPath,
              arguments: [
                "-e",
                kind === "format"
                  ? "process.exit(0)"
                  : 'process.stderr.write("Specific provider fault"); process.exit(3)',
              ],
            };
          },
        },
      ],
      process.env,
      async () => {
        const runtime = await PrivateRuntimeRoot.create({
          prefix: "rea-cleanup-proof-",
        });
        onTestFinished(() => runtime.close());
        return {
          path: runtime.path,
          close: async () => {
            throw new Error("Deliberate cleanup denial");
          },
        };
      },
    );
    const result = await decoder.inspect(
      inspectWebNetworkCaptureInputSchema.parse({
        capture_path: path,
        format: "har",
        sensitive_values: ["capture-private"],
      }),
    );
    if (result.ok) throw new Error("Cleanup failure required");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          previous_error:
            kind === "format"
              ? {
                  category: "invalid_input",
                  details: {
                    issues: [
                      {
                        path: ["capture_path", "/metadata"],
                        reason: "invalid_format",
                        message: "Malformed retained record",
                      },
                    ],
                  },
                }
              : {
                  code: "execution_failure",
                  details: {
                    diagnostics: {
                      phase: "decoder",
                      exit_code: 3,
                      stderr: "Specific provider fault",
                    },
                  },
                },
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("capture-private");
  },
);
