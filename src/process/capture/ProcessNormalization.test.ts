import { expect, it } from "vitest";

import { normalizeProcessSamples } from "./ProcessNormalization.js";
import { parseProcessScenario } from "../../domain/process/processCapture.js";

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
}) =>
  parseProcessScenario({
    executable: "/usr/bin/node",
    working_directory: "/workspace",
    normalization: {
      paths: true,
      ...normalization,
      time_bucket_ms: 10,
      patterns: [{ pattern: "marker", replacement: "selected" }],
    },
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
