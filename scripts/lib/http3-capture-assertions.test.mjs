import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectionFactsFixture,
  resetFixture,
} from "./http3-capture-fixtures.mjs";
import { verifyNormalRecords } from "./http3-capture-assertions.mjs";
import { verifyOriginReset } from "./http3-reset-assertions.mjs";

test("positive assertions retain exact producer connection facts on both legs", () => {
  const { normal, manifest, producer } = connectionFactsFixture();
  verifyNormalRecords(normal, manifest, producer);
});

for (const [field, value] of [
  ["method", "GET"],
  ["scheme", "http"],
  ["authority", "other.test:18443"],
  ["path", "/different"],
])
  test(`positive assertions reject changed readable request ${field}`, () => {
    const { normal, manifest, producer } = connectionFactsFixture();
    normal.records[0].reported.request[field] = value;
    assert.throws(() => verifyNormalRecords(normal, manifest, producer), {
      code: "ERR_ASSERTION",
    });
  });

for (const side of ["client_conn", "server_conn"])
  test(`positive assertions reject null readable ${side} ALPN`, () => {
    const { normal, manifest, producer } = connectionFactsFixture();
    normal.records[0].reported[side].alpn = null;
    assert.throws(() => verifyNormalRecords(normal, manifest, producer), {
      code: "ERR_ASSERTION",
    });
  });

for (const side of ["request", "response"])
  for (const [index, part, value] of [
    [0, 0, "x-changed"],
    [0, 1, "changed-first"],
    [1, 1, "changed-second"],
    [2, 1, "�"],
  ])
    test(`positive assertions reject changed readable ${side} header ${index}/${part}`, () => {
      const { normal, manifest, producer } = connectionFactsFixture();
      normal.records[0].reported[side].headers[index][part] = value;
      assert.throws(() => verifyNormalRecords(normal, manifest, producer), {
        code: "ERR_ASSERTION",
      });
    });

for (const side of ["client_conn", "server_conn"])
  for (const [field, value] of [
    ["tls_version", null],
    ["tls_version", "changed-producer-label"],
    ["error", "changed-connection-error"],
    ["error", undefined],
    ["timestamp_tls_setup", 0],
    ["timestamp_tls_setup", 1_700_000_000],
  ])
    test(`positive assertions reject ${side}.${field} changed to ${String(value)}`, () => {
      const { normal, manifest, producer } = connectionFactsFixture();
      normal.records[0].reported[side][field] = value;
      assert.throws(() => verifyNormalRecords(normal, manifest, producer), {
        code: "ERR_ASSERTION",
      });
    });

test("partial reset accepts fragmented client receipt and absent captured body", () => {
  const { capture, manifest, producer } = resetFixture("partial-response");
  verifyOriginReset(capture, manifest, producer, "partial-response");
});

for (const [name, mutate] of [
  [
    "empty string substituted for absent body",
    ({ capture }) => {
      capture.records[0].reported.response.content = "";
    },
  ],
  [
    "missing response headers",
    ({ capture }) => {
      capture.records[0].reported.response = null;
    },
  ],
  [
    "fabricated completion timestamp",
    ({ capture }) => {
      capture.records[0].reported.response.timestamp_end = 0;
    },
  ],
  [
    "fabricated body descriptor",
    ({ capture }) => {
      capture.records[0].binary_fields.push({
        pointer: "/response/content",
        state: "retained",
        content_base64: "",
      });
    },
  ],
  [
    "changed captured content length",
    ({ capture }) => {
      capture.records[0].reported.response.headers.at(-1)[1] = "4";
    },
  ],
  [
    "complete declared length",
    ({ manifest }) => {
      manifest.responses["partial-before-reset"].declared_body_bytes = 4;
    },
  ],
  [
    "no client receipt",
    ({ manifest }) => {
      manifest.events = manifest.events.filter(
        (event) => event.event !== "response-progress",
      );
    },
  ],
  [
    "client receipt on another stream",
    ({ manifest }) => {
      for (const event of manifest.events.filter(
        (event) => event.event === "response-progress",
      ))
        event.stream_id = 20;
    },
  ],
  [
    "receipt after reset",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-progress",
      ).monotonic = 1;
    },
  ],
  [
    "premature FIN",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-progress",
      ).finished = true;
    },
  ],
  [
    "changed partial bytes",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-progress",
      ).body.base64 = "AA==";
    },
  ],
  [
    "stored-body mode",
    ({ producer }) => {
      producer.find(
        (event) => event.event === "partial-streaming",
      ).store_streamed_bodies = true;
    },
  ],
])
  test(`partial reset rejects ${name}`, () => {
    const fixture = resetFixture("partial-response");
    mutate(fixture);
    assert.throws(
      () =>
        verifyOriginReset(
          fixture.capture,
          fixture.manifest,
          fixture.producer,
          "partial-response",
        ),
      { code: "ERR_ASSERTION" },
    );
  });

