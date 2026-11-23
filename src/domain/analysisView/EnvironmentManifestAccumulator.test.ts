import { expect, it } from "vitest";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { EnvironmentManifestAccumulator } from "./EnvironmentManifestAccumulator.js";
import { EnvironmentStateAccumulator } from "./EnvironmentStateAccumulator.js";
import { STATE_BODY_LIMIT_BYTES } from "./environmentStateRules.js";

const sample = (
  ordinal: number,
  path: string,
  postText?: string,
  response?: { readonly text: string; readonly mimeType?: string },
): WebNetworkCaptureRecord => ({
  ordinal,
  location: { kind: "json-pointer", pointer: `/log/entries/${ordinal}` },
  binary_fields: [],
  numeric_literals: [],
  redactions: [],
  limitations: [],
  reported: {
    request: {
      method: postText === undefined ? "GET" : "POST",
      url: `https://manifest.test${path}`,
      ...(postText === undefined
        ? {}
        : { postData: { mimeType: "application/json", text: postText } }),
    },
    response: {
      status: 200,
      content: {
        mimeType: "application/json",
        ...response,
      },
    },
  },
});

const finished = (accumulator: EnvironmentManifestAccumulator) => {
  const result = accumulator.finish();
  if (!result.ok) throw result.error;
  return result.value;
};

it("charges request shapes to the manifest without exhausting the state budget", () => {
  const limit = 128 * 1024;
  const write = sample(
    1,
    "/api/export-events",
    `{"name":"${"x".repeat(STATE_BODY_LIMIT_BYTES)}"}`,
  );
  const manifest = new EnvironmentManifestAccumulator(limit);
  expect(finished(manifest).origin).toBe("");
  expect(manifest.add(sample(0, "/api/items"), "absent").ok).toBe(true);
  const before = finished(manifest);
  expect(before.limitations.join(" ")).not.toContain("no primary origin");
  expect(
    manifest.add(
      { ...write, limitations: ["rejected-only limitation"] },
      "redacted",
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(manifest)).toEqual(before);
  expect(
    manifest.add({
      ...sample(1, "/api/items"),
      limitations: ["uncommitted limitation", "x".repeat(100_000)],
    }).ok,
  ).toBe(false);
  expect(finished(manifest)).toEqual(before);
  expect(
    manifest.add(
      {
        ...sample(2, "/api/export-events", '{"batch":7}', {
          text: '{"memo":"[REDACTED]"}',
        }),
        limitations: ["accepted record limitation"],
      },
      "redacted",
    ).ok,
  ).toBe(true);
  const after = finished(manifest);
  expect(after.records.map(({ ordinal }) => ordinal)).toEqual([0, 2]);
  expect(after.tools).toMatchObject([
    {
      name: "post_export_events",
      body_shape: { type: "object", properties: { batch: "number" } },
      record_ordinals: [2],
    },
    { name: "get_items", body_shape: null, record_ordinals: [0] },
  ]);
  expect(after.limitations).toContain("accepted record limitation");
  expect(
    after.limitations.filter((item) =>
      item.includes("scenario transactions with a usable request line"),
    ),
  ).toEqual([
    expect.stringContaining(
      "1 of 2 scenario transactions with a usable request line retained a response body with declared secret values",
    ),
    expect.stringContaining(
      "1 of 2 scenario transactions with a usable request line retained no response body",
    ),
  ]);

  const state = new EnvironmentStateAccumulator(limit);
  const read = sample(0, "/api/items", undefined, {
    text: '[{"id":1}]',
    mimeType: "Application/Vnd.Notes+JSON; charset=UTF-8",
  });
  expect(state.add(read).ok).toBe(true);
  expect(state.add(write)).toEqual({ ok: true, value: undefined });
  const projected = state.finishState();
  if (!projected.ok) throw projected.error;
  expect(projected.value.entities).toMatchObject([
    {
      id: "1",
      collection: "/api/items",
      fields: { id: 1 },
      record_ordinals: [0],
    },
  ]);
  expect(projected.value.writes).toMatchObject([
    { tool: "post_export_events", served: false, reason: "no-state-target" },
  ]);
});

it("reserves request media normalization when the state reads the body", () => {
  const accumulator = new EnvironmentStateAccumulator(128 * 1024);
  const write = sample(0, "/api/export-events", "{}");
  (
    write.reported as { request: { postData: { mimeType: string } } }
  ).request.postData.mimeType = `Application/vnd.${"X".repeat(100_000)}+JSON`;
  expect(accumulator.add(write)).toEqual({ ok: true, value: undefined });
  expect(accumulator.finishState()).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
});

it("charges each record pointer and retains repeated route and query facts once", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  const attempts = 160;
  let accepted = 0;
  for (; accepted < attempts; accepted += 1) {
    const result = accumulator.add(
      sample(accepted, "/api/items/7?page=1&page=2"),
    );
    if (result.ok) continue;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "memory",
    });
    break;
  }
  expect(accepted).toBeGreaterThanOrEqual(90);
  expect(accepted).toBeLessThan(attempts);
  const manifest = finished(accumulator);
  const ordinals = Array.from({ length: accepted }, (_, ordinal) => ordinal);
  expect(manifest.records.map(({ ordinal }) => ordinal)).toEqual(ordinals);
  expect(manifest.tools).toMatchObject([
    {
      params: [{ observed_values: ["7"] }],
      query_parameter_names: ["page"],
      statuses: [200],
      record_ordinals: ordinals,
    },
  ]);
  expect(manifest.coverage.total).toBe(1);
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

const oversized = "x".repeat(100_000);
it.each([
  ["method", { method: `GET${oversized}` }],
  [
    "request media type",
    { postData: { mimeType: `application/json${oversized}`, text: "{}" } },
  ],
] as const)(
  "refuses an oversized %s before retaining a tool",
  (_, overrides) => {
    const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
    const record = sample(0, "/api/items", "{}");
    Object.assign((record.reported as { request: object }).request, overrides);
    expect(accumulator.add(record)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
    expect(finished(accumulator).tools).toEqual([]);
  },
);
