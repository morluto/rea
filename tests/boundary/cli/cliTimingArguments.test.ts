import { it, expect } from "vitest";
import { Parser, z } from "incur";
import {
  splitCliTimingArguments,
  normalizeCliArguments,
  splitIncurBuiltinArguments,
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
  const actual = splitCliTimingArguments(input);
  const parsed = Parser.parseGlobals(
    input,
    z.object({ timings: z.boolean().default(false) }),
  );
  expect(actual).toEqual({
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
  expect(splitCliTimingArguments(["--format", flag])).toEqual({
    arguments: ["--format", flag],
    enabled: false,
  });
  expect(normalizeCliArguments([flag, "--update", "--json"])).toEqual([
    "update",
    flag,
    "--json",
  ]);
  expect(normalizeCliArguments(["--update", flag, "--json"])).toEqual([
    "update",
    flag,
    "--json",
  ]);
  expect(splitIncurBuiltinArguments([flag, "mcp", "doctor"]).command).toEqual([
    "mcp",
    "doctor",
  ]);
});
it("retains the separator and its following timing-shaped data", () => {
  expect(normalizeCliArguments(["--", "--update", "--timings=false"])).toEqual([
    "--",
    "--update",
    "--timings=false",
  ]);
  expect(splitCliTimingArguments(["--format", "--", "--timings=true"])).toEqual(
    { arguments: ["--format", "--"], enabled: true },
  );
});
