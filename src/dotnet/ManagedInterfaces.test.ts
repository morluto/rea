import { expect, it, vi } from "vitest";

import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { parseManagedInterfaceImplementations } from "./ManagedInterfaces.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import {
  attachManagedDecodeBudget,
  ManagedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import {
  parseTypes,
  readTypeDefinitions,
} from "../domain/managed/managedMemberInspectorCore.js";
import { readTypeMemberListFacts } from "../domain/managed/managedTypeMemberLists.js";
import {
  buildManagedPeFixture,
  fixtureUserStringHeap,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import {
  metadataRowOffset,
  readManagedMetadataLayout,
} from "../domain/managed/managedMetadataLayout.js";

const metadataLayout = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const { rva, size } = pe.cli.metadata;
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(rva, size, "metadata"),
    size,
  );
};

const inspect = (
  options: Parameters<typeof buildManagedPeFixture>[0] = {},
  selection?: { readonly typeNames?: readonly string[] },
) => {
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    typeNamespace: "Demo",
    typeName: "Worker",
    typeReferences: [{ namespace: "Contracts", name: "IWorker" }],
    ...options,
  });
  return inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    selection,
  );
};

it("retains the InterfaceImpl row that the metadata summary already counts", () => {
  const report = inspect({ interfaceImplementations: [[1, 9]] });
  expect(report.metadata.table_row_counts.InterfaceImpl).toBe(1);
  expect(report).toMatchObject({
    interface_implementations: {
      state: "complete",
      rows: [
        {
          token: "0x09000001",
          row_offset: expect.any(Number),
          class_row: 1,
          class_token: "0x02000001",
          declaring_type: "Demo.Worker",
          interface_coded_index: 9,
          interface_token: "0x01000002",
          interface_name: "Contracts.IWorker",
        },
      ],
      issues: [],
    },
  });
  expect(report.coverage.state).toBe("complete");
});

it("distinguishes an examined empty table from absent historical evidence", () => {
  expect(inspect()).toMatchObject({
    interface_implementations: { state: "complete", rows: [], issues: [] },
  });
});

it("keeps interface rows independent of MethodDef paging", () => {
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    interfaceImplementations: [[1, 5]],
  });
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    { methodLimit: 0 },
  );
  expect(report.methods).toEqual([]);
  expect(report).toMatchObject({
    interface_implementations: { rows: [{ token: "0x09000001" }] },
  });
});

it("follows the selected declaring type and keeps the original row token", () => {
  const report = inspect(
    {
      additionalEmptyTypes: 1,
      interfaceImplementations: [
        [1, 9],
        [2, 9],
      ],
    },
    { typeNames: ["Demo.Worker"] },
  );
  expect(report).toMatchObject({
    interface_implementations: {
      state: "complete",
      rows: [
        {
          token: "0x09000002",
          class_token: "0x02000002",
          declaring_type: "Demo.Worker",
        },
      ],
    },
  });
});

it.each([0, 3])(
  "retains an invalid class coordinate %s without claiming a valid owner",
  (owner) => {
    const report = inspect({ interfaceImplementations: [[owner, 9]] });
    expect(report).toMatchObject({
      interface_implementations: {
        state: "partial",
        rows: [
          {
            class_row: owner,
            class_token: null,
            declaring_type: null,
            interface_token: "0x01000002",
          },
        ],
        issues: [expect.objectContaining({ code: "invalid-row" })],
      },
    });
    expect(report.coverage.state).toBe("complete");
    expect(report.methods.length).toBe(1);
  },
);

it.each([0, 3, 13])(
  "retains an invalid interface coordinate %s beside its observed owner",
  (encoded) => {
    expect(inspect({ interfaceImplementations: [[1, encoded]] })).toMatchObject(
      {
        interface_implementations: {
          state: "partial",
          rows: [
            {
              class_token: "0x02000001",
              interface_coded_index: encoded,
              interface_token: null,
              interface_name: null,
            },
          ],
          issues: [expect.objectContaining({ code: "invalid-row" })],
        },
      },
    );
  },
);

