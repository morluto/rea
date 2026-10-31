import { expect, it } from "vitest";
import {
  decodeElfDynamicFlags,
  derivedElfVersionMaxima,
  DF_1_FLAG_BITS,
  DF_FLAG_BITS,
  elfSearchPathTokens,
  inspectElfDependenciesInputSchema,
  splitElfSearchPath,
} from "./elfDependencies.js";

it("rejects extra caller arguments and applies dependency budgets", () => {
  expect(
    inspectElfDependenciesInputSchema.safeParse({
      path: "/artifacts/program",
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    inspectElfDependenciesInputSchema.parse({ path: "/artifacts/program" }),
  ).toMatchObject({
    max_file_bytes: 67108864,
    max_needed: 1024,
    max_versions: 4096,
    max_imports: 65536,
  });
});

it("splits search paths without dropping empty entries and reports tokens as written", () => {
  expect(splitElfSearchPath("$ORIGIN/../lib:$LIB:${PLATFORM}/lib:")).toEqual([
    "$ORIGIN/../lib",
    "$LIB",
    "${PLATFORM}/lib",
    "",
  ]);
  expect(
    elfSearchPathTokens("$ORIGIN/../lib:$LIB:${PLATFORM}/lib:$ORIGIN"),
  ).toEqual(["$ORIGIN", "$LIB", "$PLATFORM"]);
  expect(elfSearchPathTokens("/usr/lib")).toEqual([]);
});

it("derives the highest GNU-style NAME_x.y string per namespace", () => {
  expect(
    derivedElfVersionMaxima([
      "GLIBC_2.2.5",
      "GLIBC_2.34",
      "GLIBCXX_3.4.29",
      "not-a-version",
    ]),
  ).toEqual([
    { namespace: "GLIBC", maximum: "GLIBC_2.34", evidence_kind: "derived" },
    {
      namespace: "GLIBCXX",
      maximum: "GLIBCXX_3.4.29",
      evidence_kind: "derived",
    },
  ]);
});

it("compares large version components exactly and skips empty namespaces", () => {
  expect(
    derivedElfVersionMaxima([
      "LIB_9007199254740993",
      "LIB_9007199254740992",
      "LIB_9007199254740994",
      "_2.5",
    ]),
  ).toEqual([
    {
      namespace: "LIB",
      maximum: "LIB_9007199254740994",
      evidence_kind: "derived",
    },
  ]);
  expect(
    derivedElfVersionMaxima(["LIB_9007199254740992", "LIB_9007199254740993"]),
  ).toEqual([
    {
      namespace: "LIB",
      maximum: "LIB_9007199254740993",
      evidence_kind: "derived",
    },
  ]);
});

it("decodes named DT_FLAGS and DT_FLAGS_1 bits without expanding unrecognized values", () => {
  expect(decodeElfDynamicFlags(0x9, DF_FLAG_BITS)).toEqual({
    raw: 0x9,
    names: ["ORIGIN", "BIND_NOW"],
    unrecognized: 0,
  });
  expect(decodeElfDynamicFlags(0x08000881, DF_1_FLAG_BITS)).toEqual({
    raw: 0x08000881,
    names: ["NOW", "ORIGIN", "NODEFLIB", "PIE"],
    unrecognized: 0,
  });
  expect(decodeElfDynamicFlags(0x80000008, DF_FLAG_BITS)).toEqual({
    raw: 0x80000008,
    names: ["BIND_NOW"],
    unrecognized: 0x80000000,
  });
  expect(decodeElfDynamicFlags(0x100000008, DF_FLAG_BITS)).toEqual({
    raw: 0x100000008,
    names: ["BIND_NOW"],
    unrecognized: 0x100000000,
  });
});
