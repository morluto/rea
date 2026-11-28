import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webNetworkCaptureSchema } from "../../../src/domain/webNetworkCapture.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
/** Run the public CLI with complete Evidence, whatever its exit status. */
const inspectCapture = async (
  cli: TestCli,
  path: string,
  format: string,
  extra: readonly string[] = [],
) => {
  const result = await cli.run({
    arguments: [
      "inspect-web-network-capture",
      path,
      format,
      "--json",
      ...extra,
    ],
    environment: { REA_MITMDUMP_COMMAND: "" },
  });
  return { ok: result.exitCode === 0, stdout: result.stdout };
};

/** The file's stdio MCP session; each test passes its own capture path. */
const sharedMcp = async (cli: TestCli) => {
  const call = await cli.sharedMcpCall?.();
  if (call === undefined) throw new Error("Expected a stdio MCP session");
  return { call };
};
import {
  historicalHar,
  harWithContainerLookalikes,
} from "../../fixtures/historicalHar.js";

cliTest(
  "preserves opaque HAR container fields through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-har-container-fields-");
    const path = join(root, "capture.har");
    const fixture = harWithContainerLookalikes();
    const original = JSON.stringify(fixture);
    await writeFile(path, original);
    const { call } = await sharedMcp(cli);
    for (const marked of [false, true]) {
      const sensitive = marked ? ["ordinary-root-evidence"] : [];
      const fromCli = await inspectCapture(
        cli,
        path,
        "har",
        marked ? ["--sensitive-value", sensitive[0]!] : [],
      );
      expect(fromCli.ok, fromCli.stdout).toBe(true);
      const cliEvidence = parseEvidence(JSON.parse(fromCli.stdout));
      const response = await call("inspect_web_network_capture", {
        capture_path: path,
        format: "har",
        sensitive_values: sensitive,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = parseEvidence(response.structuredContent);
      expect(evidence.evidence_id).toBe(cliEvidence.evidence_id);
      expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
      const capture = webNetworkCaptureSchema.parse(evidence.normalized_result);
      expect(capture.container.reported).toMatchObject({
        request: {
          url: fixture.request.url,
          headers: [{ value: marked ? null : "ordinary-root-evidence" }],
          cookies: [{ value: marked ? null : "ordinary-root-evidence" }],
        },
        response: {
          redirectURL: fixture.response.redirectURL,
          headers: [{ value: marked ? null : "ordinary-root-evidence" }],
          content: { text: marked ? null : "ordinary-root-evidence" },
        },
      });
      expect(capture.records[0]).toMatchObject({
        reported: {
          request: {
            url: "https://example.test/opaque",
            headers: [{ value: null }],
            cookies: [{ value: null }],
          },
          response: {
            redirectURL: "https://example.test/redirect",
            headers: [{ value: null }],
          },
        },
        binary_fields: [
          {
            pointer: "/response/content/text",
            content_base64: "QUJD",
            bytes: 3,
          },
        ],
      });
    }
    expect(await readFile(path, "utf8")).toBe(original);
  },
);

