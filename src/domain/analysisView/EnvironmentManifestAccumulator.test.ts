import { expect, it } from "vitest";
import { environmentManifestCaptureFixture } from "../../../tests/fixtures/analysisView.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { EnvironmentManifestAccumulator } from "./EnvironmentManifestAccumulator.js";

const sample = (
  ordinal: number,
  path: string,
  postText?: string,
): WebNetworkCaptureRecord => ({
  ...environmentManifestCaptureFixture().records[0]!,
  ordinal,
  limitations: [],
  reported: {
    request: {
      method: postText === undefined ? "GET" : "POST",
      url: `https://manifest.test${path}`,
      ...(postText === undefined
        ? {}
        : { postData: { mimeType: "application/json", text: postText } }),
    },
    response: { status: 200, content: { mimeType: "application/json" } },
  },
});

const finished = (accumulator: EnvironmentManifestAccumulator) => {
  const result = accumulator.finish();
  if (!result.ok) throw result.error;
  return result.value;
};

it("refuses a body parse that exceeds the budget without retaining a partial tool", () => {
  const accumulator = new EnvironmentManifestAccumulator(32 * 1024);
  expect(accumulator.add(sample(0, "/api/items")).ok).toBe(true);
  const before = finished(accumulator);
  const body = `{"name":"${"x".repeat(2_000)}"}`;
  expect(accumulator.add(sample(1, "/api/items", body))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator)).toEqual(before);
  expect(accumulator.add(sample(2, "/api/items", '{"name":"n"}')).ok).toBe(
    true,
  );
  expect(finished(accumulator).tools.map((tool) => tool.body_shape)).toEqual([
    null,
    { type: "object", properties: { name: "string" } },
  ]);
});

it("charges every retained record pointer so many records exhaust a small budget", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  let accepted = 0;
  for (; accepted < 1000; accepted += 1) {
    const result = accumulator.add(
      sample(accepted, `/api/route${String(accepted)}`),
    );
    if (result.ok) continue;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    break;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(1000);
  const manifest = finished(accumulator);
  expect(manifest.records).toHaveLength(accepted);
  expect(manifest.tools).toHaveLength(accepted);
  expect(manifest.coverage.total).toBe(accepted);
});

it("retains repeated observed values, statuses and query names once across many samples", () => {
  const accumulator = new EnvironmentManifestAccumulator(1024 * 1024);
  for (let ordinal = 0; ordinal < 1000; ordinal += 1)
    expect(
      accumulator.add(sample(ordinal, "/api/items/7?page=1&page=2")).ok,
    ).toBe(true);
  const manifest = finished(accumulator);
  expect(manifest.tools).toHaveLength(1);
  expect(manifest.tools[0]).toMatchObject({
    params: [{ observed_values: ["7"] }],
    query_parameter_names: ["page"],
    statuses: [200],
  });
  expect(manifest.tools[0]?.record_ordinals).toHaveLength(1000);
  expect(manifest.records).toHaveLength(1000);
});

it("charges every literal route part so a path of many short segments fails closed", () => {
  const accumulator = new EnvironmentManifestAccumulator(1024 * 1024);
  expect(accumulator.add(sample(0, "/a".repeat(100))).ok).toBe(true);
  expect(accumulator.add(sample(1, "/a".repeat(5_000)))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator).tools).toHaveLength(1);
});

it("charges a request media type before scanning it so an oversized one fails closed", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  const record = sample(0, "/api/items", "{}");
  (
    record.reported as { request: { postData: { mimeType: string } } }
  ).request.postData.mimeType = `application/json${"x".repeat(100_000)}`;
  expect(accumulator.add(record)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator).tools).toHaveLength(0);
});

it("charges the group key before building it so an oversized request method fails closed", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  const record = sample(0, "/api/items");
  (record.reported as { request: { method: string } }).request.method =
    `GET${"X".repeat(100_000)}`;
  expect(accumulator.add(record)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator).tools).toHaveLength(0);
});

it("counts only admitted scenario transactions and refreshes their snapshot limitations", () => {
  const accumulator = new EnvironmentManifestAccumulator(32 * 1024);
  expect(finished(accumulator).origin).toBe("");
  expect(accumulator.add(sample(0, "/api/items"), "absent").ok).toBe(true);
  const before = finished(accumulator);
  expect(before.limitations.join(" ")).not.toContain("no primary origin");
  expect(
    accumulator.add(
      {
        ...sample(1, "/api/items", `{"name":"${"x".repeat(2_000)}"}`),
        limitations: ["rejected-only limitation"],
      },
      "redacted",
    ).ok,
  ).toBe(false);
  expect(finished(accumulator)).toEqual(before);
  expect(
    accumulator.add({
      ...sample(1, "/api/items"),
      limitations: ["uncommitted limitation", "x".repeat(100_000)],
    }).ok,
  ).toBe(false);
  expect(finished(accumulator)).toEqual(before);
  expect(
    accumulator.add(
      {
        ...sample(2, "/api/items", '{"name":"n"}'),
        limitations: ["accepted record limitation"],
      },
      "redacted",
    ).ok,
  ).toBe(true);
  const after = finished(accumulator);
  expect(after.limitations).toContain("accepted record limitation");
  expect(after.records.map((record) => record.ordinal)).toEqual([0, 2]);
  expect(
    after.limitations.filter((limitation) =>
      limitation.includes("scenario transactions with a usable request line"),
    ),
  ).toEqual([
    "1 of 2 scenario transactions with a usable request line retained a response body with declared secret values replaced by redaction markers; tools citing them replay the redacted bytes.",
    "1 of 2 scenario transactions with a usable request line retained no response body; tools citing them replay only the recorded status and content type, either of which may be absent.",
  ]);
});
