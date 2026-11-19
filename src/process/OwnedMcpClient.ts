import { Client } from "@modelcontextprotocol/client";

/** Observe SDK-initiated close failures while keeping them available to callers. */
export class OwnedMcpClient extends Client {
  override close(): Promise<void> {
    const closing = super.close();
    // The SDK starts close without awaiting it after a legacy handshake fails.
    // The transport owner still receives the original failure when it joins cleanup.
    void closing.catch(() => undefined);
    return closing;
  }
}
