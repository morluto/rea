import { describe, expect, it } from "vitest";
import { buildManagedPeFixture } from "../../scripts/fixtures/managed/pe.mjs";
import type { ManagedPeFixtureOptions } from "../../scripts/fixtures/managed/pe.mjs";
import { managedPeFixtureTarget } from "./ManagedPe.fixture.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import { comparisonLimitations } from "../domain/managed/managedMemberComparisonCoverage.js";
import { projectManagedMemberView } from "../domain/analysisView/managedMemberView.js";
import {
  managedMembersViewPageSchema,
  managedMembersViewRequestSchema,
} from "../domain/analysisView/managedMemberViewSchemas.js";
import { freezeOwnedJsonTreeSnapshot } from "../domain/immutableJson.js";

/** Static void Configure(int32 count, int32 mode = ...). */
const configureSignature = Buffer.from([0x00, 0x02, 0x01, 0x08, 0x08]);
const paramParent = (row: number) => (row << 2) | 1;

const inspect = (
  options: ManagedPeFixtureOptions,
  selection: Parameters<typeof inspectManagedMembersBytes>[2] = {},
) => {
  const bytes = buildManagedPeFixture(options);
  return inspectManagedMembersBytes(
    bytes,
    managedPeFixtureTarget(bytes),
    selection,
  );
};

const configure = (
  modeFlags: number,
  constants: NonNullable<ManagedPeFixtureOptions["constants"]>,
): ManagedPeFixtureOptions => ({
  methods: [
    {
      name: "Configure",
      signature: configureSignature,
      params: [{ name: "count" }, { name: "mode", flags: modeFlags }],
    },
    { name: "Main" },
  ],
  constants,
});

it("retains an i4 parameter default with its Param and Constant rows", () => {
  const result = inspect(
    configure(0x1010, [
      {
        typeCode: 0x08,
        parentRaw: paramParent(2),
        value: Buffer.from("04000000", "hex"),
      },
    ]),
  );
  expect(result.methods[0]).toMatchObject({
    name: "Configure",
    parameter_defaults: [
      {
        token: "0x08000002",
        row_offset: expect.any(Number),
        sequence: 2,
        name: "mode",
        flags: 0x1010,
        constant: {
          state: "decoded",
          element_type: "i4",
          value: 4,
          raw_hex: "04000000",
          declarations: [
            {
              row_offset: expect.any(Number),
              type_code: 0x08,
              padding: 0,
              blob_index: expect.any(Number),
            },
          ],
          limitation: null,
        },
      },
    ],
  });
  // A method whose Param run is empty was examined and declares no default.
  expect(result.methods[1]).toMatchObject({
    name: "Main",
    parameter_defaults: [],
  });
  expect(result.coverage).toEqual({ state: "complete", issues: [] });
});

it("decodes field and parameter defaults from one Constant table", () => {
  const result = inspect({
    ...configure(0x1010, [
      { typeCode: 0x08, value: Buffer.from("865d0000", "hex") },
      {
        typeCode: 0x0e,
        parentRaw: paramParent(2),
        value: Buffer.from("6f006e00", "hex"),
      },
    ]),
    fields: [{ name: "WMGraphNotify", flags: 0x8056 }],
  });
  expect(result.fields[0]?.constant).toMatchObject({
    state: "decoded",
    value: 23942,
  });
  expect(result.methods[0]?.parameter_defaults).toEqual([
    expect.objectContaining({
      name: "mode",
      constant: expect.objectContaining({
        state: "decoded",
        element_type: "string",
        value: "on",
      }),
    }),
  ]);
  expect(result.coverage.state).toBe("complete");
});

it("keeps readable sibling defaults when one Param name is unreadable", () => {
  const result = inspect({
    methods: [
      {
        name: "Configure",
        signature: configureSignature,
        params: [
          { name: "count", flags: 0x1010, nameIndex: 0xfff0 },
          { name: "mode", flags: 0x1010 },
        ],
      },
    ],
    constants: [
      {
        typeCode: 0x08,
        parentRaw: paramParent(1),
        value: Buffer.from("01000000", "hex"),
      },
      {
        typeCode: 0x08,
        parentRaw: paramParent(2),
        value: Buffer.from("04000000", "hex"),
      },
    ],
  });
  expect(result.methods[0]?.parameter_defaults).toEqual([
    expect.objectContaining({
      token: "0x08000002",
      name: "mode",
      constant: expect.objectContaining({ value: 4 }),
    }),
  ]);
  expect(result.coverage.issues).toEqual([
    expect.objectContaining({
      code: "invalid-heap-index",
      scope: "metadata.#Strings",
    }),
  ]);
});

