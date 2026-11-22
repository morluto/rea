import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { CutterBridgeSource } from "../domain/cutterDiscovery.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const PACKAGED_PLUGIN = fileURLToPath(
  new URL("../../bridge/cutter/rea_bridge.py", import.meta.url),
);

/**
 * What to do when a session does not run the packaged plugin. A plugin with
 * no published digest still runs, but REA cannot tell which source it is.
 */
export const cutterBridgeSourceRecovery = (
  source: CutterBridgeSource,
): string | undefined => {
  if (source === "packaged") return undefined;
  const recopy = `Copy ${PACKAGED_PLUGIN} into Cutter's plugins/python directory, restart Cutter, and list sessions again.`;
  return source === "unknown"
    ? `The running plugin publishes no SHA-256, so its source is unknown. ${recopy}`
    : recopy;
};

let packagedDigest: string | undefined;

/**
 * SHA-256 of the packaged Cutter plugin bytes. The user copies the plugin into
 * Cutter, so REA compares the digest the running plugin publishes with this
 * one instead of trusting its protocol version alone. An unreadable packaged
 * plugin is a broken REA installation, reported as such rather than hiding
 * the live session that asked for the comparison.
 */
const packagedCutterPluginDigest = (operation: string): string => {
  if (packagedDigest !== undefined) return packagedDigest;
  let bytes: Buffer;
  try {
    bytes = readFileSync(PACKAGED_PLUGIN);
  } catch (cause: unknown) {
    const remediation = `Reinstall REA so ${PACKAGED_PLUGIN} is present and readable, then retry. REA could not compare the running Cutter plugin with it, and no command was sent.`;
    throw new AnalysisCapabilityUnavailableError(
      "cutter",
      operation,
      "REA's packaged Cutter plugin could not be read, so the running plugin's source cannot be identified.",
      { cause, remediationAction: remediation, userMessage: remediation },
    );
  }
  packagedDigest = sha256Hex(bytes);
  return packagedDigest;
};

/**
 * Classify the plugin a session runs. A plugin that publishes no digest
 * predates source identity, so its source is unknown rather than modified.
 */
export const cutterBridgeSource = (
  advertisedSha256: string | null | undefined,
  operation: string,
): CutterBridgeSource => {
  if (advertisedSha256 === undefined || advertisedSha256 === null)
    return "unknown";
  return advertisedSha256 === packagedCutterPluginDigest(operation)
    ? "packaged"
    : "modified";
};
