import {
  jadxBridgeIdentity,
  type JadxBridgeIdentity,
} from "../../src/android/JadxRelease.js";

/** The packaged bridge identity; a test fails if the packaged source is malformed. */
export const packagedJadxBridgeIdentity = (): JadxBridgeIdentity => {
  const identity = jadxBridgeIdentity();
  if (!identity.ok) throw new Error(identity.error);
  return identity.value;
};
