import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBinaryTarget } from "#dist/application/BinaryTargetResolver.js";
import { buildManagedPeFixture } from "../../fixtures/managed/pe.mjs";
import { createManagedConformanceOracleSupport } from "./oracles.mjs";

/** @typedef {import("../../fixtures/managed/pe.mjs").ManagedPeFixtureOptions} ManagedPeFixtureOptions */

/**
 * Fixture writers and oracles for one conformance workspace.
 * @param {{ readonly workspace: string; readonly defaultIlBody: Buffer }} context
 */
export const createManagedConformanceSupport = (context) => {
  /**
   * Write bytes into the workspace and resolve them as a binary target.
   * @param {string} name
   * @param {Buffer} bytes
   */
  const fixtureBytes = async (name, bytes) => {
    const path = join(context.workspace, name);
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    if (!parsed.ok) throw parsed.error;
    return { bytes, path, target: parsed.value };
  };
  /**
   * @param {string} name
   * @param {ManagedPeFixtureOptions} options
   */
  const fixture = (name, options) =>
    fixtureBytes(name, buildManagedPeFixture(options));
  /** @param {Buffer} bytes */
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const base = {
    ...context,
    fixture,
    fixtureBytes,
    sha256,
  };
  return { ...base, ...createManagedConformanceOracleSupport(base) };
};
