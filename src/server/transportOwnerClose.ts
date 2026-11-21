import type { Transport } from "@modelcontextprotocol/server";

/**
 * Transports their owner closed. An owner that closes the underlying transport
 * itself, rather than through the server's `close()`, marks it first, so the
 * Evidence transport reports pending work as ended by an owner close and not
 * by a client disconnect.
 */
const ownerClosedTransports = new WeakSet<Transport>();

/** Record that the owner, not the client, is closing this transport. */
export const markTransportOwnerClose = (transport: Transport): void => {
  ownerClosedTransports.add(transport);
};

/** Whether the owner closed this transport. */
export const transportClosedByOwner = (transport: Transport): boolean =>
  ownerClosedTransports.has(transport);
