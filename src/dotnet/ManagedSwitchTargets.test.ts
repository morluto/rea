import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedPeFixtureTarget } from "./ManagedPe.fixture.js";
import {
  managedSwitchFixture,
  managedSwitchInstruction as switchBytes,
} from "../../tests/fixtures/managedSwitchTargets.js";

const inspect = (il: Buffer, format: "tiny" | "fat" = "tiny") => {
  const bytes = managedSwitchFixture(il, format);
  return inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes));
};

const loop = (deltas: readonly number[] = [0, -19, 0]) =>
  Buffer.concat([
    Buffer.from([0x00, 0x02]),
    switchBytes(deltas),
    Buffer.from([0x2a]),
  ]);

it.each(["tiny", "fat"] as const)(
  "retains ordered signed switch targets and fallthrough in a %s body",
  (format) => {
    const report = inspect(loop(), format);
    const body = report.methods[0]?.body;
    expect(body?.status).toBe("present");
    expect(body?.anchors.find((anchor) => anchor.opcode === "switch")).toEqual({
      il_offset: 2,
      opcode: "switch",
      operand_kind: "switch",
      operand: "3",
      switch_targets: [19, 0, 19],
      switch_fallthrough: 19,
    });
  },
);

it("distinguishes an observed empty switch table from historical omission", () => {
  const il = Buffer.concat([
    Buffer.from([0x02]),
    switchBytes([]),
    Buffer.from([0x2a]),
  ]);
  expect(inspect(il).methods[0]?.body.anchors[1]).toMatchObject({
    operand: "0",
    switch_targets: [],
    switch_fallthrough: 6,
  });
});

it("uses the end of each complete table as the relative-offset base", () => {
  const il = Buffer.concat([
    Buffer.from([0x02]),
    switchBytes([10, 0]),
    Buffer.from([0x02]),
    switchBytes([0]),
    Buffer.from([0x2a]),
  ]);
  const tables = inspect(il).methods[0]?.body.anchors.filter(
    (anchor) => anchor.opcode === "switch",
  );
  expect(tables).toMatchObject([
    { il_offset: 1, switch_targets: [24, 14], switch_fallthrough: 14 },
    { il_offset: 15, switch_targets: [24], switch_fallthrough: 24 },
  ]);
});

it.each([
  ["missing count", Buffer.from([0x00, 0x45, 0x01, 0x00])],
  ["truncated targets", Buffer.from([0x00, 0x45, 0x02, 0, 0, 0, 0, 0, 0, 0])],
  ["impossible extent", Buffer.from([0x00, 0x45, 0xff, 0xff, 0xff, 0xff])],
])("does not expose a partially read table with %s", (_name, il) => {
  const body = inspect(il).methods[0]?.body;
  expect(body).toMatchObject({
    status: "malformed",
    decoded_instruction_count: 1,
    anchors: [
      { il_offset: 0, opcode: "nop", operand_kind: "none", operand: null },
    ],
    normalized_il_sha256: null,
  });
  expect(body?.issue).toContain("Instruction switch");
});

it("preserves the member-result-v1 fingerprint and exact raw CIL identity", () => {
  const left = inspect(loop()).methods[0]?.body;
  const right = inspect(loop([-19, 0, 0])).methods[0]?.body;
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        ["nop", "none", null],
        ["ldarg.0", "none", null],
        ["switch", "switch", "3"],
        ["ret", "none", null],
      ]),
    )
    .digest("hex");
  expect(left?.normalized_il_sha256).toBe(expected);
  expect(right?.normalized_il_sha256).toBe(expected);
  expect(left?.il_sha256).not.toBe(right?.il_sha256);
});

it("reads historical anchors without inventing switch-target observations", () => {
  const source = inspect(loop());
  const historical = {
    ...source,
    methods: source.methods.map((method) => ({
      ...method,
      body: {
        ...method.body,
        anchors: method.body.anchors.map((anchor) =>
          Object.fromEntries(
            Object.entries(anchor).filter(
              ([key]) =>
                key !== "switch_targets" && key !== "switch_fallthrough",
            ),
          ),
        ),
      },
    })),
  };
  const parsed = managedMemberInspectionSchema.parse(historical);
  const anchor = parsed.methods[0]?.body.anchors.find(
    (item) => item.opcode === "switch",
  );
  expect(anchor).toMatchObject({ operand: "3" });
  expect(anchor).not.toHaveProperty("switch_targets");
  expect(anchor).not.toHaveProperty("switch_fallthrough");
});

it("retains out-of-body targets as raw destinations without asserting CIL validity", () => {
  const report = inspect(loop([-0x8000_0000, 0x7fff_ffff, -16]));
  const body = report.methods[0]?.body;
  expect(body?.anchors[2]).toMatchObject({
    switch_targets: [-2147483629, 2147483666, 3],
    switch_fallthrough: 19,
  });
  expect(managedMemberInspectionSchema.parse(report)).toEqual(report);
});

it("keeps complete switch observations when a later instruction is truncated", () => {
  const body = inspect(Buffer.concat([loop(), Buffer.from([0x45])])).methods[0]
    ?.body;
  expect(body).toMatchObject({
    status: "malformed",
    normalized_il_sha256: null,
    decoded_instruction_count: 4,
  });
  expect(body?.anchors[2]).toMatchObject({ switch_targets: [19, 0, 19] });
});

it("admits a wide target table before allocation and recovers with the shared capacity control", () => {
  const caseCount = 4000;
  const bytes = managedSwitchFixture(
    Buffer.concat([
      Buffer.from([0x02]),
      switchBytes(Array.from({ length: caseCount }, () => 0)),
      Buffer.from([0x2a]),
    ]),
    "fat",
  );
  const target = managedPeFixtureTarget(bytes);
  const arrayFrom = Array.from;
  const allocation = vi.spyOn(Array, "from");
  try {
    const refused = inspectManagedMembersBytes(bytes, target, {
      maxRepresentationBytes: 28_000,
    });
    expect(refused.coverage).toMatchObject({
      state: "partial",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "resource-limit",
          scope: "metadata.representation",
          limit: expect.objectContaining({
            parameter: "max_metadata_representation_bytes",
            effective_value: 28_000,
          }),
        }),
      ]),
    });
    expect(refused.methods).toEqual([]);
    expect(refused.types.length).toBeGreaterThan(0);
    expect(allocation.mock.calls.map(([input]) => input)).not.toContainEqual({
      length: caseCount,
    });
  } finally {
    allocation.mockRestore();
  }
  const admitted = inspectManagedMembersBytes(bytes, target, {
    maxRepresentationBytes: 1_048_576,
  });
  expect(admitted.methods[0]?.body.anchors[1]).toMatchObject({
    switch_targets: arrayFrom({ length: caseCount }, () => 16006),
    switch_fallthrough: 16006,
  });
  expect(admitted.coverage.state).toBe("complete");
});
