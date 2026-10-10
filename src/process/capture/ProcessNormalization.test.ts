import { expect, it } from "vitest";

import {
  normalizeProcessSamples,
  normalizeProcessText,
} from "./ProcessNormalization.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";

const rootPid = 41_010;
const samples = Object.freeze(
  [
    {
      at_ms: 17,
      pid: rootPid,
      parent_pid: 40_000,
      process_group_id: rootPid,
      session_id: rootPid,
      command: " root 41010 ",
    },
    {
      at_ms: 28,
      pid: 42_020,
      parent_pid: rootPid,
      process_group_id: 43_030,
      session_id: 44_040,
      command:
        " /workspace/program child 42020 parent 41010 group 43030 session 44040 listen:8080 marker ",
    },
    {
      at_ms: 39,
      pid: 45_050,
      parent_pid: 42_020,
      process_group_id: 43_030,
      session_id: 44_040,
      command: "peer 45050 unrelated 145050",
    },
    {
      at_ms: 41,
      pid: 46_060,
      parent_pid: 0,
      process_group_id: null,
      session_id: 0,
      command: "unknown 46060",
    },
    {
      at_ms: 52,
      pid: 47_070,
      parent_pid: 0,
      process_group_id: 0,
      session_id: null,
      command: "unavailable 47070",
    },
  ].map((sample) =>
    Object.freeze({ ...sample, runtime_metadata: "must not be serialized" }),
  ),
);

const scenario = (normalization: {
  readonly pids?: boolean;
  readonly paths?: boolean;
  readonly ports?: boolean;
  readonly patterns?: readonly {
    readonly pattern: string;
    readonly replacement: string;
  }[];
}) =>
  parseProcessScenario({
    executable: "/usr/bin/node",
    working_directory: "/workspace",
    normalization: {
      paths: true,
      time_bucket_ms: 10,
      patterns: [{ pattern: "marker", replacement: "selected" }],
      ...normalization,
    },
  });

it("replaces caller-declared patterns literally, without expanding replacement patterns", () => {
  const declared = scenario({
    paths: false,
    patterns: [
      { pattern: "8080", replacement: "$&$&" },
      { pattern: "READY", replacement: "$$" },
      { pattern: "NAME", replacement: "$1" },
    ],
  });
  expect(
    normalizeProcessText(
      "listening on 8080; READY; NAME=alpha; tail NAME",
      declared,
      "/temporary",
      rootPid,
    ),
  ).toBe("listening on $&$&; $$; $1=alpha; tail $1");
});

it("preserves empty-pattern boundaries, including empty text", () => {
  const declared = scenario({
    patterns: [{ pattern: "", replacement: "$$" }],
  });
  expect(normalizeProcessText("ab", declared, "/temporary", rootPid)).toBe(
    "$$a$$b$$",
  );
  expect(normalizeProcessText("", declared, "/temporary", rootPid)).toBe("$$");
});

it.each(["$`", "$'"])(
  "retains the selected replacement %s verbatim",
  (replacement) => {
    const declared = scenario({
      patterns: [{ pattern: "marker", replacement }],
    });
    expect(
      normalizeProcessText(
        "before marker after",
        declared,
        "/temporary",
        rootPid,
      ),
    ).toBe(`before ${replacement} after`);
  },
);

it("preserves compact JSON, counters, line numbers, and ambiguous endpoint spellings", () => {
  const input = [
    '{"pid":32,"size":108,"height":480,"width":640,"score":20}',
    "score=20 size:108 elapsed=3600 file.js:480 server:8080",
    "port=65536 port:8080ms localhost:70000 999.1.2.3:8080",
    "https://user:32@example.test/path http://user:20@localhost/path",
  ].join("\n");
  expect(normalizeProcessText(input, scenario({}), "/temporary", rootPid)).toBe(
    input,
  );
});

