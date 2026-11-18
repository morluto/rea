import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { cliCommands } from "../../../src/cli/commandRegistry.js";

const cli = createCli({});
const entries = cliCommands(cli);
const entry = (name: string) => {
  const found = entries.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${name} is not registered`);
  return found;
};

describe("REA's CLI command table", () => {
  it("names the operations a direct-analysis command runs and the flag of each field", () => {
    expect(entry("function").operations).toEqual([
      { name: "analyze_function", flags: expect.any(Object) },
      {
        name: "open_binary",
        flags: {
          format: "--target-format",
          architecture: "--architecture",
          entry_point: "--entry-point",
          provider_id: "--provider",
          snapshot_path: "--snapshot",
        },
      },
    ]);
    // `--kind procedures` chooses another operation.
    expect(entry("search").operations).toEqual([
      { name: "search_strings", flags: expect.any(Object) },
      { name: "open_binary", flags: expect.any(Object) },
      {
        name: "search_procedures",
        flags: expect.any(Object),
        selector: "--kind procedures",
      },
    ]);
    expect(entry("decompile").operations.map(({ name }) => name)).toEqual([
      "procedure_pseudo_code",
      "open_binary",
    ]);
    // The overview route opens its target the same way.
    expect(
      entry("analyze").operations.find(({ name }) => name === "open_binary")
        ?.flags,
    ).toMatchObject({ snapshot_path: "--snapshot" });
  });

  it("records each route of a routed command and each contract command's own flags", () => {
    expect(entry("analyze").operations.map(({ name }) => name)).toEqual([
      "analyze_javascript_application",
      "binary_overview",
      "open_binary",
    ]);
    expect(entry("inspect-byte-entropy").operations).toEqual([
      {
        name: "inspect_byte_entropy",
        flags: {
          block_size: "--block-size",
          offset: "--offset",
          length: "--length",
        },
      },
    ]);
  });

  it("flags every contract field an option sets: grouped fields and named selectors", () => {
    const flags = (command: string, operation: string) =>
      entry(command).operations.find(({ name }) => name === operation)?.flags;
    // One JSON option supplies each field of its group; the group's CLI key
    // is not a contract field.
    const jni = flags(
      "inspect-android-jni-bindings",
      "inspect_android_jni_bindings",
    );
    expect(jni).toMatchObject({
      class_name: "--query",
      method_names: "--query",
      descriptors: "--query",
      abis: "--query",
      library_paths: "--query",
    });
    expect(jni).not.toHaveProperty("query");
    // A positional selector is also set by its named option.
    expect(flags("function", "analyze_function")).toMatchObject({
      procedure: "--procedure",
    });
    expect(flags("decompile", "procedure_pseudo_code")).toMatchObject({
      procedure: "--procedure",
    });
    expect(flags("search", "search_strings")).toMatchObject({
      pattern: "--pattern",
    });
  });

  it("records the operations available from host commands", () => {
    for (const name of ["setup", "doctor"]) {
      expect(entry(name).operations).toEqual([]);
    }
    expect(entry("guidance").operations).toEqual([
      {
        name: "search_guidance",
        flags: {
          query: "--query",
          limit: "--limit",
          cursor: "--cursor",
        },
      },
      {
        name: "read_guidance_section",
        flags: {
          locator: "--locator",
        },
      },
    ]);
    expect(entry("capture-process").operations).toEqual([
      { name: "capture_process_scenario", flags: {} },
    ]);
  });
});
