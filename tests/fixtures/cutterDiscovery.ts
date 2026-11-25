import {
  cutterDiscoveryLimitations,
  type CutterBridgeDiscovery,
} from "../../src/domain/cutterDiscovery.js";

export const emptyCutterDiscovery = (
  directory = "/private/bridge",
): CutterBridgeDiscovery => ({
  sessions: [],
  bridge_directory: directory,
  discovery_status: "no_live_bridge_found",
  bridge_directory_security: "private_verified",
  limitations: cutterDiscoveryLimitations("no_live_bridge_found"),
});
