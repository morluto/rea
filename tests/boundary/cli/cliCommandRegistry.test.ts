import { parseCliArgv } from "../../../src/cli/argvParser.js";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { cliCommands } from "../../../src/cli/commandRegistry.js";
import { visitRegisteredCommands } from "../../../src/cli/visitRegisteredCommands.js";

const cli = createCli({});
const entries = cliCommands(cli);
const entry = (name: string) => {
  const found = entries.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${name} is not registered`);
  return found;
};

describe("REA's CLI command table", () => {
  it("holds every dispatched command, in registration order, with the served definition", () => {
    const dispatched: { path: string; command: object }[] = [];
    visitRegisteredCommands(cli, (command, path) =>
      dispatched.push({ path, command }),
    );
    expect(entries.map(({ name }) => name)).toEqual(
      dispatched.map(({ path }) => path),
    );
    // Shell owners rewrite inputs and handlers in place; the table sees them.
    for (const [index, { command }] of dispatched.entries())
      expect(entries[index]!.definition).toBe(command);
  });

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
    expect(entry("search").operations.map(({ name }) => name)).toEqual([
      "search_strings",
      "open_binary",
      "search_procedures",
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
    expect(entry("analyze").source.kind).toBe("routed");
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

  it("lists host commands without operations", () => {
    for (const name of ["setup", "doctor", "guidance", "capture-process"]) {
      expect(entry(name).source).toEqual({ kind: "host" });
      expect(entry(name).operations).toEqual([]);
    }
  });
});

it("records raster operations with their public option bindings", () => {
  expect(entry("inspect-raw-raster-candidates").operations).toEqual([
    {
      name: "inspect_raw_raster_candidates",
      flags: {
        offset: "--offset",
        length: "--length",
        widths: "--widths",
        heights: "--heights",
        formats: "--formats",
        offset_step: "--offset-step",
        min_score: "--min-score",
        max_hypotheses: "--max-hypotheses",
        max_candidates: "--max-candidates",
      },
    },
  ]);
  expect(
    entry("inspect-structured-raster-candidates").operations[0],
  ).toMatchObject({
    name: "inspect_structured_raster_candidates",
    flags: {
      grammar: "--grammar",
      segments: "--segments",
      min_consistency: "--min-consistency",
      resource_offset: "--resource-offset",
      max_previews: "--max-previews",
    },
  });
});

it("keeps repeated raster numeric options, fractional scores and JSON on the REA parser", () => {
  const raw = parseCliArgv(
    [
      "firmware.bin",
      "--widths",
      "16",
      "--widths",
      "32",
      "--heights",
      "16",
      "--formats",
      "gray8",
      "--min-score",
      "0.75",
    ],
    entry("inspect-raw-raster-candidates").definition,
  );
  expect(raw).toMatchObject({
    ok: true,
    value: {
      args: { path: "firmware.bin" },
      options: {
        widths: [16, 32],
        heights: [16],
        formats: ["gray8"],
        minScore: 0.75,
      },
    },
  });
  const structured = parseCliArgv(
    [
      "firmware.bin",
      "--bits-per-pixel",
      "1",
      "--bits-per-pixel",
      "4",
      "--offset-units",
      "2",
      "--min-consistency",
      "0.95",
      "--resource-offset",
      "128",
      "--segments",
      '[{"logicalOffset":4096,"fileOffset":0,"length":512}]',
    ],
    entry("inspect-structured-raster-candidates").definition,
  );
  expect(structured).toMatchObject({
    ok: true,
    value: {
      options: {
        bitsPerPixel: [1, 4],
        offsetUnits: [2],
        minConsistency: 0.95,
        resourceOffset: 128,
        segments: [{ logicalOffset: 4096, fileOffset: 0, length: 512 }],
      },
    },
  });
  expect(
    parseCliArgv(
      ["firmware.bin", "--min-score", "1.1"],
      entry("inspect-raw-raster-candidates").definition,
    ).ok,
  ).toBe(false);
  expect(
    parseCliArgv(
      ["firmware.bin", "--segments", "not-json"],
      entry("inspect-structured-raster-candidates").definition,
    ).ok,
  ).toBe(false);
});
