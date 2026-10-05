import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compareManagedMembers } from "./managedMemberComparison.js";
import { inspectManagedMembersBytes } from "../dotnet/ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "../dotnet/ManagedPe.fixture.js";

const inspect = (bytes: Buffer, path: string) => {
  const target = managedPeFixtureTarget(bytes, path);
  const result = inspectManagedMembersBytes(bytes, target);
  return { result, evidenceId: `ev_${hash(Buffer.from(path))}` };
};

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("managed member partial body comparison", () => {
  it("keeps unavailable body facets unknown while retaining an observed signature change", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-body-partial.dll");
    const right = inspect(
      buildManagedPeFixture(),
      "/tmp/right-body-partial.dll",
    );
    const leftMethod = left.result.methods[0];
    const rightMethod = right.result.methods[0];
    expect(leftMethod).toBeDefined();
    expect(rightMethod).toBeDefined();
    if (leftMethod === undefined || rightMethod === undefined) return;
    const leftResult = {
      ...left.result,
      methods: [
        {
          ...leftMethod,
          body: {
            ...leftMethod.body,
            status: "partial" as const,
            normalized_il_sha256: null,
          },
        },
      ],
    };
    const rightResult = {
      ...right.result,
      methods: [
        {
          ...rightMethod,
          body: {
            ...rightMethod.body,
            status: "partial" as const,
            normalized_il_sha256: null,
            opcode_counts: { nop: 1 },
          },
        },
      ],
    };
    const partial = compareManagedMembers(
      { evidenceId: left.evidenceId, result: leftResult },
      { evidenceId: right.evidenceId, result: rightResult },
    );
    expect(partial.methods[0]).toMatchObject({
      status: "unknown",
      dimensions: ["body-coverage"],
    });

    const rightSignatureChanged = {
      ...right.result,
      methods: [
        {
          ...rightMethod,
          signature: {
            ...rightMethod.signature,
            raw_sha256: "f".repeat(64),
          },
        },
      ],
    };
    const signatureChanged = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      {
        evidenceId: right.evidenceId,
        result: rightSignatureChanged,
      },
    );
    expect(signatureChanged.methods[0]).toMatchObject({
      status: "changed",
      dimensions: ["signature"],
    });

    const bothAbsent = compareManagedMembers(
      {
        evidenceId: left.evidenceId,
        result: {
          ...left.result,
          methods: [
            {
              ...leftMethod,
              body: { ...leftMethod.body, status: "absent" as const },
            },
          ],
        },
      },
      {
        evidenceId: right.evidenceId,
        result: {
          ...right.result,
          methods: [
            {
              ...rightMethod,
              body: { ...rightMethod.body, status: "absent" as const },
            },
          ],
        },
      },
    );
    expect(bothAbsent.methods[0]).toMatchObject({
      status: "unchanged",
      dimensions: [],
    });
  });
});
