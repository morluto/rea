import {
  receiveCdpEvent,
  type CdpConnection,
  type CdpEvent,
} from "../../src/browser/CdpConnection.js";

/**
 * A `CdpConnection.onEvent` fake that delivers raw wire events. Each event is
 * admitted by `receiveCdpEvent`, as the real transport admits it, so a fake
 * cannot hand subscribers a raw or differently shaped event: a change to the
 * received event's shape fails here instead of silently skipping consumers.
 */
export const fakeCdpEvents = (): {
  readonly onEvent: CdpConnection["onEvent"];
  readonly emit: (event: CdpEvent) => void;
  readonly listenerCount: () => number;
} => {
  const listeners = new Set<Parameters<CdpConnection["onEvent"]>[0]>();
  return {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      const received = {
        ...receiveCdpEvent(event),
        wireBytes: Buffer.byteLength(JSON.stringify(event), "utf8"),
      };
      for (const listener of [...listeners]) listener(received);
    },
    listenerCount: () => listeners.size,
  };
};
