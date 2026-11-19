import { it, expect } from "vitest";
import {
  classifyCliEntrypoint,
  parseCliGlobalArguments,
} from "../../../src/cliBuiltinArguments.js";

// Observed with Incur 0.6.1 before removing the dependency.
it.each([
  {
    input: [],
    rest: [],
    enabled: false,
  },
  {
    input: ["--timings"],
    rest: [],
    enabled: true,
  },
  {
    input: ["--no-timings"],
    rest: [],
    enabled: false,
  },
  {
    input: ["--timings=false"],
    rest: [],
    enabled: false,
  },
  {
    input: ["--timings=true"],
    rest: [],
    enabled: true,
  },
  {
    input: ["--timings=other"],
    rest: [],
    enabled: false,
  },
  {
    input: ["--timings="],
    rest: [],
    enabled: false,
  },
  {
    input: ["--timings", "--no-timings"],
    rest: [],
    enabled: false,
  },
  {
    input: ["--no-timings", "--timings=true"],
    rest: [],
    enabled: true,
  },
  {
    input: ["--timings=false", "--timings"],
    rest: [],
    enabled: true,
  },
  {
    input: ["--", "--timings"],
    rest: ["--", "--timings"],
    enabled: false,
  },
])(
  "preserves the recorded boolean global grammar for %j",
  ({ input, rest, enabled }) => {
    const actual = parseCliGlobalArguments(input);
    expect({ arguments: actual.command, enabled: actual.timings }).toEqual({
      arguments: rest,
      enabled,
    });
  },
);

it.each([
  "--timings",
  "--no-timings",
  "--timings=false",
  "--timings=true",
  "--timings=other",
  "--timings=",
])("preserves output values and root alias with %s", (flag) => {
  expect(
    classifyCliEntrypoint(["mcp", "doctor", "--format", flag], {}),
  ).toEqual({
    kind: "mcp-doctor",
    arguments: ["--format", flag],
    timings: false,
  });
  expect(
    parseCliGlobalArguments([flag, "--update", "--json"]).arguments,
  ).toEqual(["update", flag, "--json"]);
  expect(
    parseCliGlobalArguments(["--update", flag, "--json"]).arguments,
  ).toEqual(["update", flag, "--json"]);
  expect(parseCliGlobalArguments([flag, "mcp", "doctor"]).command).toEqual([
    "mcp",
    "doctor",
  ]);
});
it("retains the separator and its following timing-shaped data", () => {
  expect(
    parseCliGlobalArguments(["--", "--update", "--timings=false"]).arguments,
  ).toEqual(["--", "--update", "--timings=false"]);
  expect(
    classifyCliEntrypoint(
      ["mcp", "doctor", "--format", "--", "--timings=true"],
      {},
    ),
  ).toEqual({
    kind: "mcp-doctor",
    arguments: ["--format", "--"],
    timings: true,
  });
});
it("takes the doctor words and timing global out of the doctor's arguments", () => {
  expect(
    classifyCliEntrypoint(
      [
        "--timings",
        "mcp",
        "--format=json",
        "doctor",
        "--no-timings",
        "--verbose",
      ],
      {},
    ),
  ).toEqual({
    kind: "mcp-doctor",
    arguments: ["--format", "json", "--verbose"],
    timings: false,
  });
  expect(classifyCliEntrypoint(["mcp", "add"], {})).toEqual({ kind: "cli" });
});
