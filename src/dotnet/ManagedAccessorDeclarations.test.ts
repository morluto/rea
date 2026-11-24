import { expect, it } from "vitest";

import { managedMemberInspectionSchema } from "../domain/managed/managedArtifact.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import {
  buildManagedAccessorFixture,
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const inspect = (
  bytes: Buffer,
  options: Parameters<typeof inspectManagedMembersBytes>[2] = {},
) => inspectManagedMembersBytes(bytes, managedPeFixtureTarget(bytes), options);

it("links methods by MethodSemantics rows rather than accessor-name prefixes", () => {
  const result = inspect(buildManagedAccessorFixture());
  expect(result.accessors?.state).toBe("complete");
  expect(result.accessors?.declarations).toMatchObject([
    {
      token: "0x18000001",
      semantics_flags: 2,
      roles: ["getter"],
      method_token: "0x06000001",
      method_name: "Read",
      method_declaring_type: "Example.Widget",
      association_raw: 3,
      association_kind: "property",
      association_token: "0x17000001",
      association_name: "Value",
    },
    {
      token: "0x18000002",
      semantics_flags: 1,
      roles: ["setter"],
      method_name: "Write",
      association_name: "Value",
    },
    {
      token: "0x18000003",
      semantics_flags: 8,
      roles: ["adder"],
      method_name: "Attach",
      association_kind: "event",
      association_name: "Changed",
    },
    {
      token: "0x18000004",
      semantics_flags: 16,
      roles: ["remover"],
      method_name: "Detach",
      association_name: "Changed",
    },
  ]);
  expect(result.methods.map(({ name }) => name)).toEqual([
    "Read",
    "Write",
    "Attach",
    "Detach",
  ]);
  expect(
    result.accessors?.declarations.every(({ row_offset }) => row_offset > 0),
  ).toBe(true);
});

it("restricts relationships to the inspected MethodDef page and declaring types", () => {
  const bytes = buildManagedAccessorFixture();
  expect(
    inspect(bytes, {
      typeNames: ["Example.Widget"],
      methodOffset: 1,
      methodLimit: 2,
    }).accessors?.declarations.map(({ method_token }) => method_token),
  ).toEqual(["0x06000002"]);
  expect(inspect(bytes, { methodLimit: 0 }).accessors).toMatchObject({
    state: "complete",
    declarations: [],
  });
});

it("uses physical tokens when MethodPtr reorders the declaring-type lists", () => {
  const bytes = buildManagedAccessorFixture({ methodPointers: [3, 4, 1, 2] });
  const result = inspect(bytes, { typeNames: ["Example.Other"] });
  expect(result.accessors?.declarations).toMatchObject([
    {
      method_token: "0x06000001",
      method_name: "Read",
      method_declaring_type: "Example.Other",
      association_name: "Value",
    },
    {
      method_token: "0x06000002",
      method_name: "Write",
      method_declaring_type: "Example.Other",
      association_name: "Value",
    },
  ]);
});

it("preserves duplicate declarations and every original semantics flag", () => {
  const result = inspect(
    buildManagedAccessorFixture({
      semantics: [
        [4, 1, 3],
        [4, 1, 3],
        [0x8002, 1, 3],
        [32, 3, 2],
      ],
    }),
  );
  expect(
    result.accessors?.declarations.map(
      ({ semantics_flags }) => semantics_flags,
    ),
  ).toEqual([4, 4, 0x8002, 32]);
  expect(result.accessors?.declarations.map(({ roles }) => roles)).toEqual([
    ["other"],
    ["other"],
    ["getter"],
    ["raiser"],
  ]);
  expect(result.accessors?.state).toBe("partial");
  expect(
    result.accessors?.issues.some(({ detail }) => /0x8002/u.test(detail)),
  ).toBe(true);
});