it("retains distinct constructed interface tokens even when display names agree", () => {
  const report = inspect({
    typeReferences: [{ namespace: "Contracts", name: "IContainer`1" }],
    typeSpecSignatures: [
      Buffer.from([0x15, 0x12, 9, 1, 0x08]),
      Buffer.from([0x15, 0x12, 9, 1, 0x0e]),
    ],
    interfaceImplementations: [
      [1, 6],
      [1, 10],
    ],
  });
  expect(report.interface_implementations).toMatchObject({
    state: "complete",
    rows: [
      {
        interface_token: "0x1b000001",
        interface_name: "Contracts.IContainer`1",
      },
      {
        interface_token: "0x1b000002",
        interface_name: "Contracts.IContainer`1",
      },
    ],
    issues: [],
  });
});

it("keeps malformed TypeSpec identity and confines its failure to interface coverage", () => {
  const report = inspect({
    typeSpecSignatures: [Buffer.from([0x15])],
    interfaceImplementations: [[1, 6]],
  });
  expect(report.interface_implementations).toMatchObject({
    state: "partial",
    rows: [{ interface_token: "0x1b000001", interface_name: null }],
    issues: [
      expect.objectContaining({
        code: "invalid-blob",
        scope: "metadata.TypeSpec:0x1b000001",
      }),
    ],
  });
  expect(report.coverage).toEqual({ state: "complete", issues: [] });
});

it("decodes four-byte TypeDefOrRef indexes without truncating the interface row", () => {
  const references = Array.from({ length: 16_383 }, (_, index) => ({
    namespace: "Contracts",
    name: `I${String(index)}`,
  }));
  const report = inspect({
    typeReferences: references,
    interfaceImplementations: [[1, 65_537]],
  });
  expect(report.interface_implementations).toMatchObject({
    state: "complete",
    rows: [
      {
        interface_coded_index: 65_537,
        interface_token: "0x01004000",
        interface_name: "Contracts.I16382",
      },
    ],
    issues: [],
  });
});

it("reads local interface declarations including an interface that extends an interface", () => {
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    typeNamespace: "Demo",
    additionalEmptyTypes: 1,
    interfaceImplementations: [[2, 4]],
  });
  const layout = metadataLayout(bytes);
  for (const row of [1, 2])
    bytes.writeUInt32LE(0x000000a1, metadataRowOffset(layout, 2, row));
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.interface_implementations).toMatchObject({
    state: "complete",
    rows: [
      {
        class_token: "0x02000002",
        interface_token: "0x02000001",
        interface_name: "Demo.Empty0",
      },
    ],
    issues: [],
  });
});

it("reports a local class used as an interface without discarding its source declaration", () => {
  const report = inspect({
    additionalEmptyTypes: 1,
    interfaceImplementations: [[2, 4]],
  });
  expect(report.interface_implementations).toMatchObject({
    state: "partial",
    rows: [{ interface_token: "0x02000001", interface_name: "Demo.Empty0" }],
    issues: [
      expect.objectContaining({
        code: "invalid-row",
        detail: expect.stringContaining("without the Interface flag"),
      }),
    ],
  });
  expect(report.coverage.state).toBe("complete");
});

it("retains duplicate rows and marks the declaration inventory partial", () => {
  const report = inspect({
    interfaceImplementations: [
      [1, 9],
      [1, 9],
    ],
  });
  expect(report.interface_implementations).toMatchObject({
    state: "partial",
    rows: [{ token: "0x09000001" }, { token: "0x09000002" }],
    issues: [
      expect.objectContaining({
        detail: expect.stringContaining("Duplicate Class and Interface"),
      }),
    ],
  });
});

it("does not decode a malformed interface for an unselected declaring type", () => {
  const report = inspect(
    {
      additionalEmptyTypes: 1,
      interfaceImplementations: [
        [1, 0],
        [2, 9],
      ],
    },
    { typeNames: ["Demo.Worker"] },
  );
  expect(report.interface_implementations).toMatchObject({
    state: "complete",
    rows: [{ token: "0x09000002" }],
    issues: [],
  });
});

it("keeps an unreadable owner coordinate unknown instead of reporting no declaration", () => {
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    interfaceImplementations: [[1, 5]],
  });
  const layout = metadataLayout(bytes);
  const nameOffset = metadataRowOffset(layout, 2, 1) + 4;
  bytes.writeUInt16LE(0xffff, nameOffset);
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.interface_implementations).toMatchObject({
    state: "partial",
    rows: [{ class_token: "0x02000001", declaring_type: null }],
    issues: [
      expect.objectContaining({
        detail: expect.stringContaining("unreadable TypeDef name"),
      }),
    ],
  });
  const selected = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    { typeNames: ["Demo.Example"] },
  );
  expect(selected.interface_implementations).toMatchObject({
    state: "partial",
    rows: [],
  });
});

