import type { Socket } from "node:net";
import { connectLocalSocketOnce } from "../process/LocalSocketConnection.js";

import {
  hopperCancelledBySignal,
  type HopperCancelledError,
  HopperStartError,
} from "../domain/hopperErrors.js";
import { err, type Result } from "../domain/result.js";

/** Open one abort-aware Hopper Unix-socket connection attempt. */
export const connectHopperSocketOnce = async (
  socketPath: string,
  signal: AbortSignal,
): Promise<Result<Socket, HopperStartError | HopperCancelledError>> => {
  const connected = await connectLocalSocketOnce({ path: socketPath }, signal);
  if (connected.ok) return connected;
  return err(
    connected.error.kind === "cancelled"
      ? hopperCancelledBySignal(signal)
      : new HopperStartError({ cause: connected.error.cause }),
  );
};
