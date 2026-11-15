import { expect, it } from "vitest";

import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "./analysisErrorCore.js";
import {
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "./parseFailure.js";
import { parseFailureAnalysisError } from "./parseFailureAnalysisError.js";

const project = (cause: unknown) =>
  parseFailureAnalysisError("inspect_example", "/tmp/sample.bin", cause);

it.each([
  malformedInput("elf", "section table overlaps the header"),
  new ParseFailureError({
    kind: "truncated",
    format: "elf",
    detail: "section table runs past the end of the file",
    offset: 64,
    field: "section table",
  }),
])("refuses $failure.kind bytes as an invalid selected path", (cause) => {
  const error = project(cause);
  expect(error).toBeInstanceOf(AnalysisInputError);
  expect(error).toMatchObject({
    cause,
    issues: [
      {
        path: ["path"],
        reason: "invalid_format",
        message: `Selected artifact /tmp/sample.bin: ${cause.message}`,
      },
    ],
  });
});

it("keeps facts the parser observed before the failure on the refused path", () => {
  const cause = new ParseFailureError({
    kind: "truncated",
    format: "rpm",
    detail: "RPM main header range is truncated or outside the file",
    observed: { lead: { magic: "edabeedb" } },
  });
  expect(project(cause)).toMatchObject({
    issues: [
      {
        path: ["path"],
        reason: "invalid_format",
        observed: { lead: { magic: "edabeedb" } },
      },
    ],
  });
});

it("names the input that selected the malformed artifact", () => {
  const cause = malformedInput(
    "apple-ips",
    "IPS metadata is not a JSON object",
  );
  expect(
    parseFailureAnalysisError(
      "inspect_example",
      "/tmp/join.dylib",
      cause,
      "join_path",
    ),
  ).toMatchObject({
    issues: [
      {
        path: ["join_path"],
        reason: "invalid_format",
        message: `Selected artifact /tmp/join.dylib: ${cause.message}`,
      },
    ],
  });
});

it("refuses an unsupported form as an unsupported target, keeping undecoded content", () => {
  const cause = unsupportedInput("go", "compressed build-info section", {
    undecodedContent: true,
  });
  const error = project(cause);
  expect(error).toBeInstanceOf(AnalysisUnsupportedTargetError);
  expect(error).toMatchObject({
    cause,
    path: "/tmp/sample.bin",
    reason: "compressed build-info section",
    undecodedContent: true,
  });
});

it("keeps observed facts on an unsupported target as diagnostics", () => {
  const observed = { lead: { name: "demo-1.0.0-1" } };
  const error = project(
    new ParseFailureError({
      kind: "unsupported",
      format: "rpm",
      detail: "RPM signature type 0 is not the header signature format.",
      undecodedContent: false,
      observed,
    }),
  );
  expect(error).toBeInstanceOf(AnalysisUnsupportedTargetError);
  expect(error?.diagnostics).toEqual({ observed });
});

it("leaves a limit and any other cause to the producer", () => {
  expect(
    project(
      new ParseFailureError({
        kind: "limit",
        format: "elf",
        detail: "section table exceeds the structural budget",
        limit: { name: "structure", maximum: 16 },
      }),
    ),
  ).toBeUndefined();
  expect(project(new RangeError("Maximum call stack size exceeded"))).toBe(
    undefined,
  );
});
