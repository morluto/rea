import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect } from "vitest";

import { keyedArchiveResultSchema } from "../../src/domain/apple/keyedArchive.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

const EXACT_INTEGER = { $plist_type: "integer", decimal: "9007199254740993" };
const ROUNDED = 9007199254740992;

/** Accepted decoder representations whose supplemental metadata needs care. */
export const mixedArchiveNumberElements = [
  "<real>9007199254740992<![CDATA[0]]></real>",
  "<real><![CDATA[1]]>9007199254740992</real>",
  "<integer>9007199254740992<!-- split -->3</integer>",
  "<integer>9007199254740992<![CDATA[3]]></integer>",
  "<integer><![CDATA[9007199254740992]]>3</integer>",
  "<integer><![CDATA[9007199254740992&#51;]]></integer>",
  "<integer>9007199254740992<?rea split?>3</integer>",
  "<integer>9007199254740992<string>3</string></integer>",
  "<integer>9007199254740992x</integer>",
] as const;

/** Ordinary dictionaries and malformed numeric references at the same boundary. */
export const archiveNumberMetadataCases = [
  ...mixedArchiveNumberElements.map((element) => ({
    name: element,
    source: { first: "__INTEGER__", other: "__OTHER__" },
    element,
    expected: { first: ROUNDED, other: ROUNDED },
    incomplete: true,
    malformedReference: false,
  })),
  ...(["UID", "CF$UID"] as const).flatMap((key) => [
    {
      name: `${key} dictionary data`,
      source: { [key]: { amount: "__INTEGER__" } },
      element: "",
      expected: { [key]: { amount: EXACT_INTEGER } },
      incomplete: false,
      malformedReference: false,
    },
    {
      name: `${key} array data`,
      source: { [key]: ["__INTEGER__"] },
      element: "",
      expected: { [key]: [EXACT_INTEGER] },
      incomplete: false,
      malformedReference: false,
    },
    {
      name: `${key} malformed numeric reference`,
      source: { [key]: "__INTEGER__" },
      element: "",
      expected: { [key]: ROUNDED },
      incomplete: false,
      malformedReference: true,
    },
  ]),
  {
    name: "entity-encoded integer text",
    source: { amount: "__INTEGER__" },
    element: "",
    expected: { amount: EXACT_INTEGER },
    incomplete: false,
    malformedReference: false,
    integerElement: "<integer>&#57;007199254740993</integer>",
  },
] satisfies readonly {
  name: string;
  source: JsonValue;
  element: string;
  expected: JsonValue;
  incomplete: boolean;
  malformedReference: boolean;
  integerElement?: string;
}[];

type MetadataCase = (typeof archiveNumberMetadataCases)[number];

/** Write one inert archive and retain the original byte digest for assertions. */
export const keyedArchiveNumberMetadataFixture = async (item: MetadataCase) => {
  const root = await createTestTempDirectory("rea-keyed-number-metadata-");
  const xml = build({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: ["$null", item.source],
    $top: { root: { CF$UID: 1 } },
  })
    .replace(
      "<string>__INTEGER__</string>",
      "integerElement" in item
        ? item.integerElement
        : "<integer>9007199254740993</integer>",
    )
    .replace("<string>__OTHER__</string>", item.element);
  const bytes = Buffer.from(xml);
  const path = join(root, "archive.plist");
  await writeFile(path, bytes);
  return {
    root,
    path,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};

/** Require exact ordinary values and honest limitations for incomplete metadata. */
export const expectKeyedArchiveNumberMetadata = (
  value: unknown,
  item: MetadataCase,
  digest: string,
) => {
  const result = keyedArchiveResultSchema.parse(value);
  expect(result.archive_sha256).toBe(digest);
  expect(result.roots).toEqual({ root: { CF$UID: 1 } });
  expect(result.objects).toHaveLength(2);
  expect(result.objects[1]).toMatchObject({
    id: 1,
    kind: "dictionary",
    value: item.expected,
  });
  expect(result.references).toContainEqual({
    source: null,
    path: ["root"],
    target: 1,
    status: "resolved",
    raw: { CF$UID: 1 },
  });
  if (item.incomplete) {
    expect(result.limitations).toContainEqual(
      expect.stringMatching(/metadata.*completely observed.*precision/u),
    );
    expect(
      result.limitations.some((note) => note.includes("unambiguous integer")),
    ).toBe(false);
  } else if (item.malformedReference) {
    expect(result.references).toContainEqual({
      source: 1,
      path: [],
      target: null,
      status: "malformed",
      raw: item.expected,
    });
  } else {
    expect(result.references).toHaveLength(1);
    expect(result.limitations).toContainEqual(
      expect.stringMatching(/^1 unambiguous integer value/u),
    );
  }
};
