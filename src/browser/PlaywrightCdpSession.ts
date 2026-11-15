import type { BrowserContext, CDPSession, Page } from "playwright-core";

import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import {
  admitCdpReply,
  type CdpCommand,
  type CdpCommandParams,
  type CdpCommandResult,
  type CdpProtocolMethod,
} from "./protocol/CdpCommands.js";

/**
 * A Playwright CDP session that sends only registered commands and admits each
 * reply with its result schema, like `CdpConnection.send`. This module is the
 * only place that opens a raw Playwright CDP session (`rea/no-raw-cdp-session`).
 */
export interface PlaywrightCdpSession {
  send<M extends CdpCommand>(
    method: M,
    params?: CdpCommandParams<M>,
  ): Promise<CdpCommandResult<M>>;
  /** Event payloads stay unknown; each subscriber parses its own events. */
  on(event: string, listener: (params: unknown) => void): void;
  off(event: string, listener: (params: unknown) => void): void;
  detach(): Promise<void>;
}

const registeredSession = (
  session: CDPSession,
  operation: BrowserObservationOperation,
): PlaywrightCdpSession => ({
  send: async (method, params) =>
    admitCdpReply(
      method,
      // Playwright types each reply by an unchecked cast; the schema decides it.
      await session.send(method satisfies CdpProtocolMethod, params as never),
      operation,
    ),
  on: (event, listener) => {
    // Playwright's event names are not exported apart from its overloads.
    session.on(event as never, listener);
  },
  off: (event, listener) => {
    session.off(event as never, listener);
  },
  detach: () => session.detach(),
});

/** Attach a registered-command CDP session to one page. */
export const newPlaywrightCdpSession = async (
  context: Pick<BrowserContext, "newCDPSession">,
  page: Page,
  operation: BrowserObservationOperation,
): Promise<PlaywrightCdpSession> =>
  registeredSession(await context.newCDPSession(page), operation);
