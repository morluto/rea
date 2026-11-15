import { readdir } from "node:fs/promises";
import { expect, it } from "vitest";

import { packagedSourcesDigest } from "../filesystem/ProducerIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { GHIDRA_BRIDGE_SOURCES } from "./GhidraBridgeSources.js";
import { ghidraProducerIdentity } from "./GhidraProducerIdentity.js";

const directory = new URL("../../bridge/ghidra/", import.meta.url);

it("lists every packaged Ghidra bridge source", async () => {
  const java = (await readdir(directory)).filter((name) =>
    name.endsWith(".java"),
  );
  expect(Object.values(GHIDRA_BRIDGE_SOURCES).sort()).toEqual(java.sort());
});

it("identifies Ghidra results by the REA release and every bridge source", () => {
  expect(ghidraProducerIdentity()).toEqual({
    rea_version: PRODUCT_IDENTITY.packageVersion,
    sources_sha256: packagedSourcesDigest(
      directory,
      Object.values(GHIDRA_BRIDGE_SOURCES),
    ),
  });
});
