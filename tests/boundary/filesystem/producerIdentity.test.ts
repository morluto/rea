import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import {
  packagedProducerIdentity,
  packagedSourcesDigest,
} from "../../../src/filesystem/ProducerIdentity.js";

const sources = async (files: Readonly<Record<string, string>>) => {
  const root = await createTestTempDirectory("rea-producer-");
  for (const [name, text] of Object.entries(files))
    await writeFile(join(root, name), text);
  return pathToFileURL(`${root}/`);
};

describe("packaged producer identity", () => {
  it("changes when a producer script changes, without a revision marker", async () => {
    const directory = await sources({ "a.java": "one", "b.py": "two" });
    const before = packagedSourcesDigest(directory, ["a.java", "b.py"]);
    await writeFile(new URL("b.py", directory), "two, edited");
    expect(packagedSourcesDigest(directory, ["a.java", "b.py"])).not.toBe(
      before,
    );
  });

  it("frames each source by name and length so bytes cannot move between files", async () => {
    const left = await sources({ "a.java": "ab", "b.py": "c" });
    const right = await sources({ "a.java": "a", "b.py": "bc" });
    expect(packagedSourcesDigest(left, ["a.java", "b.py"])).not.toBe(
      packagedSourcesDigest(right, ["a.java", "b.py"]),
    );
  });

  it("does not depend on the order sources are listed in", async () => {
    const directory = await sources({ "a.java": "one", "b.py": "two" });
    expect(packagedSourcesDigest(directory, ["b.py", "a.java"])).toBe(
      packagedSourcesDigest(directory, ["a.java", "b.py"]),
    );
  });

  it("refuses an identity when a declared source is not packaged", async () => {
    const directory = await sources({ "a.java": "one" });
    expect(() =>
      packagedSourcesDigest(directory, ["a.java", "missing.py"]),
    ).toThrow(/ENOENT/u);
  });

  it("commits the REA release beside the source digest", async () => {
    const directory = await sources({ "a.java": "one" });
    expect(packagedProducerIdentity(directory, ["a.java"])()).toEqual({
      rea_version: PRODUCT_IDENTITY.packageVersion,
      sources_sha256: packagedSourcesDigest(directory, ["a.java"]),
    });
  });
});