test("origin reset accepts distinct leg-local stream IDs and same-connection recovery", () => {
  const { capture, manifest, producer } = resetFixture();
  verifyOriginReset(capture, manifest, producer);
});

for (const [name, mutate] of [
  [
    "invented response",
    ({ capture }) => {
      capture.records[0].reported.response = { status_code: 200 };
    },
  ],
  [
    "missing error",
    ({ capture }) => {
      capture.records[0].reported.error = { msg: null };
    },
  ],
  [
    "different recovery connection",
    ({ capture }) => {
      capture.records[1].reported.server_conn.id = "another";
    },
  ],
  [
    "wrong reset code",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "StreamReset",
      ).error_code = 0;
    },
  ],
  [
    "wrong reset stream",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-reset",
      ).stream_id = 0;
    },
  ],
  [
    "recovery before reset",
    ({ manifest }) => {
      manifest.events.find((event) => event.event === "StreamReset").monotonic =
        3;
    },
  ],
  [
    "duplicate error observation",
    ({ producer }) => {
      producer.push(structuredClone(producer[0]));
    },
  ],
  [
    "changed recovery body",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-received",
      ).body = null;
    },
  ],
])
  test(`origin reset rejects ${name}`, () => {
    const fixture = resetFixture();
    mutate(fixture);
    assert.throws(
      () =>
        verifyOriginReset(fixture.capture, fixture.manifest, fixture.producer),
      { code: "ERR_ASSERTION" },
    );
  });

for (const [name, mutate] of [
  [
    "producer case mismatch",
    ({ producer }) => {
      producer[0].case = "another-case";
    },
  ],
  [
    "missing endpoint clock",
    ({ manifest }) => {
      delete manifest.events.find((event) => event.event === "request-sent")
        .monotonic;
    },
  ],
  [
    "origin reset after client reset",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-reset",
      ).monotonic = 100;
    },
  ],
  [
    "origin recovery before client request",
    ({ manifest }) => {
      manifest.events.find(
        (event) =>
          event.event === "request-received" && event.case === "reset-recovery",
      ).monotonic = 1;
    },
  ],
  [
    "headers received before purported headerless reset",
    ({ manifest }) => {
      manifest.events.push({
        event: "response-headers",
        connection: "client",
        stream_id: 0,
      });
    },
  ],
  [
    "completed origin response before reset",
    ({ manifest }) => {
      manifest.events.push({
        event: "response-sent",
        connection: "origin",
        stream_id: 4,
      });
    },
  ],
])
  test(`reset provenance rejects ${name}`, () => {
    const fixture = resetFixture();
    mutate(fixture);
    assert.throws(
      () =>
        verifyOriginReset(fixture.capture, fixture.manifest, fixture.producer),
      { code: "ERR_ASSERTION" },
    );
  });

for (const [name, mutate] of [
  [
    "missing client headers",
    ({ manifest }) => {
      manifest.events = manifest.events.filter(
        (event) => event.event !== "response-headers",
      );
    },
  ],
  [
    "FIN with client headers",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-headers",
      ).finished = true;
    },
  ],
  [
    "partial response after reset",
    ({ manifest }) => {
      manifest.events.find(
        (event) => event.event === "response-partial-sent",
      ).monotonic = 100;
    },
  ],
])
  test(`partial receipt provenance rejects ${name}`, () => {
    const fixture = resetFixture("partial-response");
    mutate(fixture);
    assert.throws(
      () =>
        verifyOriginReset(
          fixture.capture,
          fixture.manifest,
          fixture.producer,
          "partial-response",
        ),
      { code: "ERR_ASSERTION" },
    );
  });
