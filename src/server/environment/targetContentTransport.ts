import {
  isCallToolResult,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

import { ForwardingTransport } from "../ForwardingTransport.js";
import {
  carriesTargetContentMarker,
  TARGET_CONTENT_RESULT_META,
} from "../toolResultEncoding.js";

type RequestId = string | number;

const requestId = (value: unknown): RequestId | undefined =>
  typeof value === "string" || typeof value === "number" ? value : undefined;

/** Marks every tools/call result as target content, including errors the SDK builds before a replay callback runs. */
export class TargetContentTransport extends ForwardingTransport {
  readonly #calls = new Map<RequestId, number>();

  protected override receive(
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ): void {
    if (isJSONRPCRequest(message) && message.method === "tools/call")
      this.#calls.set(message.id, (this.#calls.get(message.id) ?? 0) + 1);
    // The SDK sends no reply after a cancellation, so release one reference here.
    if (
      isJSONRPCNotification(message) &&
      message.method === "notifications/cancelled"
    ) {
      const id = requestId(message.params?.["requestId"]);
      if (id !== undefined) this.#releaseCall(id);
    }
    super.receive(message, extra);
  }

  protected override closed(): void {
    this.#calls.clear();
    super.closed();
  }

  override send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const id =
      "id" in message &&
      (isJSONRPCResultResponse(message) || !isJSONRPCRequest(message))
        ? requestId(message.id)
        : undefined;
    const call =
      id !== undefined && !isJSONRPCNotification(message)
        ? this.#releaseCall(id)
        : false;
    if (
      call &&
      isJSONRPCResultResponse(message) &&
      isCallToolResult(message.result) &&
      !carriesTargetContentMarker(message.result)
    )
      return super.send(
        {
          ...message,
          result: {
            ...message.result,
            _meta: { ...message.result._meta, ...TARGET_CONTENT_RESULT_META },
          },
        },
        options,
      );
    return super.send(message, options);
  }

  #releaseCall(id: RequestId): boolean {
    const count = this.#calls.get(id);
    if (count === undefined) return false;
    if (count <= 1) this.#calls.delete(id);
    else this.#calls.set(id, count - 1);
    return true;
  }
}
