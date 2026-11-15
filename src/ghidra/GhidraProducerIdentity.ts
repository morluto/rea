import { packagedProducerIdentity } from "../filesystem/ProducerIdentity.js";
import { GHIDRA_BRIDGE_SOURCES } from "./GhidraBridgeSources.js";

/**
 * The REA release and packaged bridge sources behind every Ghidra result.
 * Analysis profiles commit to it, so an edited bridge script or a new REA
 * release yields a new profile digest and earlier snapshots are not reused.
 */
export const ghidraProducerIdentity = packagedProducerIdentity(
  new URL("../../bridge/ghidra/", import.meta.url),
  Object.values(GHIDRA_BRIDGE_SOURCES),
);
