import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { createEvidence } from "../../dist/domain/evidence.js";
import { settleCommandOwners, withCommands } from "../command-scope.mjs";
import {
  FIXTURE_PACKAGE,
  MIRROR_FIXTURE_PACKAGE,
  withFixture,
} from "./fixture.mjs";

const identity = {
  binary_path: "adb",
  path_source: "path",
  version: "test",
  installed_path: null,
};
const evidence = (operation, parameters, result) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Scripted boundary", version: "1" },
    {
      operation,
      parameters,
      result,
      subjectUnavailableReason: "Synthetic lifecycle fixture",
    },
  );

// Real filesystem snapshots and MCP wire calls; device/inspector outcomes are
// scripted to reproduce failures a successful emulator run cannot establish.
async function harness(t, settings = {}) {
  const packageName = settings.package ?? FIXTURE_PACKAGE;
  const root = await mkdtemp(join(tmpdir(), "rea-ui-lifecycle-"));
  const apk = join(root, "source.apk");
  const output = join(root, "result");
  await mkdir(output);
  await writeFile(apk, "admitted fixture bytes");
  const state = {
    installed: settings.present ?? false,
    installs: 0,
    uninstalls: 0,
    inventories: 0,
    commands: [],
    retainedLeases: [],
  };
  const server = new McpServer({ name: "ui-lifecycle-fixture", version: "1" });
  const client = new Client({ name: "ui-lifecycle-test", version: "1" });
  const [transport, peer] = InMemoryTransport.createLinkedPair();
  for (const name of [
    "resolve_adb_packages",
    "uninstall_adb_package",
    "inspect_adb_window",
  ]) {
    server.registerTool(
      name,
      { inputSchema: toolContract(name).inputSchema },
      async (input, context) => {
        let result;
        if (name === "resolve_adb_packages") {
          state.inventories++;
          result = {
            client: identity,
            serial: input.serial,
            query: input.query,
            matches: state.installed
              ? [
                  {
                    package_name: packageName,
                    base_apk_device_path: "/data/app/fixture/base.apk",
                  },
                ]
              : [],
            unparsed_lines: [],
            exact_match: state.installed,
            coverage: "complete",
            ...settings.inventory?.(state),
          };
        } else if (name === "uninstall_adb_package") {
          assert.equal(input.package, packageName);
          assert.equal(
            context.mcpReq.signal.aborted,
            false,
            "cleanup received workflow cancellation",
          );
          state.uninstalls++;
          if (settings.uninstallError) throw settings.uninstallError;
          state.installed = false;
          result = {
            client: identity,
            serial: input.serial,
            package_name: input.package,
          };
        } else {
          assert(settings.window, "unexpected window operation");
          await settings.window(context.mcpReq.signal);
          result = {
            client: identity,
            serial: input.serial,
            focused_window: null,
            focused_app: null,
            observed_lines: [],
          };
        }
        return {
          content: [],
          structuredContent: evidence(name, input, result),
        };
      },
    );
  }
  await server.connect(peer);
  t.after(async () => {
    await client.close();
    await server.close();
    for (const lease of state.retainedLeases) await lease.release();
    await rm(root, { recursive: true, force: true });
  });
  const run = async (command, args) => {
    state.commands.push({ command, args });
    if (command === "aapt2") {
      assert.deepEqual(args.slice(0, 2), ["dump", "packagename"]);
      assert.equal(await readFile(args[2], "utf8"), "admitted fixture bytes");
      await settings.afterInspection?.(apk);
      return {
        stdout: `${packageName}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "-s") {
      assert.deepEqual(args.slice(2), ["shell", "getprop", "ro.kernel.qemu"]);
      return { stdout: "1\n", stderr: "", code: 0 };
    }
    assert.equal(command, process.execPath);
    assert.equal(args[1], "install-adb-package");
    const snapshot = args[3];
    assert.notEqual(snapshot, apk);
    const snapshotBytes = await readFile(snapshot);
    assert.equal(snapshotBytes.toString("utf8"), "admitted fixture bytes");
    state.installs++;
    state.installed = true; // Device commit can precede any host outcome.
    if (settings.install) return settings.install(state);
    return {
      stdout: JSON.stringify(
        evidence(
          "install_adb_package",
          {},
          {
            client: identity,
            serial: args[2],
            apk_path: snapshot,
            sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
            bytes: snapshotBytes.length,
            replace_requested: false,
            replaced: null,
          },
        ),
      ),
      stderr: "",
      code: 0,
    };
  };
  const options = {
    apk,
    aapt2: "aapt2",
    output,
    serial: "emulator-5554",
    environment: { REA_ADB_PATH: " \t" },
    client,
    transport,
    run,
    signal: new AbortController().signal,
    settleCommands: async () => {}, // Scripted commands have no live children.
    leaseDirectory: join(root, "leases"),
    ...(settings.expectedPackage === undefined
      ? {}
      : { expectedPackage: settings.expectedPackage }),
    ...(settings.hashFile === undefined ? {} : { hashFile: settings.hashFile }),
  };
  return { options, state };
}

test("rejects other APK packages and incomplete or pre-existing inventory before installation", async (t) => {
  for (const settings of [
    { package: "com.other.app" },
    { package: MIRROR_FIXTURE_PACKAGE },
    { expectedPackage: MIRROR_FIXTURE_PACKAGE },
    { expectedPackage: "com.other.app" },
    { inventory: () => ({ coverage: "partial", matches: [] }) },
    { present: true },
  ]) {
    const h = await harness(t, settings);
    await assert.rejects(
      withFixture(h.options, () => assert.fail("must not run")),
      /fixture package|incomplete|already be installed/u,
    );
    assert.equal(h.state.installs, 0);
    assert.equal(h.state.uninstalls, 0);
  }
});

test("owns the mirror fixture only when its exact package was selected", async (t) => {
  const h = await harness(t, {
    package: MIRROR_FIXTURE_PACKAGE,
    expectedPackage: MIRROR_FIXTURE_PACKAGE,
  });
  const selected = await withFixture(
    h.options,
    ({ fixture }) => fixture.package,
  );
  assert.equal(selected, MIRROR_FIXTURE_PACKAGE);
  assert.equal(h.state.installs, 1);
  assert.equal(h.state.uninstalls, 1);
  assert.equal(h.state.installed, false);
});

test("passes cancellation to hash admission and retains its failed close owner for retry", async (t) => {
  let failing = true;
  let closes = 0;
  const primary = new Error("hash descriptor close failed");
  const owner = {
    async close() {
      closes++;
      if (failing) throw primary;
    },
  };
  let selectedSignal;
  const h = await harness(t, {
    hashFile: async (_path, options) => {
      selectedSignal = options.signal;
      options.retainFailedClose(owner);
      throw primary;
    },
  });
  let failure;
  await assert.rejects(
    withFixture(h.options, () => assert.fail("must not install")),
    (error) => {
      failure = error;
      assert.equal(error.cause, primary);
      assert.equal(error.cleanupResources.size, 1);
      return true;
    },
  );
  assert.equal(selectedSignal, h.options.signal);
  assert.equal(h.state.installs, 0);
  assert.equal(closes, 1);
  failing = false;
  for (const resource of failure.cleanupResources) await resource.close();
  assert.equal(closes, 2);
});

test("installs the inspected snapshot even if the source is replaced, using canonical blank adb selection", async (t) => {
  const h = await harness(t, {
    afterInspection: (source) => writeFile(source, "replacement APK"),
  });
  const result = await withFixture(h.options, ({ fixture }) => fixture.source);
  assert.equal(h.state.commands[1].command, "adb");
  assert.equal(result.bytes, Buffer.byteLength("admitted fixture bytes"));
  assert.equal(await readFile(h.options.apk, "utf8"), "replacement APK");
  assert.equal(h.state.uninstalls, 1);
  assert.equal(h.state.installed, false);
  assert.equal(
    JSON.parse(
      await readFile(join(h.options.output, "fixture-cleanup.json"), "utf8"),
    ).status,
    "absent",
  );
});

test("reconciles a committed install after command cancellation, malformed JSON or invalid Evidence", async (t) => {
  const cancelled = new Error("install cancelled after device commit");
  for (const install of [
    () => {
      throw cancelled;
    },
    () => ({ stdout: "{broken" }),
    () => ({ stdout: "{}" }),
  ]) {
    const h = await harness(t, { install });
    await assert.rejects(
      withFixture(h.options, () => assert.fail("must not run")),
    );
    assert.equal(h.state.uninstalls, 1);
    assert.equal(h.state.installed, false);
    assert.equal(h.state.inventories, 3);
  }
});

test("partial post-uninstall inventory cannot prove cleanup or discard the retained owner", async (t) => {
  const h = await harness(t, {
    inventory: ({ inventories }) =>
      inventories === 3 ? { coverage: "partial", matches: [] } : {},
  });
  await assert.rejects(
    withFixture(h.options, () => "verified"),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.errors[0].message, /incomplete/u);
      assert.equal(error.cleanupOwner.package, FIXTURE_PACKAGE);
      assert.equal(error.cleanupOwner.serial, "emulator-5554");
      h.state.retainedLeases.push(error.cleanupLease);
      return true;
    },
  );
  assert.equal(
    JSON.parse(
      await readFile(join(h.options.output, "fixture-cleanup.json"), "utf8"),
    ).status,
    "install-attempted",
  );
});

test("retains the verification failure alongside uninstall and close failures", async (t) => {
  const primary = new Error("tap assertion failed");
  const closeError = new Error("client close failed");
  const h = await harness(t, { uninstallError: new Error("device offline") });
  const actualClose = h.options.client.close.bind(h.options.client);
  h.options.client.close = async () => {
    await actualClose();
    throw closeError;
  };
  try {
    await assert.rejects(
      withFixture(h.options, () => {
        throw primary;
      }),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.equal(error.errors[0], primary);
        assert.match(error.errors[1].message, /device offline/u);
        assert.equal(error.errors[2], closeError);
        assert.equal(error.cleanupOwner.package, FIXTURE_PACKAGE);
        h.state.retainedLeases.push(error.cleanupLease);
        return true;
      },
    );
  } finally {
    h.options.client.close = actualClose;
  }
});

test("failed connection still attempts both closes and preserves all failures", async () => {
  const failures = [
    new Error("connect"),
    new Error("client close"),
    new Error("transport close"),
  ];
  await assert.rejects(
    withFixture(
      {
        output: "/unused",
        environment: {},
        signal: new AbortController().signal,
        settleCommands: async () => {},
        client: {
          connect: async () => {
            throw failures[0];
          },
          close: async () => {
            throw failures[1];
          },
        },
        transport: {
          close: async () => {
            throw failures[2];
          },
        },
      },
      () => assert.fail("must not run"),
    ),
    (error) => {
      assert.deepEqual(error.errors, failures);
      assert.equal(error.cause, failures[0]);
      return true;
    },
  );
});

test(
  "SIGINT cancels an in-flight MCP request and cleanup uses an independent deadline",
  { timeout: 5_000 },
  async (t) => {
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const h = await harness(t, {
      window: async (signal) => {
        started.resolve();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        cancelled.resolve();
      },
    });
    const pending = withCommands((_run, signal, settleCommands) =>
      withFixture({ ...h.options, signal, settleCommands }, ({ call }) =>
        call("inspect_adb_window", { serial: h.options.serial }),
      ),
    );
    const rejected = assert.rejects(pending, /cancel/iu);
    await started.promise;
    process.emit("SIGINT");
    await rejected;
    await cancelled.promise;
    assert.equal(h.state.uninstalls, 1);
    assert.equal(h.state.installed, false);
  },
);

test("settles a retained installer before reconciling its late package commit", async (t) => {
  const retained = new Set();
  const primary = new Error("install command cancelled with pending cleanup");
  const h = await harness(t, {
    install(state) {
      state.installed = false;
      retained.add({
        async stop() {
          state.installed = true;
          return { status: "terminated" };
        },
      });
      throw primary;
    },
  });
  h.options.settleCommands = () => settleCommandOwners(retained);
  await assert.rejects(
    withFixture(h.options, () => assert.fail("must not run")),
    (error) => error === primary,
  );
  assert.equal(retained.size, 0);
  assert.equal(h.state.uninstalls, 1);
  assert.equal(h.state.installed, false);
  assert.equal(
    JSON.parse(
      await readFile(join(h.options.output, "fixture-cleanup.json"), "utf8"),
    ).status,
    "absent",
  );
});

test("unsettled installers retain package and lease identity without claiming absence", async (t) => {
  const stopResult = {
    status: "incomplete",
    reason: "process identity is unresolved",
    cleanupResult: {
      cleaned: false,
      reason: "cannot verify descendant start time",
    },
  };
  const installer = { stop: async () => stopResult };
  const retained = new Set([installer]);
  const primary = new Error("install command timed out");
  const h = await harness(t, {
    install(state) {
      state.installed = false;
      throw primary;
    },
  });
  h.options.settleCommands = () => settleCommandOwners(retained);
  await assert.rejects(
    withFixture(h.options, () => assert.fail("must not run")),
    asyncError,
  );
  function asyncError(error) {
    assert.equal(error.cause, primary);
    assert.equal(error.errors[1].errors[0].stopResult, stopResult);
    assert.match(
      error.errors[1].errors[0].message,
      /process identity is unresolved/u,
    );
    assert.equal(error.errors[1].cleanupOwners, retained);
    assert.equal(error.cleanupOwner.package, FIXTURE_PACKAGE);
    h.state.retainedLeases.push(error.cleanupLease);
    return true;
  }
  assert.equal(
    h.state.inventories,
    1,
    "cleanup queried before the installer settled",
  );
  assert.equal(h.state.uninstalls, 0);
  // Even if the outer scope's final retry later succeeds, no earlier absence
  // observation may have discarded the package identity or released admission.
  installer.stop = async () => {
    h.state.installed = true;
    return { status: "terminated" };
  };
  await settleCommandOwners(retained);
  const journal = JSON.parse(
    await readFile(join(h.options.output, "fixture-cleanup.json"), "utf8"),
  );
  assert.equal(journal.status, "install-attempted");
  assert.equal(
    JSON.parse(await readFile(journal.owner.lease.path, "utf8")).run_id,
    journal.owner.lease.run_id,
  );
});

test("a competing verifier cannot admit or uninstall the active run's fixture", async (t) => {
  const first = await harness(t);
  const second = await harness(t);
  second.options.leaseDirectory = first.options.leaseDirectory;
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const active = withFixture(first.options, async () => {
    started.resolve();
    await finish.promise;
  });
  try {
    await started.promise;
    await assert.rejects(
      withFixture(second.options, () => assert.fail("must not run")),
      /Fixture lease is unavailable/u,
    );
    assert.equal(second.state.inventories, 0);
    assert.equal(second.state.installs, 0);
    assert.equal(second.state.uninstalls, 0);
    assert.equal(first.state.installed, true);
  } finally {
    finish.resolve();
    await active;
  }
  assert.equal(first.state.installed, false);
});