cliTest(
  "excludes normalized HAR numbers through CLI and MCP",
  async ({ cli }) => {
    const encoded = "1e3";
    const literal = "1000";
    const root = await createTestTempDirectory("rea-har-normalized-number-");
    const path = join(root, "capture.har");
    const original = JSON.stringify(historicalHar())
      .replace('"log":{', `"_number":${encoded},"log":{`)
      .replace('"cache":{}', `"cache":{},"_number":${encoded}`);
    await writeFile(path, original);
    const { call } = await sharedMcp(cli);
    for (const marked of [false, true]) {
      const fromCli = await inspectCapture(
        cli,
        path,
        "har",
        marked ? ["--sensitive-value", literal] : [],
      );
      expect(fromCli.ok, fromCli.stdout).toBe(true);
      const evidence = parseEvidence(JSON.parse(fromCli.stdout));
      const response = await call("inspect_web_network_capture", {
        capture_path: path,
        format: "har",
        ...(marked ? { sensitive_values: [literal] } : {}),
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcp = parseEvidence(response.structuredContent);
      expect(mcp.evidence_id).toBe(evidence.evidence_id);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
      const capture = webNetworkCaptureSchema.parse(evidence.normalized_result);
      for (const projection of [capture.container, ...capture.records]) {
        expect(projection.reported).toMatchObject({
          _number: marked ? null : Number(encoded),
        });
        const numbers = projection.numeric_literals.filter(
          (number) => number.pointer === "/_number",
        );
        expect(numbers).toEqual(
          marked
            ? []
            : [
                {
                  pointer: "/_number",
                  producer_type: "json-number",
                  literal: encoded,
                },
              ],
        );
        if (marked)
          expect(projection.redactions).toContainEqual({
            pointer: "/_number",
            reason: "explicit-sensitive-value",
          });
      }
    }
    expect(await readFile(path, "utf8")).toBe(original);
  },
);

cliTest(
  "retains Playwright IPv6 spelling through public CLI and MCP workflows",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-har-ipv6-");
    const path = join(root, "capture.har");
    const original = JSON.stringify(historicalHar())
      .replace(
        '"name":"rea-source-owned-fixture","version":"1"',
        '"name":"Playwright","version":"1.58.2"',
      )
      .replace(
        '"startedDateTime":',
        '"serverIPAddress":"[2001:db8::1]","startedDateTime":',
      );
    await writeFile(path, original);
    const { call } = await sharedMcp(cli);
    const fromCli = await inspectCapture(cli, path, "har");
    expect(fromCli.ok, fromCli.stdout).toBe(true);
    const cliEvidence = parseEvidence(JSON.parse(fromCli.stdout));
    const response = await call("inspect_web_network_capture", {
      capture_path: path,
      format: "har",
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const mcpEvidence = parseEvidence(response.structuredContent);
    expect(mcpEvidence.evidence_id).toBe(cliEvidence.evidence_id);
    expect(mcpEvidence.normalized_result).toEqual(
      cliEvidence.normalized_result,
    );
    const capture = webNetworkCaptureSchema.parse(
      cliEvidence.normalized_result,
    );
    expect(capture.records[0]).toMatchObject({
      reported: {
        serverIPAddress: "[2001:db8::1]",
      },
    });
    expect(
      capture.records[0]?.limitations.some((limitation) =>
        limitation.includes("bracketed IPv6 serverIPAddress"),
      ),
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
  },
);

cliTest(
  "excludes declared binary lengths through CLI, MCP and retained capture pages",
  async ({ cli }) => {
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
    const { call } = await sharedMcp(cli);
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
      const fromCli = await inspectCapture(cli, path, "har", [
        "--sensitive-value",
        literal,
      ]);
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
          source: {
            kind: "retained-evidence",
            evidence_id: fromMcp.evidence_id,
          },
          view: { kind: "capture", detail },
        });
        expect(page.isError).not.toBe(true);
        const result = parseEvidence(page.structuredContent);
        expect(result.normalized_result).toMatchObject({
          items: [{ binary_fields: [{ state: "redacted", bytes: null }] }],
        });
      }
    }
  },
);

cliTest(
  "reads actual upstream HAR packages in an owned process and retains selected producer order",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-history-har-");
    const fixture = historicalHar();
    const first = fixture.log.entries[0];
    if (first === undefined) throw new Error("fixture missing");
    const second = structuredClone(first);
    second.request.url = "https://example.test/b";
    fixture.log.entries.push(second);
    const text = JSON.stringify(fixture);
    const path = join(root, "capture.har");
    await writeFile(path, text);
    const called = await inspectCapture(cli, path, "har", [
      "--record",
      "1",
      "--record",
      "0",
    ]);
    expect(called.ok, called.stdout).toBe(true);
    const result = { value: parseEvidence(JSON.parse(called.stdout)) };
    expect(result.value.subject?.identity).toMatchObject({
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    expect(result.value.normalized_result).toMatchObject({
      total_records: 2,
      records: [
        { ordinal: 1, reported: { request: { url: second.request.url } } },
        { ordinal: 0, reported: { request: { url: first.request.url } } },
      ],
      runtime_attribution: "unknown",
    });
  },
);

cliTest(
  "keeps malformed JSON, unsupported HAR versions and missing external capability distinct",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-history-errors-");
    const path = join(root, "capture.har");
    await writeFile(path, "{malformed-private-json");
    const malformed = await inspectCapture(cli, path, "har");
    expect(malformed.ok).toBe(false);
    expect(JSON.parse(malformed.stdout)).toMatchObject({
      category: "invalid_input",
    });
    expect(malformed.stdout).not.toContain("malformed-private-json");
    const fixture = historicalHar();
    fixture.log.version = "1.1";
    await writeFile(path, JSON.stringify(fixture));
    const unsupported = await inspectCapture(cli, path, "har");
    expect(unsupported.ok, unsupported.stdout).toBe(false);
    const refusal = {
      code: "capability_unavailable",
      category: "unsupported_provider",
      message: expect.stringContaining("HAR 1.2"),
      remediation: { action: expect.stringContaining("capture format") },
      details: { diagnostics: { pointer: "/log/version" } },
    };
    expect(JSON.parse(unsupported.stdout)).toMatchObject(refusal);
    const { call } = await sharedMcp(cli);
    const request = { capture_path: path, format: "har" };
    const unsupportedMcp = await call("inspect_web_network_capture", request);
    expect(parseMcpToolError(unsupportedMcp).error).toMatchObject(refusal);
    const marked = await call("inspect_web_network_capture", {
      ...request,
      sensitive_values: ["HAR 1.2", "/log/version"],
    });
    expect(parseMcpToolError(marked).error.code).toBe(refusal.code);
    expect(JSON.stringify(marked)).not.toMatch(/HAR 1\.2|\/log\/version/u);

    const supportedPath = join(root, "supported.har");
    await writeFile(supportedPath, JSON.stringify(historicalHar()));
    const recovered = await call("inspect_web_network_capture", {
      ...request,
      capture_path: supportedPath,
    });
    expect(recovered.isError).not.toBe(true);
    expect(
      parseEvidence(recovered.structuredContent).normalized_result,
    ).toMatchObject({
      artifact: { path: supportedPath },
      total_records: 1,
    });
    const missing = await inspectCapture(cli, path, "mitmproxy");
    expect(missing.ok).toBe(false);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      category: "unsupported_provider",
      message: expect.stringContaining("REA_MITMDUMP_COMMAND"),
    });
  },
);

