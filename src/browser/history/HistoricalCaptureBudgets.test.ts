import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { WebNetworkCaptureService } from "../../application/WebNetworkCaptureService.js";
import { HistoricalCaptureDecoder } from "./HistoricalCaptureDecoder.js";
import { HAR_CAPTURE_PROVIDER_IDENTITY } from "./CaptureProviderIdentities.js";
import { historicalHar } from "../../../tests/fixtures/historicalHar.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { jsonValueValidationIssue } from "../../domain/jsonValue.js";
import { MAX_WEB_NETWORK_CAPTURE_NESTING_DEPTH } from "../../domain/webNetworkCapture.js";

const require = createRequire(import.meta.url);

/** Exercise the real private decoder protocol and parsers from the source checkout. */
const service = () =>
  new WebNetworkCaptureService(
    new HistoricalCaptureDecoder(
      [
        {
          format: "har",
          identity: HAR_CAPTURE_PROVIDER_IDENTITY,
          async command(requestPath) {
            return {
              command: process.execPath,
              arguments: [
                "--import",
                require.resolve("tsx"),
                fileURLToPath(
                  new URL("./NodeCaptureProcess.ts", import.meta.url),
                ),
                requestPath,
                "har",
              ],
            };
          },
        },
      ],
      process.env,
    ),
  );

it.each(["max_input_bytes", "max_reply_bytes", "max_nesting_depth"] as const)(
  "recovers the same complete capture by changing only %s",
  async (control) => {
    const root = await createTestTempDirectory("rea-capture-budgets-");
    const path = join(root, "capture.har");
    const fixture = historicalHar();
    const extended = {
      ...fixture,
      _extension: { sensitive: "exclude-me", payload: "x".repeat(4000) },
    };
    if (control === "max_nesting_depth") {
      let nested: unknown = "retained-leaf";
      for (let index = 0; index < 70; index++) nested = { child: nested };
      Object.assign(extended._extension, { nested });
    }
    const text = JSON.stringify(extended);
    await writeFile(path, text);
    const selected =
      control === "max_input_bytes"
        ? Buffer.byteLength(text) - 1
        : control === "max_reply_bytes"
          ? 512
          : 64;
    const raised =
      control === "max_input_bytes"
        ? Buffer.byteLength(text)
        : control === "max_reply_bytes"
          ? 16384
          : 128;
    const capture = service();
    onTestFinished(() => capture.close());
    const request = {
      capture_path: path,
      format: "har",
      sensitive_values: ["exclude-me"],
    };
    const refused = await capture.inspect({ ...request, [control]: selected });
    if (refused.ok)
      throw new Error("Selected budget unexpectedly admitted the capture");
    const error = projectAnalysisError(refused.error);
    expect(error.remediation.action).toContain(control);
    expect(error.details).toMatchObject({
      diagnostics: {
        budget: {
          parameter: control,
          effective_value: selected,
          source: "request",
          update_mode: "parameter",
          pending_restart: false,
        },
      },
    });
    const recovered = await capture.inspect({ ...request, [control]: raised });
    if (!recovered.ok) throw recovered.error;
    expect(recovered.value.parameters[control]).toBe(raised);
    expect(recovered.value.normalized_result).toMatchObject({
      artifact: { path, bytes: Buffer.byteLength(text) },
      total_records: 1,
      records: [
        {
          ordinal: 0,
          location: { kind: "json-pointer", pointer: "/log/entries/0" },
        },
      ],
    });
    expect(JSON.stringify(recovered.value)).not.toContain("exclude-me");
    // Admission changes cannot make malformed source valid.
    await writeFile(path, '{"log":');
    const malformed = await capture.inspect({ ...request, [control]: raised });
    if (malformed.ok)
      throw new Error("Malformed capture unexpectedly admitted");
    expect(malformed.error._tag).toBe("AnalysisInputError");
  },
);

it("keeps concurrent capture policies independent", async () => {
  const root = await createTestTempDirectory("rea-capture-budget-isolation-");
  const path = join(root, "capture.har");
  let nested: unknown = "leaf";
  for (let index = 0; index < 70; index++) nested = { child: nested };
  await writeFile(
    path,
    JSON.stringify({ ...historicalHar(), _extension: nested }),
  );
  const capture = service();
  onTestFinished(() => capture.close());
  const request = { capture_path: path, format: "har" };
  const [narrow, wide] = await Promise.all([
    capture.inspect({ ...request, max_nesting_depth: 64 }),
    capture.inspect({ ...request, max_nesting_depth: 128 }),
  ]);
  if (narrow.ok)
    throw new Error("Narrow operation borrowed the concurrent budget");
  expect(projectAnalysisError(narrow.error).details).toMatchObject({
    issues: [{ expected: { maximum_capture_nesting: 64 } }],
  });
  if (!wide.ok) throw wide.error;
  expect(wide.value.parameters.max_nesting_depth).toBe(128);
  expect(wide.value.normalized_result).toMatchObject({ total_records: 1 });
});

it("reserves reply and Evidence nesting before accepting a deep capture policy", async () => {
  const root = await createTestTempDirectory("rea-capture-depth-envelope-");
  const path = join(root, "capture.har");
  const writeDepth = async (depth: number) => {
    let nested: unknown = "retained-leaf";
    // The HAR document root contributes the first container level.
    for (let index = 1; index < depth; index++) nested = { child: nested };
    await writeFile(
      path,
      JSON.stringify({ ...historicalHar(), _vendor: nested }),
    );
  };
  const capture = service();
  onTestFinished(() => capture.close());
  const request = { capture_path: path, format: "har" };
  // Previously this accepted policy returned invalid full Evidence, or threw
  // during normalized-result construction, after a successful decoder run.
  await writeDepth(998);
  const invalidPolicy = await capture.inspect({
    ...request,
    max_nesting_depth: 1000,
  });
  if (invalidPolicy.ok)
    throw new Error("Unrepresentable capture policy was accepted");
  expect(projectAnalysisError(invalidPolicy.error)).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["max_nesting_depth"], maximum: 996 }] },
  });
  await writeDepth(MAX_WEB_NETWORK_CAPTURE_NESTING_DEPTH);
  const accepted = await capture.inspect({
    ...request,
    max_nesting_depth: MAX_WEB_NETWORK_CAPTURE_NESTING_DEPTH,
  });
  if (!accepted.ok) throw accepted.error;
  expect(jsonValueValidationIssue(accepted.value)).toBeUndefined();
  expect(accepted.value.normalized_result).toMatchObject({ total_records: 1 });
  await writeDepth(MAX_WEB_NETWORK_CAPTURE_NESTING_DEPTH + 1);
  const exhausted = await capture.inspect({
    ...request,
    max_nesting_depth: MAX_WEB_NETWORK_CAPTURE_NESTING_DEPTH,
  });
  if (exhausted.ok)
    throw new Error("Capture exceeded its selected nesting allowance");
  expect(projectAnalysisError(exhausted.error)).toMatchObject({
    details: {
      diagnostics: { budget: { effective_value: 996, maximum: 996 } },
    },
    remediation: { action: expect.stringContaining("at its maximum") },
  });
});
