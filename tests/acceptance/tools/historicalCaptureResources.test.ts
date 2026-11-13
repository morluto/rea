import {
  captureDecoderHeapRecovery,
  captureDecoderHeapContinuingRecovery,
  CAPTURE_DECODER_OLD_GENERATION_SETTING,
  DEFAULT_CAPTURE_DECODER_HEAP,
} from "../../../src/config/captureDecoderHeap.js";
import { execFile } from "node:child_process";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { javaScriptWorkerMemoryLimitBytes } from "../../../src/process/JavaScriptWorkerMemoryLimit.js";
import { WEB_NETWORK_CAPTURE_LIMITS } from "../../../src/domain/webNetworkCapture.js";
import { CAPTURE_RUNTIME_SUPPORTED } from "../../fixtures/captureDecoderLimits.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const entry = JSON.stringify({
  startedDateTime: "2026-01-01T00:00:00.000Z",
  time: 1,
  request: {
    method: "GET",
    url: "https://example.invalid/data",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [],
    queryString: [],
    headersSize: -1,
    bodySize: 0,
  },
  response: {
    status: 200,
    statusText: "OK",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [],
    content: { size: 512, mimeType: "text/plain", text: "x".repeat(512) },
    redirectURL: "",
    headersSize: -1,
    bodySize: 512,
  },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
});
const capture = (count: number) =>
  `{"log":{"version":"1.2","creator":{"name":"synthetic","version":"1"},"entries":[${Array<string>(count).fill(entry).join(",")}]}}`;

// Node.js enforces the decoder's V8 heap flags. Bun ignores them; on Windows
// the decoder's Job Object commit limit is the enforced bound instead, and
// Bun elsewhere has no bound this capture can reach.
const testHeap = { oldGenerationMiB: 64, source: "setting" } as const;
const jobLimit = javaScriptWorkerMemoryLimitBytes(testHeap.oldGenerationMiB);
it.skipIf(
  !CAPTURE_RUNTIME_SUPPORTED ||
    (process.versions.bun !== undefined && jobLimit === null),
)(
  "reports real HAR memory exhaustion through CLI and MCP and preserves server usability",
  async () => {
    const root = await createTestTempDirectory("rea-har-capacity-");
    const path = join(root, "caller-marked.har");
    const dense = capture(34_098);
    expect(Buffer.byteLength(dense)).toBeLessThan(
      WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
    );
    await writeFile(path, dense);
    const { call, client } = await connectLocalToolsMcp({
      [CAPTURE_DECODER_OLD_GENERATION_SETTING]: String(
        testHeap.oldGenerationMiB,
      ),
    });
    const response = await call("inspect_web_network_capture", {
      capture_path: path,
      format: "har",
      sensitive_values: ["caller-marked"],
    });
    expect(response.isError).toBe(true);
    const exhausted = parseMcpToolError(response);
    expect(exhausted).toMatchObject({
      error: {
        code: "resource_constraint",
        retryable: false,
        details: {
          resource: "memory",
          limit: {
            setting: "capture.decoder_old_generation_mib",
            effective_value: testHeap.oldGenerationMiB,
            source: testHeap.source,
            update_mode: "runtime",
            pending_restart: false,
          },
          reported_limits:
            jobLimit === null
              ? {
                  old_generation_heap_mib: testHeap.oldGenerationMiB,
                  observed_exit_code: process.platform === "win32" ? 134 : null,
                  observed_signal:
                    process.platform === "win32" ? null : "SIGABRT",
                }
              : { process_memory_limit_bytes: jobLimit, observed_signal: null },
          captured_output:
            jobLimit === null
              ? {
                  stderr: expect.stringContaining("heap out of memory"),
                  truncated: false,
                }
              : { truncated: false },
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("caller-marked");
    expect(JSON.stringify(response)).not.toContain("rea doctor");
    const remediation = String(exhausted.error.remediation?.action ?? "");
    expect(remediation).toContain(
      captureDecoderHeapContinuingRecovery(testHeap),
    );
    const failed: unknown = await execute(
      process.execPath,
      [
        cli,
        "inspect-web-network-capture",
        path,
        "har",
        "--json",
        "--sensitive-value",
        "caller-marked",
      ],
      {
        env: {
          ...process.env,
          [CAPTURE_DECODER_OLD_GENERATION_SETTING]: String(
            testHeap.oldGenerationMiB,
          ),
        },
      },
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failed).toMatchObject({ code: 1 });
    const stdout =
      typeof failed === "object" && failed !== null && "stdout" in failed
        ? String(failed.stdout)
        : "";
    expect(JSON.parse(stdout)).toMatchObject({
      code: "resource_constraint",
      details: {
        limit: {
          setting: "capture.decoder_old_generation_mib",
          effective_value: testHeap.oldGenerationMiB,
          source: testHeap.source,
          update_mode: "runtime",
          pending_restart: false,
        },
      },
      remediation: {
        action: expect.stringContaining(captureDecoderHeapRecovery(testHeap)),
      },
    });
    const small = join(root, "small.har");
    await writeFile(small, capture(2));
    await client.ping();
    const control = await call("inspect_web_network_capture", {
      capture_path: small,
      format: "har",
    });
    expect(control.isError, JSON.stringify(control)).not.toBe(true);
    expect(control.structuredContent).toMatchObject({
      normalized_result: { total_records: 2 },
    });
    const controlText = JSON.stringify(control.structuredContent);
    expect(controlText).toContain(captureDecoderHeapRecovery(testHeap));
    const defaultServer = await connectLocalToolsMcp();
    const defaultControl = await defaultServer.call(
      "inspect_web_network_capture",
      { capture_path: small, format: "har" },
    );
    expect(defaultControl.isError, JSON.stringify(defaultControl)).not.toBe(
      true,
    );
    expect(JSON.stringify(defaultControl.structuredContent)).toContain(
      captureDecoderHeapRecovery(DEFAULT_CAPTURE_DECODER_HEAP),
    );
    await truncate(path, WEB_NETWORK_CAPTURE_LIMITS.inputBytes + 1);
    const oversized = await call("inspect_web_network_capture", {
      capture_path: path,
      format: "har",
    });
    expect(parseMcpToolError(oversized)).toMatchObject({
      error: { code: "invalid_request" },
    });
  },
  60_000,
);