it("normalizes only contextual ports before overlapping PID values and honors disabled rules", () => {
  const input =
    'http://example.test:8080/x https://user:password@example.test:443/x 127.0.0.1:9 [::1]:65535 localhost:41010 "port":80 tcp_port=123 udp_port:0 listen:8080';
  expect(normalizeProcessText(input, scenario({}), "/temporary", rootPid)).toBe(
    'http://example.test:<port>/x https://user:password@example.test:<port>/x 127.0.0.1:<port> [::1]:<port> localhost:<port> "port":<port> tcp_port=<port> udp_port:<port> listen:<port>',
  );
  expect(
    normalizeProcessText(
      input,
      scenario({ ports: false, pids: false }),
      "/temporary",
      rootPid,
    ),
  ).toBe(input);
});

it("normalizes ports that end a sentence but not decimal or host continuations", () => {
  const input = [
    "Listening on port: 8080.",
    "Server at http://localhost:8080. Ready",
    "Bound [::1]:3000.",
    "listen=9000.\n",
    "port: 80.5 localhost:8080.5 localhost:8080.example.test",
    "port: 8080.β localhost:8080.é port: 8080é",
  ].join("\n");
  expect(normalizeProcessText(input, scenario({}), "/temporary", rootPid)).toBe(
    [
      "Listening on port: <port>.",
      "Server at http://localhost:<port>. Ready",
      "Bound [::1]:<port>.",
      "listen=<port>.\n",
      "port: 80.5 localhost:8080.5 localhost:8080.example.test",
      "port: 8080.β localhost:8080.é port: 8080é",
    ].join("\n"),
  );
});

it("keeps a port before a chunk-final period, whose continuation is unknown", () => {
  for (const chunk of ["port: 80.", "http://localhost:8080.", "[::1]:3000."])
    expect(
      normalizeProcessText(chunk, scenario({}), "/temporary", rootPid),
    ).toBe(chunk);
});

it("normalizes representative process identities and preserves null, zero, and unrelated numbers", () => {
  const before = JSON.stringify(samples);
  const normalized = normalizeProcessSamples(samples, scenario({}), rootPid);

  expect(normalized).toEqual([
    {
      at_ms: 10,
      pid: 1,
      parent_pid: 2,
      process_group_id: 1,
      session_id: 1,
      command: "root <pid>",
    },
    {
      at_ms: 20,
      pid: 3,
      parent_pid: 1,
      process_group_id: 4,
      session_id: 5,
      command:
        "<working-directory>/program child <pid> parent <pid> group <pid> session <pid> listen:<port> selected",
    },
    {
      at_ms: 30,
      pid: 6,
      parent_pid: 3,
      process_group_id: 4,
      session_id: 5,
      command: "peer <pid> unrelated 145050",
    },
    {
      at_ms: 40,
      pid: 7,
      parent_pid: 0,
      process_group_id: null,
      session_id: 0,
      command: "unknown <pid>",
    },
    {
      at_ms: 50,
      pid: 8,
      parent_pid: 0,
      process_group_id: 0,
      session_id: null,
      command: "unavailable <pid>",
    },
  ]);
  expect(JSON.stringify(samples)).toBe(before);
  expect(normalized.every((sample) => !("runtime_metadata" in sample))).toBe(
    true,
  );

  const pathAndPortPreserved = normalizeProcessSamples(
    samples,
    scenario({ paths: false, ports: false }),
    rootPid,
  );
  expect(pathAndPortPreserved[1]).toMatchObject({
    pid: 3,
    parent_pid: 1,
    command:
      "/workspace/program child <pid> parent <pid> group <pid> session <pid> listen:8080 selected",
  });

  const identifiersPreserved = normalizeProcessSamples(
    samples,
    scenario({ pids: false }),
    rootPid,
  );
  expect(
    identifiersPreserved.map(
      ({ pid, parent_pid, process_group_id, session_id }) => [
        pid,
        parent_pid,
        process_group_id,
        session_id,
      ],
    ),
  ).toEqual([
    [rootPid, 40_000, rootPid, rootPid],
    [42_020, rootPid, 43_030, 44_040],
    [45_050, 42_020, 43_030, 44_040],
    [46_060, 0, null, 0],
    [47_070, 0, 0, null],
  ]);
  expect(identifiersPreserved[1]?.command).toBe(
    "<working-directory>/program child 42020 parent 41010 group 43030 session 44040 listen:<port> selected",
  );
});
