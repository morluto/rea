import { expect, it } from "vitest";

import { bufferByteSource } from "../../domain/byteSource.js";
import { MACHO_FUNCTION_STARTS_PROVIDER } from "../../domain/investigationProviders.js";
import {
  inspectMachoFunctionStartsInputSchema,
  type MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import { ok } from "../../domain/result.js";
import {
  arm64FunctionStartsImage,
  machoFunctionStartsUniversal,
  x64FunctionStartsImage,
} from "../../native/apple/MachoFunctionStarts.fixture.js";
import { parseMachoFunctionStartsFromHandle } from "../../native/apple/MachoFunctionStarts.js";
import type { StableArtifactHandle } from "../../resources/index.js";
import { expectInvalidInspectionInputs } from "../../../tests/support/expectInvalidInspectionInputs.js";
import { lateCancellationEvidence } from "../../../tests/support/lateCancellationEvidence.js";
import { MachoFunctionStartsService } from "./MachoFunctionStartsService.js";

const identity = MACHO_FUNCTION_STARTS_PROVIDER;
const SHA = "b".repeat(64);

const parsed = (
  bytes: Buffer,
  raw: Readonly<Record<string, unknown>> = {},
): Promise<MachoFunctionStarts> => {
  const input = inspectMachoFunctionStartsInputSchema.parse({
    path: "/artifacts/program",
    ...raw,
  });
  const source = bufferByteSource(bytes);
  const handle: StableArtifactHandle = {
    sha256: SHA,
    size: source.size,
    prefix: source.prefix,
    readRange: source.readRange,
  };
  return parseMachoFunctionStartsFromHandle(
    handle,
    { path: input.path, sha256: SHA, bytes: bytes.length },
    input,
  );
};

const arm = await parsed(arm64FunctionStartsImage());

const accept = (value: MachoFunctionStarts) =>
  new MachoFunctionStartsService({
    identity,
    inspect: () => Promise.resolve(ok(value)),
  }).inspect({ path: value.artifact.path });

it("rejects a relative path and extra arguments before reading", () =>
  expectInvalidInspectionInputs(
    arm,
    "program",
    (inspect) => new MachoFunctionStartsService({ identity, inspect }),
  ));

it("records Mach-O function starts for the selected image", async () => {
  const result = await accept(arm);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    operation: "inspect_macho_function_starts",
    subject: { identity: { format: "mach-o", architecture: "arm64" } },
    normalized_result: arm,
  });
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: arm.artifact.path },
    {
      kind: "file-offset-range",
      start: 0x4000,
      end: 0x4000 + 11,
    },
    {
      kind: "file-offset-range",
      start: 0x4200,
      end: 0x4200 + 24,
    },
  ]);
  expect(result.value.limitations).toEqual(arm.limitations);

  const universal = await parsed(
    machoFunctionStartsUniversal(
      arm64FunctionStartsImage(),
      x64FunctionStartsImage(),
    ),
    { architecture: "x86_64" },
  );
  const selected = await new MachoFunctionStartsService({
    identity,
    inspect: () => Promise.resolve(ok(universal)),
  }).inspect({ path: universal.artifact.path, architecture: "x86_64" });
  if (!selected.ok) throw selected.error;
  expect(selected.value.subject.identity).toMatchObject({
    format: "mach-o-universal",
    architecture: "x86_64",
  });
});

it("rejects a report whose coverage status disagrees with its counters", async () => {
  for (const inconsistent of [
    {
      ...arm,
      coverage: { ...arm.coverage, status: "partial" as const },
    },
    {
      ...arm,
      coverage: {
        ...arm.coverage,
        status: "complete" as const,
        duplicate_commands: 1,
      },
    },
    {
      ...arm,
      limitations: arm.limitations.filter(
        (line) => line !== arm.limitations[0],
      ),
    },
  ]) {
    const result = await accept(inconsistent);
    expect(result.ok).toBe(false);
  }
});

it("keeps the completed report when cancellation lands after inspection", async () => {
  const evidence = await lateCancellationEvidence(
    arm,
    "inspect_macho_function_starts",
    (inspect) => new MachoFunctionStartsService({ identity, inspect }),
  );
  expect(evidence.normalized_result).toEqual(arm);
});
