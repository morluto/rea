import { expect, it } from "vitest";

import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "./analysisErrorCore.js";
import { fixedAllowanceOptions } from "./fixedAllowanceRemediation.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  unsupportedInput,
} from "./parseFailure.js";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "./parseFailureAnalysisError.js";

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

it("recognizes only a parse limit of the named format", () => {
  const limit = decodeLimit("elf", "section table exceeds budget", {
    name: "structure",
    maximum: 16,
  });
  expect(isParseLimit(limit, "elf")).toBe(true);
  expect(isParseLimit(limit, "pe")).toBe(false);
  expect(isParseLimit(malformedInput("elf", "bad header"), "elf")).toBe(false);
  expect(isParseLimit(new Error("other"), "elf")).toBe(false);
});

it("builds a structured limit refusal with optional path context and required size", () => {
  const plain = decodeLimit("sigrok-decoder-catalog", "line budget exceeded", {
    name: "line_budget",
    maximum: 65536,
  });
  const plainError = parseLimitConstraint(
    "inspect_signal_decoders",
    "memory",
    plain,
    fixedAllowanceOptions("The decoder line allowance", "capture"),
  );
  expect(plainError).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(plainError).toMatchObject({
    operation: "inspect_signal_decoders",
    resource: "memory",
    reason: "line budget exceeded",
    reportedLimits: { boundary: "line_budget", maximum: 65536 },
    cause: plain,
  });

  const numericRequired = decodeLimit("elf", "section names exceed budget", {
    name: "max_file_bytes",
    maximum: 1024,
    required: 2048,
  });
  expect(
    parseLimitConstraint("inspect_elf_notes", "memory", numericRequired, {
      path: "/tmp/sample.elf",
      retryable: false,
      remediationAction: "Raise max_file_bytes above 1024.",
    }),
  ).toMatchObject({
    reason: "Selected artifact /tmp/sample.elf: section names exceed budget",
    reportedLimits: {
      boundary: "max_file_bytes",
      maximum: 1024,
      required: 2048,
    },
    retryable: false,
  });

  const bigintRequired = decodeLimit("elf", "section names exceed safe range", {
    name: "max_file_bytes",
    maximum: 1024,
    required: 9007199254740993n,
  });
  expect(
    parseLimitConstraint("inspect_elf_notes", "memory", bigintRequired, {
      retryable: false,
    }),
  ).toMatchObject({
    reason: "section names exceed safe range",
    reportedLimits: {
      boundary: "max_file_bytes",
      maximum: 1024,
      required: "9007199254740993",
    },
  });
});
