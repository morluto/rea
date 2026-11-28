import { createHash } from "node:crypto";

function view(value) {
  const bytes = Buffer.from(value);
  return {
    base64: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function connectionFactsFixture() {
  const body = Buffer.from([0, 255, 128, 1]);
  const producer = {
    event: "response",
    case: "curl",
    id: "flow-id",
    error: null,
    request: { http_version: "HTTP/3", content: view(body) },
    response: { http_version: "HTTP/3", content: view(body) },
    client_conn: {
      id: "client-id",
      transport_protocol: "udp",
      tls_version: "QUICv1",
      timestamp_tls_setup: 1_700_000_000.125678,
      error: null,
    },
    server_conn: {
      id: "server-id",
      transport_protocol: "udp",
      tls_version: "QUICv1",
      timestamp_tls_setup: 1_700_000_000.987654,
      error: null,
    },
  };
  const reported = structuredClone(producer);
  const requestFields = {
    method: "POST",
    scheme: "https",
    authority: "lab.test:18443",
    path: "/echo?case=readable",
  };
  Object.assign(reported.request, requestFields);
  const headers = [
    [Buffer.from("x-repeat"), Buffer.from("first-α")],
    [Buffer.from("x-repeat"), Buffer.from("second-β")],
    [Buffer.from("x-binary"), Buffer.from([255])],
  ];
  for (const side of ["request", "response"])
    reported[side].headers = [
      ["x-repeat", "first-α"],
      ["x-repeat", "second-β"],
      ["x-binary", null],
    ];
  reported.client_conn.alpn = "h3";
  reported.server_conn.alpn = "h3";
  reported.response.status_code = 200;
  const binary_fields = [
    ["/request/content", body],
    ["/response/content", body],
    ["/client_conn/alpn", Buffer.from("h3")],
    ["/server_conn/alpn", Buffer.from("h3")],
    ...Object.entries(requestFields).map(([name, value]) => [
      `/request/${name}`,
      Buffer.from(value),
    ]),
    ...["request", "response"].flatMap((side) =>
      headers.flatMap((pair, index) =>
        pair.map((value, part) => [`/${side}/headers/${index}/${part}`, value]),
      ),
    ),
  ].map(([pointer, bytes]) => {
    const { base64, ...facts } = view(bytes);
    return {
      pointer,
      representation: "producer-bytes",
      state: "retained",
      content_base64: base64,
      ...facts,
    };
  });
  return {
    normal: { records: [{ reported, binary_fields }] },
    manifest: {
      requests: {
        curl: {
          headers: [
            ...Object.entries(requestFields).map(([name, value]) => [
              view(Buffer.from(`:${name}`)),
              view(Buffer.from(value)),
            ]),
            ...headers.map((pair) => pair.map(view)),
          ],
          body: view(body),
        },
      },
      responses: {
        curl: {
          headers: headers.map((pair) => pair.map(view)),
          body: view(body),
        },
      },
    },
    producer: [producer],
  };
}

export function resetFixture(variant = "before-headers") {
  const partial = variant === "partial-response";
  const failedCase = partial ? "partial-before-reset" : "reset-before-headers";
  const recoveryCase = partial ? "partial-reset-recovery" : "reset-recovery";
  const { normal, manifest, producer } = connectionFactsFixture();
  const recovered = normal.records[0];
  const success = producer[0];
  const failed = structuredClone(recovered);
  const error = structuredClone(success);
  failed.reported.id = error.id = "failed-id";
  failed.reported.response = error.response = null;
  failed.reported.error = { msg: "endpoint reset" };
  error.error = "endpoint reset";
  error.event = "error";
  error.case = failedCase;
  success.event = "response";
  success.case = recoveryCase;
  failed.reported.request.timestamp_end =
    error.request.timestamp_end = 1700000001;
  failed.binary_fields = failed.binary_fields.filter(
    (item) => !item.pointer.startsWith("/response/"),
  );
  for (const [record, name] of [
    [failed, failedCase],
    [recovered, recoveryCase],
  ]) {
    addRequestCase(record, name, manifest);
  }
  manifest.responses[recoveryCase] = manifest.responses.curl;
  const event = (event, caseName, connection, stream_id) => ({
    event,
    case: caseName,
    connection,
    stream_id,
  });
  manifest.events = [
    ...["client", "origin"].map((connection) => ({
      event: "handshake",
      connection,
      alpn: "h3",
      quic_version: 1,
    })),
    event("request-sent", failedCase, "client", 0),
    event("request-received", failedCase, "origin", 4),
    {
      ...event("response-reset", failedCase, "origin", 4),
      endpoint: "origin",
      error_code: 0x10c,
    },
    {
      ...event("StreamReset", undefined, "client", 0),
      endpoint: "client",
      error_code: 0x10c,
      monotonic: 1,
    },
    { ...event("request-sent", recoveryCase, "client", 4), monotonic: 2 },
    event("request-received", recoveryCase, "origin", 8),
    {
      ...event("response-received", undefined, "client", 4),
      ...manifest.responses[recoveryCase],
    },
  ];
  let ordinal = 0;
  for (const observation of manifest.events) observation.monotonic = ++ordinal;
  if (partial)
    addPartialFixture(
      { failed, recovered, error, manifest },
      failedCase,
      recoveryCase,
    );
  for (const observation of manifest.events) {
    if (["request-sent", "request-received"].includes(observation.event)) {
      Object.assign(
        observation,
        structuredClone(manifest.requests[observation.case]),
      );
      observation.endpoint =
        observation.event === "request-sent" ? "client" : "origin";
    }
  }
  return {
    capture: { total_records: 2, records: [failed, recovered] },
    manifest,
    producer: [
      error,
      success,
      ...(partial
        ? [
            {
              event: "partial-streaming",
              id: error.id,
              store_streamed_bodies: false,
            },
          ]
        : []),
    ],
  };
}

function addPartialFixture(
  { failed, recovered, error, manifest },
  failedCase,
  recoveryCase,
) {
  const expected = structuredClone(manifest.responses[recoveryCase]);
  expected.declared_body_bytes = expected.body.bytes + 11;
  expected.finished = false;
  expected.headers.push([
    view("content-length"),
    view(String(expected.declared_body_bytes)),
  ]);
  manifest.responses[failedCase] = expected;
  failed.reported.response = {
    ...structuredClone(recovered.reported.response),
    content: null,
    timestamp_end: null,
  };
  failed.reported.response.headers.push([
    "content-length",
    String(expected.declared_body_bytes),
  ]);
  failed.binary_fields.push(
    ...structuredClone(
      recovered.binary_fields.filter((item) =>
        item.pointer.startsWith("/response/headers/"),
      ),
    ),
  );
  const index = failed.reported.response.headers.length - 1;
  for (const [part, value] of [
    "content-length",
    String(expected.declared_body_bytes),
  ].entries()) {
    const { base64, ...facts } = view(value);
    failed.binary_fields.push({
      pointer: `/response/headers/${index}/${part}`,
      state: "retained",
      content_base64: base64,
      ...facts,
    });
  }
  error.response = {
    http_version: "HTTP/3",
    streamed: true,
    content: null,
    timestamp_end: null,
  };
  const resetTime = manifest.events.find(
    (event) => event.event === "response-reset",
  ).monotonic;
  const received = manifest.events.find(
    (event) => event.event === "request-received",
  );
  const transmitTime = received.monotonic + 0.1;
  const headersTime = received.monotonic + 0.2;
  manifest.events.push({
    event: "response-headers",
    endpoint: "client",
    connection: "client",
    stream_id: 0,
    monotonic: headersTime,
    headers: structuredClone(expected.headers),
    finished: false,
  });
  manifest.events.push({
    event: "response-partial-sent",
    endpoint: "origin",
    connection: "origin",
    stream_id: 4,
    case: failedCase,
    monotonic: transmitTime,
    ...structuredClone(expected),
  });
  const prefix = Buffer.from(expected.body.base64, "base64");
  for (const length of [2, prefix.length])
    manifest.events.push({
      event: "response-progress",
      endpoint: "client",
      connection: "client",
      stream_id: 0,
      monotonic:
        headersTime +
        ((resetTime - headersTime) * length) / (prefix.length + 1),
      headers: expected.headers,
      body: view(prefix.subarray(0, length)),
      finished: false,
    });
}

function addRequestCase(record, name, manifest) {
  record.reported.request.headers.push(["x-lab-case", name]);
  const headers = structuredClone(manifest.requests.curl.headers);
  headers.push([view("x-lab-case"), view(name)]);
  manifest.requests[name] = { ...manifest.requests.curl, headers };
  const index = record.reported.request.headers.length - 1;
  for (const [part, value] of ["x-lab-case", name].entries()) {
    const { base64, ...facts } = view(value);
    record.binary_fields.push({
      pointer: `/request/headers/${index}/${part}`,
      state: "retained",
      content_base64: base64,
      ...facts,
    });
  }
}
