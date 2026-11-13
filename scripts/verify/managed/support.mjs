import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBinaryTarget } from "../../../dist/application/BinaryTargetResolver.js";
import { buildManagedPeFixture } from "../../fixtures/managed/pe.mjs";
import { createManagedConformanceOracleSupport } from "./oracles.mjs";

export const createManagedConformanceSupport = (context) => {
  const fixtureBytes = async (name, bytes) => {
    const path = join(context.workspace, name);
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    return { bytes, path, target: parsed.value };
  };
  const fixture = (name, options) =>
    fixtureBytes(name, buildManagedPeFixture(options));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const base = {
    ...context,
    fixture,
    fixtureBytes,
    sha256,
  };
  return { ...base, ...createManagedConformanceOracleSupport(base) };
};