cliTest(
  "reports the actual HAR decoder nesting constraint as a typed selected-input issue",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-history-depth-");
    let extension: unknown = "leaf";
    for (let depth = 0; depth < 66; depth++) extension = { child: extension };
    const path = join(root, "deep.har");
    await writeFile(
      path,
      JSON.stringify({ ...historicalHar(), _extension: extension }),
    );
    const result = await inspectCapture(cli, path, "har");
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      category: "invalid_input",
      details: {
        issues: [
          {
            path: [
              "capturePath",
              expect.stringMatching(/^\/_extension\/child/),
            ],
            reason: "out_of_range",
            expected: { maximum_capture_nesting: 64 },
          },
        ],
      },
    });
  },
);

cliTest(
  "counts credential-named HAR members by pointer, excluding values the decoder removed",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-har-credential-names-");
    const path = join(root, "capture.har");
    const fixture = historicalHar();
    const entry = fixture.log.entries[0]!;
    await writeFile(
      path,
      JSON.stringify({
        log: {
          ...fixture.log,
          entries: [
            {
              ...entry,
              request: {
                ...entry.request,
                method: "POST",
                url: "https://example.test/login?api_key=demo-key",
                headers: [
                  { name: "Authorization", value: "Bearer demo-bearer" },
                  { name: "X-Demo-Token", value: "demo-token" },
                  { name: "Accept", value: "application/json" },
                ],
                queryString: [{ name: "api_key", value: "demo-key" }],
                postData: {
                  mimeType: "application/json",
                  text: '{"user":"demo","password":"demo-pass"}',
                },
              },
              response: {
                ...entry.response,
                content: {
                  size: 32,
                  mimeType: "application/json",
                  text: '{"session_token":"demo-session"}',
                },
              },
            },
          ],
        },
      }),
    );
    const { call } = await sharedMcp(cli);
    for (const sensitive of [[], ["demo-token", "demo-pass"]]) {
      const fromCli = await inspectCapture(
        cli,
        path,
        "har",
        sensitive.flatMap((value) => ["--sensitive-value", value]),
      );
      expect(fromCli.ok, fromCli.stdout).toBe(true);
      const cliEvidence = parseEvidence(JSON.parse(fromCli.stdout));
      const response = await call("inspect_web_network_capture", {
        capture_path: path,
        format: "har",
        sensitive_values: sensitive,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const evidence = parseEvidence(response.structuredContent);
      expect(evidence.limitations).toEqual(cliEvidence.limitations);
      const [limitation, ...others] = evidence.limitations.filter((text) =>
        text.includes("look like credentials"),
      );
      expect(others).toEqual([]);
      const expected =
        sensitive.length === 0
          ? [
              "record 0 request header X-Demo-Token",
              "record 0 request query api_key",
              "record 0 request /password",
              "record 0 response /session_token",
            ]
          : [
              "record 0 request query api_key",
              "record 0 response /session_token",
            ];
      expect(limitation).toMatch(new RegExp(`^${String(expected.length)} `));
      for (const pointer of expected) expect(limitation).toContain(pointer);
      // The decoder already excluded the standard credential and declared values.
      expect(limitation).not.toContain("Authorization");
      expect(limitation).not.toContain("Accept");
      if (sensitive.length > 0) {
        expect(limitation).not.toContain("X-Demo-Token");
        expect(limitation).not.toContain("/password");
      }
      for (const value of [
        "demo-bearer",
        "demo-token",
        "demo-key",
        "demo-pass",
        "demo-session",
      ])
        expect(limitation).not.toContain(value);
      expect(evidence.normalized_result).toMatchObject({
        limitations: expect.arrayContaining([limitation]),
      });
    }
  },
);
