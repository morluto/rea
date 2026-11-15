import type { BrowserContext, CDPSession, Page } from "playwright-core";

import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import {
  admitCdpReply,
  assertCdpCommand,
  type CdpCommand,
  type CdpCommandParams,
  type CdpCommandResult,
  type CdpProtocolMethod,
} from "./protocol/CdpCommands.js";
import {
  assertCdpEvent,
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
   * unsubscribe function. A listener that throws fails the session like a
   * protocol error on `CdpConnection`: later events are not delivered and
   * later commands reject with that failure as the cause.
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
): PlaywrightCdpSession => {
  // Playwright emits events from its connection's message callback, so a
  // listener exception must not propagate into it.
  let failure: BrowserObservationError | undefined;
  return {
    send: async (method, params) => {
      if (failure !== undefined) throw failure;
      assertCdpCommand(method, operation);
      return admitCdpReply(
        method,
        // Playwright types each reply by an unchecked cast; the schema decides it.
        await session.send(method satisfies CdpProtocolMethod, params as never),
        operation,
      );
    },
    on: (event, listener) => {
      assertCdpEvent(event, operation);
      const receive = (params: unknown): void => {
        if (failure !== undefined) return;
        const registered = registeredCdpEvent(event, params);
        if (registered?.method !== event) return;
        try {
          listener(registered as CdpRegisteredEventOf<typeof event>);
        } catch (cause: unknown) {
          failure = new BrowserObservationError(operation, "protocol_error", {
            cause,
          });
        }
      };
      session.on(event, receive);
      return () => {
        session.off(event, receive);
      };
    },
    detach: () => session.detach(),
  };
};

/** Attach a registered-command CDP session to one page. */
export const newPlaywrightCdpSession = async (
  context: Pick<BrowserContext, "newCDPSession">,
  page: Page,
  operation: BrowserObservationOperation,
): Promise<PlaywrightCdpSession> =>
  registeredSession(await context.newCDPSession(page), operation);
