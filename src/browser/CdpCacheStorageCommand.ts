import { err, type Result } from "../domain/result.js";
import {
  CdpCommandRejection,
  isCdpSessionGoneRejection,
} from "./CdpCommandRejection.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  optionalCdpCommand,
  type CdpOptionalCommandGap,
} from "./CdpOptionalCommand.js";
import type {
  CdpCommandParams,
  CdpCommandResult,
} from "./protocol/CdpCommands.js";

export type CacheStorageReadCommand =
  | "CacheStorage.requestEntries"
  | "CacheStorage.requestCachedResponse";

export interface CacheStorageCommandContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly signal?: AbortSignal;
  readonly unavailableCacheCommands: Set<CacheStorageReadCommand>;
}

type CacheStorageCommandGap =
  | CdpOptionalCommandGap
  | { readonly _tag: "CdpCacheReadUnavailable" };

export const cacheStorageCommand = async <M extends CacheStorageReadCommand>(
  context: CacheStorageCommandContext,
  method: M,
  parameters: CdpCommandParams<M>,
  limitations: string[],
): Promise<Result<CdpCommandResult<M>, CacheStorageCommandGap>> => {
  context.signal?.throwIfAborted();
  if (context.unavailableCacheCommands.has(method))
    return err({ _tag: "CdpCommandUnavailable" });
  try {
    const reply = await optionalCdpCommand(
      context,
      method,
      parameters,
      limitations,
    );
    if (!reply.ok && reply.error._tag === "CdpCommandUnavailable")
      context.unavailableCacheCommands.add(method);
    return reply;
  } catch (cause: unknown) {
    if (
      !(cause instanceof CdpCommandRejection) ||
      cause.command !== method ||
      cause.code !== -32_000 ||
      cause.reportedMessage === null ||
      isCdpSessionGoneRejection(cause)
    )
      throw cause;
    const limitation = `${method} rejected a cache read; retained storage facts are partial. Retry the capture to inspect the current caches.`;
    if (!limitations.includes(limitation)) limitations.push(limitation);
    return err({ _tag: "CdpCacheReadUnavailable" });
  }
};
