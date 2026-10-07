import { expect, it } from "vitest";

import { normalizeProcessSamples } from "./ProcessNormalization.js";
import {
  parseProcessScenario,
  type ProcessSample,
} from "../../domain/process/processCapture.js";

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
      command: "child 42020 parent 41010 group 43030 session 44040",
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

it.each([false, true, undefined])(
  "projects only declared sample fields without mutating inputs when pids is %s",
  (pids) => {
    const scenario = parseProcessScenario({
      executable: "/usr/bin/node",
      ...(pids === undefined ? {} : { normalization: { pids } }),
    });
    const before = JSON.stringify(samples);
    const normalized = normalizeProcessSamples(samples, scenario, rootPid);
    const identities =
      pids === false
        ? [
            [rootPid, 40_000, rootPid, rootPid],
            [42_020, rootPid, 43_030, 44_040],
            [45_050, 42_020, 43_030, 44_040],
            [46_060, 0, null, 0],
            [47_070, 0, 0, null],
          ]
        : [
            [1, 2, 1, 1],
            [3, 1, 4, 5],
            [6, 3, 4, 5],
            [7, 0, null, 0],
            [8, 0, 0, null],
          ];
    const commands =
      pids === false
        ? samples.map(({ command }) => command.trim())
        : [
            "root <pid>",
            "child <pid> parent <pid> group <pid> session <pid>",
            "peer <pid> unrelated 145050",
            "unknown <pid>",
            "unavailable <pid>",
          ];

    expect(scenario.normalization.pids).toBe(pids ?? true);
    expect(normalized).toEqual(
      identities.map(
        ([pid, parent_pid, process_group_id, session_id], index) => ({
          at_ms: (index + 1) * 10,
          pid,
          parent_pid,
          process_group_id,
          session_id,
          command: commands[index],
        }),
      ),
    );
    expect(normalized).not.toBe(samples);
    for (const [index, sample] of normalized.entries()) {
      expect(sample).not.toBe(samples[index]);
      expect(Object.keys(sample).sort()).toEqual(
        [
          "at_ms",
          "pid",
          "parent_pid",
          "process_group_id",
          "session_id",
          "command",
        ].sort(),
      );
    }
    expect(JSON.stringify(samples)).toBe(before);
  },
);

for (const pids of [false, true]) {
  for (const paths of [false, true]) {
    it.each([false, true])(
      `keeps time, patterns, paths=${String(paths)}, and ports=%s independent of pids=${String(pids)}`,
      (ports) => {
        const sample: ProcessSample = Object.freeze({
          at_ms: 29,
          pid: 42_020,
          parent_pid: rootPid,
          process_group_id: 43_030,
          session_id: 44_040,
          command:
            " /workspace/program child 42020 parent 41010 group 43030 session 44040 listen:8080 marker ",
        });
        const scenario = parseProcessScenario({
          executable: "/usr/bin/node",
          working_directory: "/workspace",
          normalization: {
            pids,
            paths,
            ports,
            time_bucket_ms: 25,
            patterns: [{ pattern: "marker", replacement: "selected" }],
          },
        });
        const normalized = normalizeProcessSamples([sample], scenario, rootPid);
        const directory = paths ? "<working-directory>" : "/workspace";
        const identifiers = pids
          ? "child <pid> parent <pid> group <pid> session <pid>"
          : "child 42020 parent 41010 group 43030 session 44040";
        expect(normalized).toEqual([
          {
            at_ms: 25,
            pid: pids ? 2 : 42_020,
            parent_pid: pids ? 1 : rootPid,
            process_group_id: pids ? 3 : 43_030,
            session_id: pids ? 4 : 44_040,
            command: `${directory}/program ${identifiers} listen:${ports ? "<port>" : "8080"} selected`,
          },
        ]);
      },
    );
  }
}
