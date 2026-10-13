import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webNetworkCaptureSchema } from "../../../src/domain/webNetworkCapture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
const entrypoint = fileURLToPath(
  new URL("../../../scripts/rea.mjs", import.meta.url),
);
const cli = async (
  path: string,
  format: string,
  extra: readonly string[] = [],
) => {
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        entrypoint,
        "inspect-web-network-capture",
        path,
        format,
        "--json",
        ...extra,
      ],
      { env: { ...process.env, REA_MITMDUMP_COMMAND: "" }, timeout: 40_000 },
    );
    return { ok: true, stdout: result.stdout };
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return { ok: false, stdout: cause.stdout };
    throw cause;
  }
};
import { historicalHar } from "../../fixtures/historicalHar.js";

it("excludes declared binary lengths through CLI, MCP and retained capture pages", async () => {
  const root = await createTestTempDirectory("rea-har-byte-length-");
  const path = join(root, "capture.har");
  const fixture = historicalHar();
  const entry = fixture.log.entries[0];
  if (entry === undefined) throw new Error("fixture missing");
  const body = Buffer.alloc(12_345, "A");
  const content = body.toString("base64");
  const digest = createHash("sha256").update(body).digest("hex");
  await writeFile(
    path,
    JSON.stringify({
      log: {
        ...fixture.log,
        entries: [
          {
            ...entry,
            response: {
              ...entry.response,
              content: {
                size: 99,
                mimeType: "text/plain",
                encoding: "base64",
                text: content,
              },
            },
          },
        ],
      },
    }),
  );
  const { call } = await connectLocalToolsMcp();
  const args = { capture_path: path, format: "har" };
  const control = await call("inspect_web_network_capture", args);
  expect(control.isError).not.toBe(true);
  const retained = parseEvidence(control.structuredContent);
  const controlCapture = webNetworkCaptureSchema.parse(
    retained.normalized_result,
  );
  expect(controlCapture.records[0]?.binary_fields[0]).toMatchObject({
    state: "retained",
    bytes: body.length,
    content_base64: content,
    sha256: digest,
  });
  for (const literal of ["12345", "2345"]) {
    // Only the derived count matches, so this cannot pass via another exclusion.
    expect(content).not.toContain(literal);
    expect(digest).not.toContain(literal);
    const fromCli = await cli(path, "har", ["--sensitive-value", literal]);
    expect(fromCli.ok, fromCli.stdout).toBe(true);
    const evidence = parseEvidence(JSON.parse(fromCli.stdout));
    const response = await call("inspect_web_network_capture", {
      ...args,
      sensitive_values: [literal],
    });
    expect(response.isError).not.toBe(true);
    const fromMcp = parseEvidence(response.structuredContent);
    expect(fromMcp.normalized_result).toEqual(evidence.normalized_result);
    const capture = webNetworkCaptureSchema.parse(evidence.normalized_result);
    expect(capture.records[0]?.reported).toMatchObject({
      response: { content: { size: 99, text: null } },
    });
    expect(capture.records[0]?.binary_fields[0]).toEqual({
      pointer: "/response/content/text",
      representation: "har-base64-content",
      state: "redacted",
      bytes: null,
      content_base64: null,
      sha256: null,
    });
    for (const detail of ["preview", "complete"]) {
      const page = await call("inspect_analysis_view", {
        source: { kind: "retained-evidence", evidence_id: fromMcp.evidence_id },
        view: { kind: "capture", detail },
      });
      expect(page.isError).not.toBe(true);
      const result = parseEvidence(page.structuredContent);
      expect(result.normalized_result).toMatchObject({
        items: [{ binary_fields: [{ state: "redacted", bytes: null }] }],
      });
    }
  }
}, 60_000);

it("reads actual upstream HAR packages in an owned process and retains selected producer order", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-history-har-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const fixture = historicalHar();
  const first = fixture.log.entries[0];
  if (first === undefined) throw new Error("fixture missing");
  fixture.log.entries.push(structuredClone(first));
  const text = JSON.stringify(fixture);
  const path = join(root, "capture.har");
  await writeFile(path, text);
  const called = await cli(path, "har", ["--record", "1", "--record", "0"]);
  expect(called.ok, called.stdout).toBe(true);
  const result = { value: parseEvidence(JSON.parse(called.stdout)) };
  expect(result.value.subject?.digest).toMatchObject({
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  expect(result.value.normalized_result).toMatchObject({
    total_records: 2,
    records: [{ ordinal: 1 }, { ordinal: 0 }],
    runtime_attribution: "unknown",
  });
});

it("keeps malformed JSON separate from absent external mitmproxy capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-history-errors-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "capture.har");
  await writeFile(path, "{malformed-private-json");
  const malformed = await cli(path, "har");
  expect(malformed.ok).toBe(false);
  expect(JSON.parse(malformed.stdout)).toMatchObject({
    category: "invalid_input",
  });
  expect(malformed.stdout).not.toContain("malformed-private-json");
  const missing = await cli(path, "mitmproxy");
  expect(missing.ok).toBe(false);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    category: "unsupported_provider",
    message: expect.stringContaining("REA_MITMDUMP_COMMAND"),
  });
});

it("reports the actual HAR decoder nesting constraint as a typed selected-input issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-history-depth-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let extension: unknown = "leaf";
  for (let depth = 0; depth < 66; depth++) extension = { child: extension };
  const path = join(root, "deep.har");
  await writeFile(
    path,
    JSON.stringify({ ...historicalHar(), _extension: extension }),
  );
  const result = await cli(path, "har");
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.stdout)).toMatchObject({
    category: "invalid_input",
    details: {
      issues: [
        {
          path: ["capture_path", expect.stringMatching(/^\/_extension\/child/)],
          reason: "out_of_range",
          expected: { maximum_capture_nesting: 64 },
        },
      ],
    },
  });
});
