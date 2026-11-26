import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";

import {
  artifactPreparationRecoveryCases,
  artifactReaderLifecycleCases,
} from "../../tests/fixtures/artifactReaderLifecycle.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { MacosPkgArtifactReader } from "./MacosPkgArtifactReader.js";
import {
  buildComponentPackage,
  buildProductArchive,
  truncatedPkgHeader,
} from "./macosPkg/MacosPkg.fixture.js";

const fixture = async (
  bytes: Buffer,
  name = "fixture.pkg",
): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-macos-pkg-boundary-"),
    name,
  );
  await writeFile(path, bytes);
  return path;
};

const entries = async (reader: MacosPkgArtifactReader) => {
  const result = [];
  for await (const entry of reader.entries()) result.push(entry);
  return result;
};

it("rejects a source changed after inventory was prepared", async () => {
  const bytes = buildProductArchive();
  const path = await fixture(bytes);
  const reader = new MacosPkgArtifactReader(path);
  try {
    const listed = await entries(reader);
    const file = listed.find((entry) => entry.path === "Distribution");
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0])]));
    await expect(reader.open(file!)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});

it("does not treat a truncated header as a hard reader crash", async () => {
  const reader = new MacosPkgArtifactReader(
    await fixture(truncatedPkgHeader(), "truncated.pkg"),
  );
  try {
    const listed = await entries(reader);
    expect(listed).toEqual([]);
    expect(reader.formatMetadata()?.refusals[0]?.code).toBe("truncated-header");
  } finally {
    await reader.close();
  }
});

it("reopens a payload member after a cancelled stream", async () => {
  const path = await fixture(buildProductArchive());
  const reader = new MacosPkgArtifactReader(path);
  try {
    const listed = await entries(reader);
    const hello = listed.find(
      (entry) => entry.path === "Component.pkg/Payload/usr/local/rea/hello.txt",
    );
    const controller = new AbortController();
    const reason = new Error("cancel member bytes");
    const stream = await reader.open(hello!, controller.signal);
    controller.abort(reason);
    await expect(buffer(stream)).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect((await buffer(await reader.open(hello!))).toString("utf8")).toBe(
      "hello from payload\n",
    );
  } finally {
    await reader.close();
  }
});

// The lifecycle cases open the first entry, so their image starts with a
// heap-backed member rather than a TOC directory record.
artifactReaderLifecycleCases({
  image: () => buildComponentPackage(),
  createReader: (path, admitted) => new MacosPkgArtifactReader(path, admitted),
});

artifactPreparationRecoveryCases({
  image: () => buildComponentPackage(),
  createReader: (path, admitted) => new MacosPkgArtifactReader(path, admitted),
});
