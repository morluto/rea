import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { MANAGED_NATIVE_VERIFICATION_EXAMPLE } from "../../../src/contracts/managed/managedWorkflowExamples.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import {
  managedNativeVerificationResultSchema,
  type ManagedNativeVerificationResult,
} from "../../../src/domain/managed/managedNativeVerificationSchemas.js";
import { inspectMachoSchema } from "../../../src/domain/native/nativeInspection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** More exports than one call can receive as arguments on V8's default stack. */
const EXPORTS = 130_000;

/** Recreate the example's Mach-O Evidence with `count` exports, keeping its matching first row. */
const machoExports = (count: number): Evidence => {
  const [source] = MANAGED_NATIVE_VERIFICATION_EXAMPLE.native_observations;
  if (source?.subject == null) throw new Error("Missing native example");
  const result = inspectMachoSchema.parse(source.normalized_result);
  const [match] = result.exports.items;
  if (match === undefined) throw new Error("Missing matching export");
  const items = [match];
  for (let index = 1; index < count; index += 1)
    items.push({
      name: `_audit_${String(index)}`,
      runtime_name: `audit_${String(index)}`,
      address: `0x${(0x1000 + index).toString(16)}`,
      weak: false,
      reexport: false,
      source: "nm",
    });
  return createEvidence(
    {
      path: source.subject.local_path,
      sha256: source.subject.digest.sha256,
      format: source.subject.format,
    },
    source.provider,
    {
      operation: source.operation,
      parameters: source.parameters,
      result: {
        ...result,
        exports: { ...result.exports, items, total: count },
      },
      rawResult: null,
      limitations: source.limitations,
    },
  );
};

/** P/Invoke outcomes, apart from the native record identity they cite. */
const outcomes = (
  result: ManagedNativeVerificationResult,
  native: Evidence,
): unknown =>
  JSON.parse(
    JSON.stringify(result.pinvoke_imports, (key, value: unknown) =>
      key === "item_id" ? undefined : value,
    ).replaceAll(native.evidence_id, "<native>"),
  );

cliTest(
  "verifies P/Invoke boundaries against a native inventory wider than call arguments allow",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-managed-wide-");
    const verify = async (count: number) => {
      const native = machoExports(count);
      const path = join(directory, `verify-${String(count)}.json`);
      await writeFile(
        path,
        JSON.stringify({
          managed_boundaries:
            MANAGED_NATIVE_VERIFICATION_EXAMPLE.managed_boundaries,
          native_observations: [native],
        }),
      );
      const command = await cli.run({
        arguments: ["verify-managed-native-boundaries", path, "--json"],
      });
      expect(command.exitCode, command.stdout + command.stderr).toBe(0);
      const result = managedNativeVerificationResultSchema.parse(
        parseEvidence(command.json).normalized_result,
      );
      return { result, native };
    };

    const control = await verify(3);
    const wide = await verify(EXPORTS);
    expect(wide.result.summary).toEqual(control.result.summary);
    expect(wide.result.summary).toMatchObject({ verified: 1 });
    expect(outcomes(wide.result, wide.native)).toEqual(
      outcomes(control.result, control.native),
    );
    expect(wide.result.pinvoke_imports[0]).toMatchObject({
      status: "verified",
      matched_native: {
        evidence_id: wide.native.evidence_id,
        name: "open_native",
      },
    });
  },
  120_000,
);
