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
  it("binds the release and every source in canonical name order", async () => {
    const directory = await sources({ "a.java": "one", "b.py": "two" });
    const original = packagedProducerIdentity(directory, ["b.py", "a.java"])();
    expect(original).toEqual({
      rea_version: PRODUCT_IDENTITY.packageVersion,
      sources_sha256:
        "36a70f4afc72128b1276d83321de8fba924bd1b5988b0bf8944b7b8481093126",
    });
    await writeFile(new URL("b.py", directory), "two, edited");
    expect(
      packagedProducerIdentity(directory, ["a.java", "b.py"])().sources_sha256,
    ).not.toBe(original.sources_sha256);
  });

  it("frames each source by name and length so bytes cannot move between files", async () => {
    const left = await sources({ "a.java": "ab", "b.py": "c" });
    const right = await sources({ "a.java": "a", "b.py": "bc" });
    expect(packagedSourcesDigest(left, ["a.java", "b.py"])).not.toBe(
      packagedSourcesDigest(right, ["a.java", "b.py"]),
    );
  });

  it("refuses an identity when a declared source is not packaged", async () => {
    const directory = await sources({ "a.java": "one" });
    expect(() =>
      packagedSourcesDigest(directory, ["a.java", "missing.py"]),
    ).toThrow(/ENOENT/u);
  });
});
