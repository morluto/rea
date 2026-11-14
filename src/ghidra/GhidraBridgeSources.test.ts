import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

import {
  GHIDRA_BRIDGE_SOURCES,
  ghidraBridgeSourcesDigest,
} from "./GhidraBridgeSources.js";

const directory = new URL("../../bridge/ghidra/", import.meta.url);

it("lists every packaged Ghidra bridge source", async () => {
  const java = (await readdir(directory)).filter((name) =>
    name.endsWith(".java"),
  );
  expect(Object.values(GHIDRA_BRIDGE_SOURCES).sort()).toEqual(java.sort());
});

it("commits to the name and bytes of each bridge source", async () => {
  const hash = createHash("sha256");
  for (const name of Object.values(GHIDRA_BRIDGE_SOURCES).sort()) {
    const bytes = await readFile(new URL(name, directory));
    hash.update(JSON.stringify([name, bytes.byteLength])).update(bytes);
  }
  expect(ghidraBridgeSourcesDigest()).toBe(hash.digest("hex"));
});
