import { expect, it } from "vitest";

import {
  IMAGE4_MAX_DEPTH,
  IMAGE4_MAX_ELEMENTS,
  IMAGE4_MAX_NESTED_BYTES,
  IMAGE4_MAX_PROPERTIES,
  IMAGE4_MAX_STRING_BYTES,
} from "../domain/apple/image4.js";
import {
  ia5,
  im4m,
  im4p,
  integer,
  property,
  sequence,
} from "../domain/apple/image4.fixture.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../resources/index.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import { Image4ArtifactReader } from "./Image4ArtifactReader.js";

const read = async (bytes: Buffer) => {
  const reader = new Image4ArtifactReader(
    await createTestTempFile("rea-img4-boundary-", "image.img4", bytes),
  );
  const coverage: ArtifactReaderTraversal[] = [];
  const entries: ArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    return {
      entries,
      coverage: coverage[0],
      metadata: reader.formatMetadata(),
    };
  } finally {
    await reader.close();
  }
};

it("refuses a container cut short as truncated", async () => {
  await expect(read(im4p().subarray(0, 12))).rejects.toMatchObject({
    parseFailure: { kind: "truncated", format: "apple-img4" },
  });
});

it("refuses a high-tag-number form for a low tag number as malformed", async () => {
  await expect(
    read(sequence(ia5("IM4P"), Buffer.from([0x1f, 0x01, 0x00]))),
  ).rejects.toMatchObject({
    parseFailure: { kind: "malformed", format: "apple-img4" },
  });
});

it("refuses the DER depth allowance", async () => {
  let inner = sequence();
  for (let count = 0; count < IMAGE4_MAX_DEPTH + 1; count += 1)
    inner = sequence(inner);
  await expect(read(sequence(ia5("IM4P"), inner))).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Image4 DER depth allowance",
      limit: IMAGE4_MAX_DEPTH,
      unit: "levels",
    },
  });
});

it("refuses the DER element allowance", async () => {
  const empties = Buffer.alloc(IMAGE4_MAX_ELEMENTS * 2);
  for (let index = 0; index < IMAGE4_MAX_ELEMENTS; index += 1) {
    empties[index * 2] = 0x30;
    empties[index * 2 + 1] = 0;
  }
  await expect(read(sequence(ia5("IM4P"), empties))).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Image4 DER element allowance",
      limit: IMAGE4_MAX_ELEMENTS,
      unit: "elements",
    },
  });
});

it("refuses the property allowance", async () => {
  const properties = Array.from(
    { length: IMAGE4_MAX_PROPERTIES + 1 },
    (_, index) => property(`P${String(index).padStart(3, "0")}`, integer(1)),
  );
  await expect(read(im4m({ properties }))).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
    fixedAllowance: {
      name: "The Image4 property allowance",
      limit: IMAGE4_MAX_PROPERTIES,
      unit: "properties",
    },
  });
});

it("refuses the string allowance", async () => {
  await expect(
    read(im4p({ description: "A".repeat(IMAGE4_MAX_STRING_BYTES + 1) })),
  ).rejects.toMatchObject({
    reason: "limit",
    boundary: "memory",
    fixedAllowance: {
      name: "The Image4 string allowance",
      limit: IMAGE4_MAX_STRING_BYTES,
      unit: "bytes",
    },
  });
});

it("keeps indefinite length and trailing bytes as coverage limitations", async () => {
  const indefinite = await read(im4p({ indefinite: true }));
  expect(indefinite.entries.map((entry) => entry.path)).toContain("payload");
  expect(indefinite.coverage).toMatchObject({
    status: "unknown",
    limitations: [expect.stringContaining("indefinite length")],
  });

  const trailing = await read(Buffer.concat([im4p(), Buffer.from([1, 2, 3])]));
  expect(trailing.coverage).toMatchObject({
    status: "unknown",
    limitations: [expect.stringContaining("trailing bytes")],
  });
});

it("stops an indefinite value that is not bounded by the nested parse", async () => {
  const body = Buffer.concat([
    ia5("IM4P"),
    Buffer.alloc(IMAGE4_MAX_NESTED_BYTES),
  ]);
  const bytes = Buffer.concat([Buffer.from([0x30, 0x80]), body]);
  const result = await read(bytes);
  expect(result.entries).toEqual([]);
  expect(result.coverage).toMatchObject({
    status: "unknown",
    limitations: [expect.stringContaining("indefinite length")],
  });
  expect(result.metadata).toMatchObject({
    trailing_bytes: null,
    payload: null,
    manifest: null,
  });
});
