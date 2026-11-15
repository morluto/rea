import { err, ok, type Result } from "../domain/result.js";
import {
  CdpMalformedReply,
  type CdpCommand,
  type CdpCommandParams,
  type CdpCommandResult,
} from "./protocol/CdpCommands.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import { CdpConnection } from "./CdpConnection.js";

/** Why an optional command left its section without a reply. */
export type CdpOptionalCommandGap =
  | { readonly _tag: "CdpCommandUnavailable" }
  | { readonly _tag: "CdpMalformedReply"; readonly reply: CdpMalformedReply };

/**
 * Execute an optional CDP method. "Method not found" and a reply that fails
 * its result schema are returned as gaps for the caller's section to record;
 * transport and cancellation failures still propagate.
 */
export const optionalCdpCommand = async <M extends CdpCommand>(
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly signal?: AbortSignal;
  },
  method: M,
  parameters: CdpCommandParams<M>,
  limitations: string[],
): Promise<Result<CdpCommandResult<M>, CdpOptionalCommandGap>> => {
  try {
    return ok(
      await context.connection.send(
        method,
        parameters,
        context.sessionId,
        context.signal,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof CdpMalformedReply) {
      const limitation = `${method} returned a malformed result; the section that reads it is incomplete.`;
      if (!limitations.includes(limitation)) limitations.push(limitation);
      return err({ _tag: "CdpMalformedReply", reply: cause });
    }
    if (!(cause instanceof CdpCommandRejection) || cause.code !== -32_601)
      throw cause;
    limitations.push(`${method} was unavailable from this browser target.`);
    return err({ _tag: "CdpCommandUnavailable" });
  }
};