describe("unavailable parameter defaults retain independent facts", () => {
  it.each([
    { label: "HasDefault without a Constant row", flags: 0x1000, count: 0 },
    { label: "a Constant row without HasDefault", flags: 0x0010, count: 1 },
  ])("keeps $label explicit", ({ flags, count }) => {
    const result = inspect(
      configure(
        flags,
        count === 0
          ? []
          : [
              {
                typeCode: 0x08,
                parentRaw: paramParent(2),
                value: Buffer.from("04000000", "hex"),
              },
            ],
      ),
    );
    expect(result.methods[0]?.parameter_defaults).toEqual([
      expect.objectContaining({
        token: "0x08000002",
        name: "mode",
        constant: expect.objectContaining({
          state: "unavailable",
          value: null,
          limitation: expect.any(String),
        }),
      }),
    ]);
    expect(
      result.methods[0]?.parameter_defaults?.[0]?.constant.declarations,
    ).toHaveLength(count);
    expect(result.methods[0]?.body.status).toBe("present");
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "metadata.Constant:0x08000002" }),
      ]),
    );
  });

  it.each([
    { label: "a null start", paramList: 0, next: undefined },
    {
      label: "a start past the one-past-end sentinel",
      paramList: 4,
      next: undefined,
    },
    { label: "a run that ends before it starts", paramList: 3, next: 2 },
  ])("keeps a method with $label unattributed", ({ paramList, next }) => {
    const options = configure(0x1010, [
      {
        typeCode: 0x08,
        parentRaw: paramParent(2),
        value: Buffer.from("04000000", "hex"),
      },
    ]);
    const [first, second] = options.methods ?? [];
    if (first === undefined || second === undefined)
      throw new Error("Expected two fixture methods");
    const result = inspect({
      ...options,
      methods: [
        { ...first, paramList },
        next === undefined ? second : { ...second, paramList: next },
      ],
    });
    expect(result.methods[0]).toMatchObject({
      name: "Configure",
      parameter_defaults: null,
      body: { status: "present" },
    });
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-row",
          scope: "metadata.MethodDef:0x06000001",
        }),
      ]),
    );
  });

  it("keeps runs out of order with another nonempty run unattributed", () => {
    // A's run 2..3 and C's run 1..4 would both claim Param row 2.
    const result = inspect({
      methods: [
        { name: "A", paramList: 2, params: [{ name: "first" }] },
        {
          name: "B",
          paramList: 3,
          params: [{ name: "shared", flags: 0x1010 }],
        },
        { name: "C", paramList: 1, params: [{ name: "last" }] },
      ],
      constants: [
        {
          typeCode: 0x08,
          parentRaw: paramParent(2),
          value: Buffer.from("04000000", "hex"),
        },
      ],
    });
    expect(result.methods.map((method) => method.parameter_defaults)).toEqual([
      null,
      null,
      null,
    ]);
    expect(result.coverage.issues).toEqual(
      expect.arrayContaining(
        ["0x06000001", "0x06000003"].map((token) =>
          expect.objectContaining({
            scope: `metadata.MethodDef:${token}`,
            detail: expect.stringContaining("out of order"),
          }),
        ),
      ),
    );
  });

  it("does not decode an unselected method's malformed default", () => {
    const options = configure(0x1010, [
      {
        typeCode: 0x08,
        parentRaw: paramParent(2),
        value: Buffer.from([1]),
      },
    ]);
    for (const selection of [{ typeNames: ["Missing"] }, { methodOffset: 1 }]) {
      const result = inspect(options, selection);
      expect(result.methods.every(({ name }) => name !== "Configure")).toBe(
        true,
      );
      expect(
        result.coverage.issues.some(({ scope }) =>
          scope.startsWith("metadata.Constant"),
        ),
      ).toBe(false);
    }
  });
});

describe("Param rows before every ParamList run", () => {
  // Configure's run starts at 2, so Param row 1 belongs to no method.
  const leading = (
    constants: NonNullable<ManagedPeFixtureOptions["constants"]>,
  ): ManagedPeFixtureOptions => ({
    methods: [
      {
        name: "Configure",
        paramList: 2,
        params: [{ name: "count", flags: 0x1010 }, { name: "mode" }],
      },
      { name: "Main" },
    ],
    constants,
  });

  it("keeps every method's defaults unknown when a leading row declares one", () => {
    const result = inspect(
      leading([
        {
          typeCode: 0x08,
          parentRaw: paramParent(1),
          value: Buffer.from("04000000", "hex"),
        },
      ]),
    );
    expect(result.methods.map((method) => method.parameter_defaults)).toEqual([
      null,
      null,
    ]);
    expect(result.coverage.issues).toEqual([
      expect.objectContaining({
        code: "invalid-row",
        scope: "metadata.Param:0x08000001",
        detail: expect.stringContaining(
          "its list position precedes every MethodDef ParamList run",
        ),
      }),
    ]);
  });

  it("reports owned runs when the leading row declares no default", () => {
    const result = inspect({
      ...leading([]),
      methods: [
        {
          name: "Configure",
          paramList: 2,
          params: [{ name: "count" }, { name: "mode" }],
        },
        { name: "Main" },
      ],
    });
    expect(result.methods.map((method) => method.parameter_defaults)).toEqual([
      [],
      [],
    ]);
    expect(result.coverage).toEqual({ state: "complete", issues: [] });
  });
});

