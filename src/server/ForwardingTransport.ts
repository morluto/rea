import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";

/**
 * A Transport that wraps another and forwards every member of the SDK
 * contract. Subclasses override only the hooks they observe, so a wrapper can
 * never silently drop session, protocol-version or stream facts.
 */
export abstract class ForwardingTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  readonly hasPerRequestStream?: boolean;

  constructor(protected readonly transport: Transport) {
    if (transport.hasPerRequestStream !== undefined)
      this.hasPerRequestStream = transport.hasPerRequestStream;
    transport.onmessage = (message, extra) => this.receive(message, extra);
    transport.onerror = (error) => this.onerror?.(error);
    transport.onclose = () => this.closed();
  }

  /** A message the wrapped transport received; forwarded unchanged by default. */
  protected receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    this.onmessage?.(message, extra);
  }

  /** The wrapped transport closed; forwarded unchanged by default. */
  protected closed(): void {
    this.onclose?.();
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
  set sessionId(value: string | undefined) {
    this.transport.sessionId = value;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.transport.setSupportedProtocolVersions?.(versions);
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(message, options);
  }
}