it("keeps an unreadable local interface name unknown beside the complete declaration row", () => {
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    additionalEmptyTypes: 1,
    interfaceImplementations: [[2, 4]],
  });
  const layout = metadataLayout(bytes);
  const targetOffset = metadataRowOffset(layout, 2, 1);
  bytes.writeUInt32LE(0xa1, targetOffset);
  bytes.writeUInt16LE(0xffff, targetOffset + 4);
  const report = inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );
  expect(report.interface_implementations).toMatchObject({
    state: "complete",
    rows: [
      {
        class_token: "0x02000002",
        interface_token: "0x02000001",
        interface_name: null,
      },
    ],
    issues: [],
  });
  expect(report.coverage.state).toBe("partial");
  expect(report.unresolved_definitions?.rows).toContainEqual(
    expect.objectContaining({ token: "0x02000001", kind: "TypeDef" }),
  );
});

it("preserves decoded methods and user strings when only the interface inventory exceeds capacity", () => {
  const { heap, tokens } = fixtureUserStringHeap(["retained literal"]);
  const firstToken = tokens[0];
  if (firstToken === undefined) throw new Error("Missing literal token");
  const body = Buffer.from([0x1e, 0x72, 0, 0, 0, 0, 0x26, 0x2a]);
  body.writeUInt32LE(Number.parseInt(firstToken, 16), 2);
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    userStringHeap: heap,
    ilBody: body,
    typeReferences: [{ namespace: "Contracts", name: `I${"x".repeat(8_000)}` }],
    interfaceImplementations: [[1, 9]],
  });
  const target = managedPeFixtureTarget(bytes);
  const complete = inspectManagedMembersBytes(bytes, target);
  const limited = inspectManagedMembersBytes(bytes, target, {
    maxRepresentationBytes: 40_000,
  });
  expect(complete.interface_implementations?.state).toBe("complete");
  expect(limited).toMatchObject({
    methods: complete.methods,
    fields: complete.fields,
    coverage: complete.coverage,
    user_strings: complete.user_strings,
    interface_implementations: {
      state: "partial",
      rows: [],
      issues: [{ code: "resource-limit", scope: "metadata.InterfaceImpl" }],
    },
  });
  expect(limited.methods.length).toBe(1);
  expect(limited.user_strings?.literals.map(({ value }) => value)).toEqual([
    "retained literal",
  ]);
});

it.each([true, false])(
  "validates the assembled member report once with userStrings=%s",
  (userStrings) => {
    const bytes = buildManagedPeFixture({
      targetFramework: null,
      interfaceImplementations: [[1, 5]],
    });
    const parse = vi.spyOn(managedMemberInspectionSchema, "parse");
    try {
      const report = inspectManagedMembersBytes(
        bytes,
        managedPeFixtureTarget(bytes),
        { userStrings },
      );
      expect(report.interface_implementations?.state).toBe("complete");
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  },
);

it("names a direct interface without rebuilding an assembly-wide signature index", () => {
  const bytes = buildManagedPeFixture({
    targetFramework: null,
    typeNamespace: "Demo",
    typeName: "Worker",
    additionalEmptyTypes: 128,
    typeReferences: [{ namespace: "Contracts", name: "IWorker" }],
    interfaceImplementations: [[129, 9]],
  });
  const layout = metadataLayout(bytes);
  const ranges = readTypeDefinitions(
    bytes,
    layout,
    [],
    readTypeMemberListFacts(bytes, layout),
  );
  const parsedTypes = parseTypes(bytes, layout, ranges);
  expect(parsedTypes.types).toHaveLength(129);
  // Exercise the interface facet with the remaining capacity after member
  // admission: 8 KiB fits the selected declaration, not 129 * 128 bytes.
  attachManagedDecodeBudget(layout, new ManagedDecodeBudget(8 * 1024));
  expect(
    parseManagedInterfaceImplementations(
      bytes,
      layout,
      ranges,
      parsedTypes,
      new Set(["0x02000081"]),
    ),
  ).toMatchObject({
    state: "complete",
    rows: [
      {
        class_token: "0x02000081",
        interface_name: "Contracts.IWorker",
      },
    ],
    issues: [],
  });
});
