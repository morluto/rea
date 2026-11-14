import type { CDPSession } from "playwright-core";
import type { z } from "zod";

import { BrowserObservationError } from "../../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  cdpFrameTreeReplySchema,
  cdpResourceTreeReplySchema,
} from "./CdpFrameTree.js";

// Playwright ships the generated Chrome DevTools Protocol command table. Its
// names and parameter types are reused; its result types are unchecked casts,
// so REA validates each reply with its own schema below.
declare const protocolSend: CDPSession["send"];

/** Every command name in the protocol version Playwright ships. */
export type CdpProtocolMethod = Parameters<CDPSession["send"]>[0];

/**
 * One result schema per command REA sends. Each schema is the only reader of
 * that command's raw reply; consumers receive its parsed output.
 */
const CDP_COMMAND_REPLIES = {
  "Page.getFrameTree": cdpFrameTreeReplySchema,
  "Page.getResourceTree": cdpResourceTreeReplySchema,
} as const satisfies { readonly [M in CdpProtocolMethod]?: z.ZodType };

export type CdpCommand = keyof typeof CDP_COMMAND_REPLIES;

export type CdpCommandParams<M extends CdpCommand> = NonNullable<
  Parameters<typeof protocolSend<M>>[1]
>;

export type CdpCommandResult<M extends CdpCommand> = z.output<
  (typeof CDP_COMMAND_REPLIES)[M]
>;

/**
 * Parameters a send accepts: the protocol's for a registered command, an
 * untyped record for a method that has no result schema yet.
 */
export type CdpSendParams<M extends string> = M extends CdpCommand
  ? CdpCommandParams<M>
  : Readonly<Record<string, unknown>>;

/**
 * A registered command resolves to its parsed result. Any other method is the
 * raw reply, which the untyped-command guard baseline counts.
 */
export type CdpSendResult<M extends string> = M extends CdpCommand
  ? CdpCommandResult<M>
  : unknown;

export const isCdpCommand = (method: string): method is CdpCommand =>
  Object.hasOwn(CDP_COMMAND_REPLIES, method);

/** A well-formed JSON-RPC reply whose result does not match the command's schema. */
export interface CdpMalformedReplyFacts {
  readonly command: CdpCommand;
  /** RFC 6901 pointer to the first rejected member of `result`. */
  readonly pointer: string;
  readonly issue: string;
}

/** A command-level protocol failure; the connection itself stays usable. */
export class CdpMalformedReply extends BrowserObservationError {
  readonly command: CdpCommand;
  readonly pointer: string;

  constructor(
    operation: BrowserObservationOperation,
    facts: CdpMalformedReplyFacts,
  ) {
    super(operation, "protocol_error", {
      detail: `CDP ${facts.command} returned a malformed result at ${facts.pointer === "" ? "/" : facts.pointer}: ${facts.issue}`,
    });
    this.command = facts.command;
    this.pointer = facts.pointer;
  }
}

const jsonPointer = (path: readonly PropertyKey[]): string =>
  path
    .map(
      (segment) =>
        `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`,
    )
    .join("");

/** Parse one raw reply with its command's schema. Issue text never quotes producer values. */
export const parseCdpCommandResult = <M extends CdpCommand>(
  command: M,
  value: unknown,
): Result<CdpCommandResult<M>, CdpMalformedReplyFacts> => {
  const schema: z.ZodType = CDP_COMMAND_REPLIES[command];
  const parsed = schema.safeParse(value) as z.ZodSafeParseResult<
    CdpCommandResult<M>
  >;
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  return err({
    command,
    pointer: jsonPointer(issue?.path ?? []),
    issue: issue?.message ?? "The result did not match its protocol schema.",
  });
};

/**
 * Admit one command reply at a transport boundary: `CdpConnection` and the
 * Playwright CDP sessions both call this. A registered command's reply is
 * parsed or rejected; any other reply is returned raw.
 */
export const admitCdpReply = <M extends string>(
  method: M,
  reply: unknown,
  operation: BrowserObservationOperation,
): CdpSendResult<M> => {
  if (!isCdpCommand(method)) return reply as CdpSendResult<M>;
  const parsed = parseCdpCommandResult(method, reply);
  if (!parsed.ok) throw new CdpMalformedReply(operation, parsed.error);
  return parsed.value as CdpSendResult<M>;
};
