import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { webPageInspectionSchema } from "../domain/browserObservationSchemas.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { receiveCdpEvent } from "./CdpConnection.js";

it("preserves observed WebSocket frames and tracks unknown opcode and payload facts", () => {
  const events = new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://example.test"],
      target_id: "page",
      include_websocket_shapes: true,
    }),
    new Set(["https://example.test"]),
  );
  events.ingest(
    receiveCdpEvent({
      method: "Network.webSocketCreated",
      params: { requestId: "socket", url: "wss://example.test/live" },
    }),
  );
  const socket = events.webSocketConnectionsById.get("socket");
  if (socket === undefined) throw new Error("Expected the approved WebSocket");
  // Each row states the retained opcode, size and shape after the raw fields.
  const cases = [
    ["continuation", { opcode: 0, payloadData: "" }, 0, 0, "binary"],
    ["missing opcode", { payloadData: "" }, null, null, null],
    ["string opcode", { opcode: "1", payloadData: "x" }, null, null, null],
    ["null opcode", { opcode: null, payloadData: "" }, null, null, null],
    ["negative opcode", { opcode: -1, payloadData: "" }, null, null, null],
    ["fractional opcode", { opcode: 1.5, payloadData: "x" }, null, null, null],
    ["above four bits", { opcode: 16, payloadData: "" }, null, null, null],
    [
      "non-finite opcode",
      { opcode: Number.NaN, payloadData: "" },
      null,
      null,
      null,
    ],
    ["reserved opcode", { opcode: 15, payloadData: "" }, 15, 0, "binary"],
    ["missing payload", { opcode: 1 }, 1, null, null],
    ["numeric payload", { opcode: 1, payloadData: 42 }, 1, null, null],
    ["invalid base64", { opcode: 2, payloadData: "AA" }, 2, null, "binary"],
    ["empty text", { opcode: 1, payloadData: "" }, 1, 0, "text", "sent"],
    ["UTF-8 text", { opcode: 1, payloadData: "é" }, 1, 2, "text", "sent"],
  ] as const;
  let invalidCount = 0;
  for (const [
    index,
    [label, response, opcode, bytes, format, direction = "received"],
  ] of cases.entries()) {
    events.ingest(
      receiveCdpEvent({
        method:
          direction === "received"
            ? "Network.webSocketFrameReceived"
            : "Network.webSocketFrameSent",
        params: { requestId: "socket", response },
      }),
    );
    expect(socket.events, label).toHaveLength(index + 1);
    expect(socket.events[index], label).toEqual({
      direction,
      opcode,
      payload_bytes: bytes,
      payload_shape: format === null ? null : { format, json_shape: null },
    });
    invalidCount += bytes === null ? 1 : 0;
    expect(events.completeness.snapshot().excluded, label).toEqual(
      invalidCount === 0
        ? []
        : [
            {
              section: "websocket_frames",
              reason: "invalid_protocol_value",
              count: invalidCount,
            },
          ],
    );
  }
  expect(
    webPageInspectionSchema.shape.network.shape.websocket_connections.element.safeParse(
      socket,
    ).success,
  ).toBe(true);
});
