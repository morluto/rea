import type { CdpConnection } from "../../src/browser/CdpConnection.js";
import { admitCdpReply } from "../../src/browser/protocol/CdpCommands.js";

type RawCdpReply = (
  method: string,
  params: Readonly<Record<string, unknown>>,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
) => unknown;

/**
 * A `CdpConnection.send` fake that answers with raw wire results. Registered
 * commands are admitted by their result schemas exactly as the real connection
 * admits them, so a fake cannot hand consumers an unparsed reply.
 */
export const fakeCdpSend = (reply: RawCdpReply): CdpConnection["send"] =>
  (async (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    signal?: AbortSignal,
  ) =>
    admitCdpReply(
      method,
      await reply(method, params ?? {}, sessionId, signal),
      "inspect_web_page",
    )) as CdpConnection["send"];

/** Parse a raw `Page.getFrameTree` wire result as the connection would. */
export const frameTreeReply = (raw: unknown) =>
  admitCdpReply("Page.getFrameTree", raw, "inspect_web_page");

/** Parse a raw `Page.getResourceTree` wire result as the connection would. */
export const resourceTreeReply = (raw: unknown) =>
  admitCdpReply("Page.getResourceTree", raw, "inspect_web_page");
