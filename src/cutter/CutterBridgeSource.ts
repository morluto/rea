import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CutterBridgeSource } from "../domain/cutterDiscovery.js";

const PACKAGED_PLUGIN = new URL(
  "../../bridge/cutter/rea_bridge.py",
  import.meta.url,
);

/** Packaged plugin path a user copies into Cutter's `plugins/python` directory. */
export const packagedCutterPluginPath = (): string =>
  fileURLToPath(PACKAGED_PLUGIN);

let packagedDigest: string | undefined;

/**
 * SHA-256 of the packaged Cutter plugin bytes. The user copies the plugin into
 * Cutter, so REA compares the digest the running plugin publishes with this
 * one instead of trusting its protocol version alone.
 */
const packagedCutterPluginDigest = (): string => {
  packagedDigest ??= createHash("sha256")
    .update(readFileSync(PACKAGED_PLUGIN))
    .digest("hex");
  return packagedDigest;
};

/**
 * Classify the plugin a session runs. A plugin that publishes no digest
 * predates source identity, so its source is unknown rather than modified.
 */
export const cutterBridgeSource = (
  advertisedSha256: string | null | undefined,
): CutterBridgeSource => {
  if (advertisedSha256 === undefined || advertisedSha256 === null)
    return "unknown";
  return advertisedSha256 === packagedCutterPluginDigest()
    ? "packaged"
    : "modified";
};
