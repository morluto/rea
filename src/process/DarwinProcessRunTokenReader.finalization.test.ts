import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { access } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";

interface HelperRequest {
  readonly arguments: readonly string[];
  readonly rows?: readonly unknown[];
  readonly failure?: Error;
}

const command = vi.hoisted(() => {
  const events: string[] = [];
  let helpers = new Map<
    string,
    HelperRequest & { gate: Promise<void>; release: () => void }
  >();
  let started: Promise<void>;
  let acknowledge: () => void;
  const startedRequests = new Set<string>();
  let failRootRemovals = 0;

  return {
    configure(requests: readonly HelperRequest[], failedRemovals = 0) {
      events.length = 0;
      startedRequests.clear();
      failRootRemovals = failedRemovals;
      started = new Promise((resolve) => {
        acknowledge = resolve;
      });
      helpers = new Map(
        requests.map((request) => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          return [request.arguments.join(" "), { ...request, gate, release }];
        }),
      );
    },
    waitUntilStarted: () => started,
    release() {
      for (const helper of helpers.values()) helper.release();
    },
    releaseHelper(pid: number) {
      const helper = helpers.get(String(pid));
      if (helper === undefined) throw new Error(`Unexpected helper PID ${pid}`);
      helper.release();
    },
    remove(path: string) {
      if (path.includes("rea-process-token-")) {
        events.push(`remove:${path}`);
        if (failRootRemovals > 0) {
          failRootRemovals -= 1;
          throw new Error("fixture root removal failure");
        }
      }
    },
    get events() {
      return [...events];
    },
    async run(commandPath: string, args: readonly string[]) {
      if (basename(commandPath) === "fixture-swiftc") {
        const output = args[args.indexOf("-o") + 1];
        if (output === undefined) throw new Error("Missing helper output path");
        const fs = await import("node:fs/promises");
        await fs.writeFile(output, "fixture helper");
        return { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 };
      }
      const request = args.join(" ");
      const helper = helpers.get(request);
      if (helper === undefined || startedRequests.has(request))
        throw new Error(`Unexpected helper request ${request}`);
      startedRequests.add(request);
      events.push(`start:${request}`);
      if (startedRequests.size === helpers.size) acknowledge();
      try {
        await helper.gate;
        if (helper.failure !== undefined) throw helper.failure;
        const stdout = JSON.stringify({ results: helper.rows });
        return {
          stdout,
          stderr: "",
          stdoutBytes: Buffer.byteLength(stdout),
          stderrBytes: 0,
        };
      } finally {
        events.push(`finalized:${request}`);
      }
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rm: async (...args: Parameters<typeof original.rm>) => {
      command.remove(String(args[0]));
      return original.rm(...args);
    },
  };
});

vi.mock("./ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ExecFileOutput.js")>()),
  execFileOutput: command.run,
}));

import { createDarwinProcessRunTokenReader } from "./DarwinProcessRunTokenReader.js";

const createReader = () =>
  createDarwinProcessRunTokenReader({
    compiler: {
      kind: "swiftc",
      executable: join(tmpdir(), "fixture-swiftc"),
      sdkRoot: tmpdir(),
    },
    environment: {},
  });

it("joins native identity observation before close and distinguishes absence from a live generation", async () => {
  command.configure([
    {
      arguments: ["--identities", "123", "124"],
      rows: [
        {
          pid: 123,
          state: "readable",
          identity: "start:456",
          lifecycle: "non-zombie",
          relation: { state: "observed", parent_pid: 1, process_group_id: 123 },
        },
        {
          pid: 124,
          state: "absent",
          identity: null,
          reason: "not-in-snapshot",
        },
      ],
    },
  ]);
  const reader = createReader();
  const processes = [{ pid: 123 }, { pid: 124 }];
  const observing = reader.identities(processes);
  let closing: Promise<void> | undefined;
  try {
    await awaitAcknowledgement(
      command.waitUntilStarted(),
      observing,
      "identity helper",
    );
    const closed = vi.fn<() => void>();
    closing = reader.close().then(closed);
    void closing.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).not.toHaveBeenCalled();

    command.release();
    await expect(observing).resolves.toEqual(
      new Map<number, unknown>([
        [
          123,
          {
            state: "readable",
            identity: "start:456",
            lifecycle: { state: "observed", lifecycle: "non-zombie" },
            relation: { state: "observed", parentPid: 1, processGroupId: 123 },
          },
        ],
        [124, { state: "absent", reason: "not-in-snapshot" }],
      ]),
    );
    await closing;
    expect(command.events).toEqual([
      "start:--identities 123 124",
      "finalized:--identities 123 124",
      expect.stringMatching(/^remove:/u),
    ]);
    await expect(reader.identities(processes)).rejects.toThrow("closed");
  } finally {
    command.release();
    await Promise.allSettled([observing, closing, reader.close()]);
  }
});

it("drains mixed token read outcomes and retries only the failed root removal", async () => {
  const helperFailure = new Error("fixture helper failure");
  command.configure(
    [
      {
        arguments: ["123"],
        rows: [{ pid: 123, state: "readable", run_id: "run" }],
      },
      { arguments: ["124"], failure: helperFailure },
    ],
    1,
  );
  const reader = createReader();
  const failed = reader.read([{ pid: 124 }]);
  const successful = reader.read([{ pid: 123 }]);
  let closing: Promise<void> | undefined;
  try {
    await awaitAcknowledgement(
      command.waitUntilStarted(),
      Promise.race([failed, successful]),
      "both token helpers",
    );
    closing = reader.close();
    void closing.catch(() => undefined);
    command.releaseHelper(124);
    await expect(failed).rejects.toBe(helperFailure);
    expect(command.events).not.toContainEqual(
      expect.stringMatching(/^remove:/u),
    );

    command.releaseHelper(123);
    await expect(successful).resolves.toEqual(
      new Map([[123, { state: "readable", runId: "run" }]]),
    );
    const closeFailure = await closing.catch((cause: unknown) => cause);
    if (!(closeFailure instanceof ProviderCleanupError))
      throw new Error("Expected retained helper-root cleanup failure");
    expect(closeFailure.cleanupIncomplete).toBe(true);
    expect(closeFailure.cleanupResources).toHaveLength(1);
    const [root] = closeFailure.cleanupResources;
    if (root === undefined) throw new Error("Expected retained helper root");
    await access(root);
    expect(command.events.slice(-3)).toEqual([
      "finalized:124",
      "finalized:123",
      `remove:${root}`,
    ]);

    const before = command.events;
    await reader.close();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(closeFailure.cleanupIncomplete).toBe(false);
    expect(command.events).toEqual([...before, `remove:${root}`]);
    await expect(reader.read([{ pid: 123 }])).rejects.toThrow("closed");
  } finally {
    command.release();
    await Promise.allSettled([failed, successful, closing, reader.close()]);
  }
});
