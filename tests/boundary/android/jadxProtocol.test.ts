import { expect, it } from "vitest";
import {
  parseJadxEnvelope,
  parseJadxJson,
  normalizeJadxText,
} from "../../../src/android/JadxProtocol.js";
import { androidInputSchemas } from "../../../src/domain/androidAnalysis.js";

it("validates provider text envelopes and rejects unsupported content rather than dropping it", () => {
  expect(
    parseJadxEnvelope(
      { content: [{ type: "text", text: "reported error" }], isError: true },
      "inspect_android_package",
    ),
  ).toEqual({ text: "reported error", failed: true });
  for (const response of [
    { content: [] },
    { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    },
  ])
    expect(() =>
      parseJadxEnvelope(response, "inspect_android_package"),
    ).toThrowError("unsupported MCP content envelope");
  expect(() =>
    parseJadxJson("{malformed", "inspect_android_package"),
  ).toThrowError("malformed JSON text");
});

it("retains UTF-8 source and recognizes only the producer's terminal truncation marker", () => {
  expect(normalizeJadxText("日本語")).toEqual({
    text: "日本語",
    status: "complete",
    reported_total_bytes: null,
  });
  const text = "日本語\n\n... [truncated: exceeds 9 bytes, total 100 bytes]";
  expect(normalizeJadxText(text)).toEqual({
    text,
    status: "partial",
    reported_total_bytes: 100,
  });
  expect(normalizeJadxText(text + "\nmore actual source").status).toBe(
    "complete",
  );
});

it("rejects invalid APK selectors and accepts an explicit zero overload without a confirmation flag", () => {
  const input = {
    path: "/fixture.apk",
    class_name: "fixture.Target",
    method_name: "choose",
  };
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      overload_index: 0,
    }).success,
  ).toBe(true);
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      overload_index: -1,
    }).success,
  ).toBe(false);
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      overload_index: 0.5,
    }).success,
  ).toBe(false);
  expect(
    androidInputSchemas.inspect_android_method.safeParse({
      ...input,
      approved: true,
    }).success,
  ).toBe(false);
  expect(
    androidInputSchemas.search_android_classes.safeParse({
      path: "/fixture.apk",
      query: "",
    }).success,
  ).toBe(true);
});
