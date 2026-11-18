import { packagedProducerIdentity } from "../filesystem/ProducerIdentity.js";

const BRIDGE_DIRECTORY = new URL("../../bridge/", import.meta.url);
const BRIDGE_SCRIPT = "hopper_bridge.py";

/** The packaged Python bridge Hopper runs for every REA operation. */
export const HOPPER_BRIDGE_SCRIPT_URL = new URL(
  BRIDGE_SCRIPT,
  BRIDGE_DIRECTORY,
);

/**
 * The REA release and bridge script behind every Hopper result. Analysis
 * profiles commit to it, so an edited bridge or a new REA release yields a new
 * profile digest and earlier snapshots are not reused.
 */
export const hopperProducerIdentity = packagedProducerIdentity(
  BRIDGE_DIRECTORY,
  [BRIDGE_SCRIPT],
);
