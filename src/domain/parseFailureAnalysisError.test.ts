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
