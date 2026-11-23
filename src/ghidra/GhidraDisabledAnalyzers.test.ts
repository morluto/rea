import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";

const INSTALL = "/opt/ghidra_12.1.4_PUBLIC";
const parseSetting = (setting?: string) =>
  parseConfig({
    GHIDRA_INSTALL_DIR: INSTALL,
    ...(setting === undefined
      ? {}
      : { REA_GHIDRA_DISABLED_ANALYZERS: setting }),
  });

const configured = (setting?: string) => {
  const config = parseSetting(setting);
  if (!config.ok) throw config.error;
  return config.value.ghidraDisabledAnalyzers;
};

describe("REA_GHIDRA_DISABLED_ANALYZERS", () => {
  it("leaves absent, empty, and whitespace-only settings unset", () => {
    for (const setting of [undefined, "", " , "])
      expect(configured(setting)).toBeUndefined();
  });

  it("trims analyzer names and drops empty fields in order", () => {
    expect(
      configured(" Objective-C Message Analyzer, ,Decompiler Switch Analysis "),
    ).toEqual(["Objective-C Message Analyzer", "Decompiler Switch Analysis"]);
  });

  const namesAtLimit = [
    ...Array.from({ length: 31 }, (_, index) => `Analyzer ${index}`),
    "A".repeat(120),
  ];
  it("accepts 32 analyzers and a 120-character name", () => {
    expect(configured(namesAtLimit.join(","))).toEqual(namesAtLimit);
  });

  it.each([
    ["a leading flag name", "-Decompiler Switch Analysis"],
    ["a name with command metacharacters", "Analyzer(&calc)"],
    ["a non-ASCII name", "分析器"],
    ["a 121-character name", "A".repeat(121)],
    ["33 analyzer names", [...namesAtLimit, "Extra Analyzer"].join(",")],
  ])("rejects %s", (_label, setting) => {
    expect(parseSetting(setting)).toMatchObject({
      ok: false,
      error: {
        settings: [
          expect.objectContaining({ setting: "REA_GHIDRA_DISABLED_ANALYZERS" }),
        ],
      },
    });
  });
});
