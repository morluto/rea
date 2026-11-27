import { expect, it } from "vitest";
import { parseConfig } from "./parseConfig.js";
import { ghidraCParserControlLimit } from "./ghidraCParserLimits.js";

it("keeps the measured defaults when the launch environment sets no C parser control", () => {
  const config = parseConfig({});
  if (!config.ok) throw config.error;
  expect(config.value.ghidraCParserLimits).toEqual({
    signatureMaxUtf16: { value: 2048, source: "default" },
    declarationsMaxUtf16: { value: 4096, source: "default" },
    parenthesisDepth: { value: 8, source: "default" },
  });
});

it("admits each control at its floor and maximum and records the environment as its source", () => {
  for (const [signature, declarations, depth] of [
    ["16", "16", "1"],
    ["4096", "8192", "12"],
  ] as const) {
    const config = parseConfig({
      REA_GHIDRA_SIGNATURE_MAX_UTF16: signature,
      REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16: declarations,
      REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH: depth,
    });
    if (!config.ok) throw config.error;
    expect(config.value.ghidraCParserLimits).toEqual({
      signatureMaxUtf16: { value: Number(signature), source: "environment" },
      declarationsMaxUtf16: {
        value: Number(declarations),
        source: "environment",
      },
      parenthesisDepth: { value: Number(depth), source: "environment" },
    });
  }
});

it.each([
  ["REA_GHIDRA_SIGNATURE_MAX_UTF16", "15"],
  ["REA_GHIDRA_SIGNATURE_MAX_UTF16", "4097"],
  ["REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16", "15"],
  ["REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16", "8193"],
  ["REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH", "0"],
  // One more level doubles the worst-case parse time, so 13 is not admitted.
  ["REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH", "13"],
  ["REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH", "8.5"],
  ["REA_GHIDRA_SIGNATURE_MAX_UTF16", "2k"],
  ["REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16", ""],
])("refuses %s=%j at launch and names the setting", (setting, value) => {
  const config = parseConfig({ [setting]: value });
  if (config.ok) throw new Error("an out-of-range control was accepted");
  expect(config.error).toMatchObject({
    settings: [expect.objectContaining({ setting })],
  });
});

it("binds a refusal to the environment control with its range and default", () => {
  expect(
    ghidraCParserControlLimit("parenthesisDepth", {
      value: 10,
      source: "environment",
    }),
  ).toEqual({
    control_kind: "environment",
    environment: "REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH",
    effective_value: 10,
    unit: "count",
    minimum: 1,
    maximum: 12,
    default_value: 8,
    applies_at: "next_startup",
  });
});