it.each([0, 4, 5])(
  "retains an unresolved association raw coordinate %i",
  (association) => {
    const result = inspect(
      buildManagedAccessorFixture({
        semantics: [
          [2, 1, association],
          [1, 2, 3],
        ],
      }),
    );
    expect(result.accessors).toMatchObject({
      state: "partial",
      declarations: [
        {
          association_raw: association,
          association_token: null,
          association_name: null,
        },
        { association_token: "0x17000001", association_name: "Value" },
      ],
    });
    expect(result.coverage.state).toBe("complete");
  },
);

it("distinguishes an examined empty table from historical evidence without this facet", () => {
  const result = inspect(buildManagedPeFixture());
  expect(result.accessors).toEqual({
    state: "complete",
    declarations: [],
    issues: [],
  });
  const { accessors, ...historical } = result;
  expect(accessors).not.toBeNull();
  expect(managedMemberInspectionSchema.parse(historical)).not.toHaveProperty(
    "accessors",
  );
});

it("keeps admitted member facts when accessor representation capacity is exhausted", () => {
  const bytes = buildManagedAccessorFixture({
    semantics: Array.from({ length: 1200 }, () => [2, 1, 3] as const),
  });
  const result = inspect(bytes, { maxRepresentationBytes: 48000 });
  expect(result.methods).toHaveLength(4);
  expect(result.signature_resolution).toBe("type-names-v2");
  expect(result.accessors?.state).toBe("partial");
  expect(result.accessors?.issues).toContainEqual(
    expect.objectContaining({ code: "resource-limit" }),
  );
});

it("skips unrelated relationship heaps before charging a selected-method representation", () => {
  const bytes = buildManagedAccessorFixture({
    semantics: Array.from({ length: 1200 }, () => [8, 3, 2] as const),
    eventName: "x".repeat(4000),
  });
  const result = inspect(bytes, {
    typeNames: ["Example.Widget"],
    maxRepresentationBytes: 48000,
  });
  expect(result.methods).toHaveLength(2);
  expect(result.accessors).toEqual({
    state: "complete",
    declarations: [],
    issues: [],
  });
});

it.each([0, 5])(
  "reports invalid Method row %i without damaging independent member facts",
  (method) => {
    const result = inspect(
      buildManagedAccessorFixture({
        semantics: [
          [2, method, 3],
          [1, 2, 3],
        ],
      }),
    );
    expect(result.accessors?.state).toBe("partial");
    expect(result.accessors?.declarations).toHaveLength(1);
    expect(result.accessors?.issues[0]?.detail).toContain(
      `Method row ${method}`,
    );
    expect(result.methods).toHaveLength(4);
    expect(result.coverage.state).toBe("complete");
  },
);

it("keeps an unreadable associated name unknown while retaining its raw row", () => {
  const result = inspect(buildManagedAccessorFixture({ propertyName: "" }));
  expect(result.accessors?.state).toBe("partial");
  expect(result.accessors?.declarations[0]).toMatchObject({
    association_token: "0x17000001",
    association_name: null,
    association_flags: 0,
  });
  expect(
    result.accessors?.declarations[0]?.association_row_offset,
  ).toBeGreaterThan(0);
  expect(result.accessors?.declarations[2]?.association_name).toBe("Changed");
});

it("reads a shared unterminated association name once without dropping declarations", () => {
  const result = inspect(
    buildManagedAccessorFixture({
      propertyName: "x".repeat(4000),
      unterminatedPropertyName: true,
      semantics: Array.from({ length: 64 }, () => [2, 1, 3] as const),
    }),
  );
  expect(result.coverage.state).toBe("complete");
  expect(result.accessors?.state).toBe("partial");
  expect(result.accessors?.declarations).toHaveLength(64);
  expect(
    result.accessors?.declarations.every(
      ({ association_name, association_token }) =>
        association_name === null && association_token === "0x17000001",
    ),
  ).toBe(true);
  expect(result.accessors?.issues).toEqual([
    expect.objectContaining({
      code: "invalid-string",
      scope: "metadata.#Strings",
    }),
  ]);
});
