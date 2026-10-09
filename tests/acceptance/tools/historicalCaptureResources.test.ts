import { execFile } from "node:child_process";
import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { WEB_NETWORK_CAPTURE_LIMITS } from "../../../src/domain/webNetworkCapture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
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

it("reports real HAR heap exhaustion through CLI and MCP and preserves server usability", async () => {
  const root = await createTestTempDirectory("rea-har-capacity-");
  const path = join(root, "caller-marked.har");
  const dense = capture(34_098);
  expect(Buffer.byteLength(dense)).toBeLessThan(
    WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
  );
  await writeFile(path, dense);
  const { call, client } = await connectLocalToolsMcp();
  const response = await call("inspect_web_network_capture", {
    capture_path: path,
    format: "har",
    sensitive_values: ["caller-marked"],
  });
  expect(response.isError).toBe(true);
  expect(response.structuredContent).toMatchObject({
    error: {
      code: "resource_constraint",
      retryable: false,
      message: expect.stringContaining("fixed V8 heap"),
      remediation: {
        action: expect.stringContaining(
          "smaller capture exported by its producer",
        ),
      },
      details: {
        resource: "memory",
        reported_limits: {
          old_generation_heap_mib: 192,
          observed_exit_code: process.platform === "win32" ? 134 : null,
          observed_signal: process.platform === "win32" ? null : "SIGABRT",
        },
        captured_output: {
          stderr: expect.stringContaining("heap out of memory"),
          truncated: false,
        },
      },
    },
  });
  expect(JSON.stringify(response)).not.toContain("caller-marked");
  expect(JSON.stringify(response)).not.toContain("rea doctor");
  await expect(
    execute(process.execPath, [
      cli,
      "inspect-web-network-capture",
      path,
      "har",
      "--json",
    ]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining('"code": "resource_constraint"'),
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
  await truncate(path, WEB_NETWORK_CAPTURE_LIMITS.inputBytes + 1);
  const oversized = await call("inspect_web_network_capture", {
    capture_path: path,
    format: "har",
  });
  expect(oversized.structuredContent).toMatchObject({
    error: { code: "invalid_request" },
  });
}, 60_000);
