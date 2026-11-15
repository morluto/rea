import type { BrowserContext, CDPSession, Page } from "playwright-core";

import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import {
  admitCdpReply,
  type CdpCommand,
  type CdpCommandParams,
  type CdpCommandResult,
  type CdpProtocolMethod,
} from "./protocol/CdpCommands.js";
import {
  registeredCdpEvent,
  type CdpEventName,
  type CdpRegisteredEventOf,
} from "./protocol/CdpEvents.js";

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
  /**
   * Subscribe to one registered event. Its payload is parsed once by the
   * schema in `protocol/CdpEvents.ts`, as on `CdpConnection`. Returns the
   * unsubscribe function.
   */
  on<E extends CdpEventName>(
    event: E,
    listener: (event: CdpRegisteredEventOf<E>) => void,
  ): () => void;
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
    const receive = (params: unknown): void => {
      const registered = registeredCdpEvent(event, params);
      if (registered?.method === event)
        listener(registered as CdpRegisteredEventOf<typeof event>);
    };
    session.on(event, receive);
    return () => {
      session.off(event, receive);
    };
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
