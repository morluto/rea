import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertEndpointHeaders,
  assertHeaders,
  byCase,
  connectionH3,
  field,
  requireHttp3,
  terminalObservation,
  verifyNormalRecords,
  verifyProducerConnections,
  verifyRequest,
} from "./http3-capture-assertions.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyOriginReset(
  capture,
  manifest,
  producerEvents,
  variant = "before-headers",
) {
  assert.ok(["before-headers", "partial-response"].includes(variant));
  const partial = variant === "partial-response";
  const failedCase = partial ? "partial-before-reset" : "reset-before-headers";
  const recoveryCase = partial ? "partial-reset-recovery" : "reset-recovery";
  assert.equal(capture.total_records, 2);
  assert.equal(capture.records.length, 2);
  const failed = byCase(capture, failedCase);
  const recovered = byCase(capture, recoveryCase);
  assert.notEqual(failed.reported.id, recovered.reported.id);
  const producer = terminalObservation(failed, producerEvents);
  assert.equal(producer.event, "error");
  assert.equal(typeof producer.error, "string");
  assert.ok(producer.error.length > 0);
  assert.equal(failed.reported.error.msg, producer.error);
  if (partial)
    verifyPartialResponse(
      failed,
      producer,
      manifest.responses[failedCase],
      producerEvents,
    );
  else {
    assert.equal(producer.response, null);
    assert.equal(failed.reported.response, null);
    assert.equal(
      failed.binary_fields.some((item) =>
        item.pointer.startsWith("/response/"),
      ),
      false,
    );
  }
  assert.equal(failed.reported.request.http_version, "HTTP/3");
  assert.equal(
    failed.reported.request.timestamp_end,
    producer.request.timestamp_end,
  );
  assert.equal(typeof producer.request.timestamp_end, "number");
  verifyRequest(failed, manifest.requests[failedCase], producer.request);
  for (const side of ["client_conn", "server_conn"]) {
    connectionH3(failed, side);
    assert.equal(failed.reported[side].id, recovered.reported[side].id);
  }
  verifyProducerConnections(failed, producer);
  verifyNormalRecords({ records: [recovered] }, manifest, producerEvents);
  verifyResetEndpointEvents(manifest, { failedCase, recoveryCase, partial });
}

function verifyPartialResponse(record, producer, expected, producerEvents) {
  assert.ok(
    record.reported.response && producer.response,
    "Partial response headers must remain present",
  );
  requireHttp3(record);
  assert.equal(record.reported.response.status_code, 200);
  assert.equal(producer.response.http_version, "HTTP/3");
  assert.equal(producer.response.streamed, true);
  assert.equal(producer.response.timestamp_end, null);
  assert.equal(record.reported.response.timestamp_end, null);
  assert.equal(producer.response.content, null);
  assert.equal(record.reported.response.content, null);
  assert.equal(field(record, "/response/content"), undefined);
  assertHeaders(record, "response", expected.headers);
  const streaming = producerEvents.filter(
    (event) =>
      event.event === "partial-streaming" && event.id === record.reported.id,
  );
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].store_streamed_bodies, false);
}

function verifyResetEndpointEvents(
  manifest,
  { failedCase, recoveryCase, partial },
) {
  const request = (eventName, name) => {
    const matches = manifest.events.filter(
      (event) => event.event === eventName && event.case === name,
    );
    assert.equal(matches.length, 1);
    return matches[0];
  };
  const failedSent = request("request-sent", failedCase);
  const failedReceived = request("request-received", failedCase);
  const recoverySent = request("request-sent", recoveryCase);
  const recoveryReceived = request("request-received", recoveryCase);
  const reset = request("response-reset", failedCase);
  for (const [sent, received, name] of [
    [failedSent, failedReceived, failedCase],
    [recoverySent, recoveryReceived, recoveryCase],
  ]) {
    assert.equal(sent.endpoint, "client");
    assert.equal(received.endpoint, "origin");
    for (const observation of [sent, received]) {
      assert.deepEqual(observation.body, manifest.requests[name].body);
      assertEndpointHeaders(
        observation.headers,
        manifest.requests[name].headers,
      );
    }
  }
  const failedClientEvents = manifest.events.filter(
    (event) =>
      event.connection === failedSent.connection &&
      event.stream_id === failedSent.stream_id,
  );
  assert.equal(
    manifest.events.some(
      (event) =>
        event.event === "response-sent" &&
        event.connection === failedReceived.connection &&
        event.stream_id === failedReceived.stream_id,
    ),
    false,
  );
  if (partial)
    verifyPartialEndpoint(manifest, failedSent, failedReceived, reset);
  else
    assert.equal(
      failedClientEvents.some((event) =>
        ["response-headers", "response-progress"].includes(event.event),
      ),
      false,
    );
  assert.equal(reset.endpoint, "origin");
  assert.equal(reset.connection, failedReceived.connection);
  assert.equal(reset.stream_id, failedReceived.stream_id);
  assert.equal(reset.error_code, 0x10c);
  assert.equal(failedSent.connection, recoverySent.connection);
  assert.equal(failedReceived.connection, recoveryReceived.connection);
  assert.notEqual(failedSent.stream_id, recoverySent.stream_id);
  assert.notEqual(failedReceived.stream_id, recoveryReceived.stream_id);
  verifyRecoveryReceipt(manifest, {
    failedSent,
    failedReceived,
    reset,
    recoverySent,
    recoveryReceived,
    recoveryCase,
  });
  assert.equal(
    manifest.events.some(
      (event) =>
        event.event === "response-received" &&
        event.connection === failedSent.connection &&
        event.stream_id === failedSent.stream_id,
    ),
    false,
  );
}

