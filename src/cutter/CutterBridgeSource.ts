import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { CutterBridgeSource } from "../domain/cutterDiscovery.js";

const PACKAGED_PLUGIN = new URL(
  "../../bridge/cutter/rea_bridge.py",
  import.meta.url,
);

/** Packaged plugin path a user copies into Cutter's `plugins/python` directory. */
export const packagedCutterPluginPath = (plugin = PACKAGED_PLUGIN): string =>
  fileURLToPath(plugin);

const packagedDigests = new Map<string, string>();

/**
 * SHA-256 of the packaged Cutter plugin bytes. The user copies the plugin into
 * Cutter, so REA compares the digest the running plugin publishes with this
 * one instead of trusting its protocol version alone. An unreadable packaged
 * plugin is a broken REA installation, reported as such rather than hiding
 * the live session that asked for the comparison.
 */
const packagedCutterPluginDigest = (operation: string, plugin: URL): string => {
  const cached = packagedDigests.get(plugin.href);
  if (cached !== undefined) return cached;
  let bytes: Buffer;
  try {
    bytes = readFileSync(plugin);
  } catch (cause: unknown) {
    const remediation = `Reinstall REA so ${packagedCutterPluginPath(plugin)} is present and readable, then retry. REA could not compare the running Cutter plugin with it, and no command was sent.`;
    throw new AnalysisCapabilityUnavailableError(
      "cutter",
      operation,
      "REA's packaged Cutter plugin could not be read, so the running plugin's source cannot be identified.",
      { cause, remediationAction: remediation, userMessage: remediation },
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  packagedDigests.set(plugin.href, digest);
  return digest;
};

/**
 * Classify the plugin a session runs. A plugin that publishes no digest
 * predates source identity, so its source is unknown rather than modified.
 */
export const cutterBridgeSource = (
  advertisedSha256: string | null | undefined,
  operation: string,
  plugin = PACKAGED_PLUGIN,
): CutterBridgeSource => {
  if (advertisedSha256 === undefined || advertisedSha256 === null)
    return "unknown";
  return advertisedSha256 === packagedCutterPluginDigest(operation, plugin)
    ? "packaged"
    : "modified";
};
