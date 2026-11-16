import { it, expect } from "vitest";
import { Parser } from "incur";
import { z } from "zod";
import {
  parseCliGlobalArguments,
  productionMcpDoctorArguments,
} from "../../../src/cliBuiltinArguments.js";

it.each([
  [],
  ["--timings"],
  ["--no-timings"],
  ["--timings=false"],
  ["--timings=true"],
  ["--timings=other"],
  ["--timings="],
  ["--timings", "--no-timings"],
  ["--no-timings", "--timings=true"],
  ["--timings=false", "--timings"],
  ["--", "--timings"],
])("matches pinned boolean global parsing for %j", (...input: string[]) => {
  const actual = parseCliGlobalArguments(input);
  const parsed = Parser.parseGlobals(
    input,
    z.object({ timings: z.boolean().default(false) }),
  );
  expect({ arguments: actual.command, enabled: actual.timings }).toEqual({
    arguments: parsed.rest,
    enabled: parsed.parsed.timings,
  });
});
it.each([
  "--timings",
  "--no-timings",
  "--timings=false",
  "--timings=true",
  "--timings=other",
  "--timings=",
])("preserves output values and root alias with %s", (flag) => {
  expect(
    productionMcpDoctorArguments(["mcp", "doctor", "--format", flag]),
  ).toEqual({ arguments: ["--format", flag], timings: false });
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
    productionMcpDoctorArguments([
      "mcp",
      "doctor",
      "--format",
      "--",
      "--timings=true",
    ]),
  ).toEqual({ arguments: ["--format", "--"], timings: true });
});
it("takes the doctor words and timing global out of the doctor's arguments", () => {
  expect(
    productionMcpDoctorArguments([
      "--timings",
      "mcp",
      "--format=json",
      "doctor",
      "--no-timings",
      "--verbose",
    ]),
  ).toEqual({ arguments: ["--format", "json", "--verbose"], timings: false });
  expect(productionMcpDoctorArguments(["mcp", "add"])).toBeUndefined();
});