function verifyRecoveryReceipt(
  manifest,
  {
    failedSent,
    failedReceived,
    reset,
    recoverySent,
    recoveryReceived,
    recoveryCase,
  },
) {
  const clientResets = manifest.events.filter(
    (event) =>
      event.event === "StreamReset" &&
      event.endpoint === "client" &&
      event.connection === failedSent.connection &&
      event.stream_id === failedSent.stream_id,
  );
  assert.equal(clientResets.length, 1);
  assert.equal(clientResets[0].error_code, 0x10c);
  const ordered = [
    failedSent,
    failedReceived,
    reset,
    clientResets[0],
    recoverySent,
    recoveryReceived,
  ];
  assertMonotonicOrder(ordered);
  assert.ok(clientResets[0].monotonic < recoverySent.monotonic);
  for (const connection of [failedSent.connection, failedReceived.connection]) {
    const handshakes = manifest.events.filter(
      (event) => event.event === "handshake" && event.connection === connection,
    );
    assert.equal(handshakes.length, 1);
    assert.equal(handshakes[0].alpn, "h3");
    assert.equal(handshakes[0].quic_version, 1);
  }
  const recoveryResponses = manifest.events.filter(
    (event) =>
      event.event === "response-received" &&
      event.connection === recoverySent.connection &&
      event.stream_id === recoverySent.stream_id,
  );
  assert.equal(recoveryResponses.length, 1);
  assertMonotonicOrder([recoveryReceived, recoveryResponses[0]]);
  assert.deepEqual(
    recoveryResponses[0].body,
    manifest.responses[recoveryCase].body,
  );
  assertEndpointHeaders(
    recoveryResponses[0].headers,
    manifest.responses[recoveryCase].headers,
  );
}

function assertMonotonicOrder(events) {
  let previous = -Infinity;
  for (const event of events) {
    assert.equal(
      typeof event.monotonic,
      "number",
      `Missing clock for ${event.event}`,
    );
    assert.ok(
      Number.isFinite(event.monotonic) && event.monotonic >= previous,
      `Out-of-order endpoint event ${event.event}`,
    );
    previous = event.monotonic;
  }
}

function verifyPartialEndpoint(manifest, sent, received, reset) {
  const expected = manifest.responses["partial-before-reset"];
  assert.equal(expected.finished, false);
  assert.ok(expected.body.bytes > 0);
  assert.ok(expected.declared_body_bytes > expected.body.bytes);
  const contentLength = expected.headers.filter(
    ([name]) =>
      Buffer.from(name.base64, "base64").toString() === "content-length",
  );
  assert.equal(contentLength.length, 1);
  assert.equal(
    Buffer.from(contentLength[0][1].base64, "base64").toString(),
    String(expected.declared_body_bytes),
  );
  const transmitted = manifest.events.filter(
    (event) =>
      event.event === "response-partial-sent" &&
      event.connection === received.connection &&
      event.stream_id === received.stream_id,
  );
  assert.equal(transmitted.length, 1);
  assertMonotonicOrder([received, transmitted[0], reset]);
  const headers = manifest.events.filter(
    (event) =>
      event.event === "response-headers" &&
      event.connection === sent.connection &&
      event.stream_id === sent.stream_id,
  );
  assert.equal(headers.length, 1);
  assert.equal(headers[0].endpoint, "client");
  assert.equal(headers[0].finished, false);
  assertEndpointHeaders(headers[0].headers, expected.headers);
  assertMonotonicOrder([transmitted[0], headers[0], reset]);
  assert.equal(transmitted[0].endpoint, "origin");
  assert.equal(transmitted[0].case, "partial-before-reset");
  assert.equal(transmitted[0].finished, false);
  assert.equal(
    transmitted[0].declared_body_bytes,
    expected.declared_body_bytes,
  );
  assert.deepEqual(transmitted[0].body, expected.body);
  assertEndpointHeaders(transmitted[0].headers, expected.headers);
  const progress = manifest.events.filter(
    (event) =>
      event.event === "response-progress" &&
      event.connection === sent.connection &&
      event.stream_id === sent.stream_id,
  );
  assert.ok(progress.length > 0);
  const prefix = Buffer.from(expected.body.base64, "base64");
  assert.equal(prefix.length, expected.body.bytes);
  assert.equal(digest(prefix), expected.body.sha256);
  assertMonotonicOrder([headers[0], ...progress, reset]);
  let previousBytes = 0;
  for (const event of progress) {
    assert.equal(event.endpoint, "client");
    assert.equal(event.finished, false);
    assert.ok(
      event.body.bytes >= previousBytes && event.body.bytes <= prefix.length,
    );
    const observed = prefix.subarray(0, event.body.bytes);
    assert.deepEqual(event.body, {
      base64: observed.toString("base64"),
      bytes: observed.length,
      sha256: digest(observed),
    });
    assertEndpointHeaders(event.headers, expected.headers);
    assert.ok(
      transmitted[0].monotonic <= event.monotonic &&
        event.monotonic < reset.monotonic,
    );
    previousBytes = event.body.bytes;
  }
  assert.deepEqual(progress.at(-1).body, expected.body);
}
