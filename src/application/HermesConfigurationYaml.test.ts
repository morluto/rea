import { describe, expect, it } from "vitest";

import {
  editHermesConfigurationYaml,
  parseHermesConfigurationYaml,
} from "./HermesConfigurationYaml.js";

describe("Hermes configuration YAML", () => {
  it("writes an edited number from its new value", () => {
    expect(
      editHermesConfigurationYaml("mode: 0600\nmask: 0x1F\n", ["mode"], 384),
    ).toBe("mode: 384\nmask: 0x1F\n");
  });

  it("accepts keys Hermes reads as distinct and rejects a repeated key", () => {
    expect(() =>
      parseHermesConfigurationYaml("0600: octal\n600: decimal\n"),
    ).not.toThrow();
    expect(() => parseHermesConfigurationYaml('a: 1\n"a": 2\n')).toThrow();
  });
});