describe("ParamPtr indirection", () => {
  it("attributes Param rows through their pointer positions", () => {
    const result = inspect({
      methods: [
        { name: "Configure", params: [{ name: "count", flags: 0x1010 }] },
        { name: "Main", params: [{ name: "mode" }] },
      ],
      constants: [
        {
          typeCode: 0x08,
          parentRaw: paramParent(1),
          value: Buffer.from("04000000", "hex"),
        },
      ],
      // Configure's position 1 names Param row 2; Main's position 2 names row 1.
      paramPointers: [2, 1],
    });
    expect(result.methods.map((method) => method.parameter_defaults)).toEqual([
      [],
      [
        expect.objectContaining({
          token: "0x08000001",
          name: "count",
          constant: expect.objectContaining({ state: "decoded", value: 4 }),
        }),
      ],
    ]);
    expect(result.coverage).toEqual({ state: "complete", issues: [] });
  });

  it("keeps every method's defaults unknown when an unlisted Param row declares one", () => {
    // ParamPtr lists only Param row 1, so row 2's default has no owning method.
    const result = inspect({
      methods: [
        {
          name: "Configure",
          paramList: 1,
          params: [{ name: "count" }, { name: "mode", flags: 0x1010 }],
        },
        { name: "Main", paramList: 2 },
      ],
      constants: [
        {
          typeCode: 0x08,
          parentRaw: paramParent(2),
          value: Buffer.from("04000000", "hex"),
        },
      ],
      paramPointers: [1],
    });
    expect(result.methods.map((method) => method.parameter_defaults)).toEqual([
      null,
      null,
    ]);
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual([
      expect.objectContaining({
        code: "invalid-row",
        scope: "metadata.Param:0x08000002",
        detail: expect.stringContaining("no ParamPtr row lists it"),
      }),
    ]);
  });

  it("does not treat an unlisted Param row without a default as hiding one", () => {
    const result = inspect({
      methods: [
        {
          name: "Configure",
          paramList: 1,
          params: [{ name: "count" }, { name: "mode" }],
        },
        { name: "Main", paramList: 2 },
      ],
      paramPointers: [1],
    });
    expect(result.methods.map((method) => method.parameter_defaults)).toEqual([
      [],
      [],
    ]);
    expect(result.coverage).toEqual({ state: "complete", issues: [] });
  });

  it("keeps parameter defaults unknown when the pointer table is invalid", () => {
    const result = inspect({ ...configure(0x1010, []), paramPointers: [1, 1] });
    expect(result.methods[0]).toMatchObject({
      name: "Configure",
      parameter_defaults: null,
    });
    expect(result.coverage.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "metadata.ParamPtr" }),
      ]),
    );
  });
});

it("projects parameter defaults from retained method rows", () => {
  const result = inspect(
    configure(0x1010, [
      {
        typeCode: 0x08,
        parentRaw: paramParent(2),
        value: Buffer.from("04000000", "hex"),
      },
    ]),
  );
  const view = projectManagedMemberView(
    {
      predicateType: "rea.analysis",
      evidenceId: `ev_${"a".repeat(64)}`,
      operation: "inspect_managed_members",
      normalizedResult: freezeOwnedJsonTreeSnapshot(result),
      sealedResult: true,
      limitations: [],
    },
    managedMembersViewRequestSchema.parse({
      kind: "managed-members",
      collection: "methods",
      fields: ["parameter_defaults"],
      limit: 1,
    }),
  );
  if (!view.ok) throw view.error;
  if (!("page" in view.value)) throw new Error("Expected a member page");
  expect(managedMembersViewPageSchema.parse(view.value.page)).toEqual({
    collection: "methods",
    source_count: 2,
    unresolved_filter_rows: 0,
    rows: [
      {
        token: "0x06000001",
        row_offset: result.methods[0]?.row_offset,
        declaring_type_token: "0x02000001",
        parameter_defaults: result.methods[0]?.parameter_defaults,
        source_index: 0,
      },
    ],
  });
});

it("refuses member Evidence that omits parameter defaults", () => {
  const result = inspect(configure(0x1010, []));
  const methods = result.methods.map(
    ({ parameter_defaults: _defaults, ...method }) => method,
  );
  expect(
    managedMemberInspectionSchema.safeParse({ ...result, methods }).success,
  ).toBe(false);
});

it("discloses that member comparison does not examine parameter defaults", () => {
  const limitation =
    "Parameter Constant-table defaults are not compared; method matching and change detection do not examine them.";
  const declared = inspect(
    configure(0x1010, [
      {
        typeCode: 0x08,
        parentRaw: paramParent(2),
        value: Buffer.from("04000000", "hex"),
      },
    ]),
  );
  expect(comparisonLimitations(declared, declared)).toContain(limitation);
  const ordinary = inspect({});
  expect(ordinary.methods[0]?.parameter_defaults).toEqual([]);
  expect(comparisonLimitations(ordinary, ordinary)).not.toContain(limitation);
});
