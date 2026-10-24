import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { liveProcesses } from "../../../src/process/ProcessOwnershipProcessTree.js";
import { systemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

processTest.skipIf(process.platform === "win32")(
  "releases a cold source loader before verifying command cleanup",
  async ({ processes }) => {
    const commandsModule = pathToFileURL(
      resolve("scripts/lib/verify-package-commands.mjs"),
    ).href;
    const verifierModule = pathToFileURL(
      resolve("scripts/lib/verifier-run.mjs"),
    ).href;
    const result = await processes.run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { createPackageVerifierCommands } from ${JSON.stringify(commandsModule)};
      import { createVerifierRun, completeVerifierRun } from ${JSON.stringify(verifierModule)};
      const run = createVerifierRun();
      const path = await mkdtemp(join(tmpdir(), "rea-cold-verifier-"));
      const commands = await createPackageVerifierCommands({ workspace: { path, close: () => rm(path, { recursive: true, force: true }) } });
      try {
        await commands.exec(process.execPath, ["-e", "process.stdout.write('ok')"]);
      } finally {
        await commands.close();
      }
      console.log(JSON.stringify(await completeVerifierRun(run)));
    `,
      ],
      { env: { ...process.env, TSX_DISABLE_CACHE: "1" }, timeoutMs: 20_000 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      process_lineage: { status: "verified", descendants: [] },
    });
  },
);

const descendantSource = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const record = (entry) => appendFileSync(process.env.OWNER_EVENTS, JSON.stringify(entry) + "\\n");
const finish = (reason) => {
  record({ kind: "descendant-exit", reason, rootExists: existsSync(process.env.OWNER_ROOT) });
  process.exit(0);
};
process.on("SIGTERM", () => finish("SIGTERM"));
writeFileSync(process.env.OWNER_DESCENDANT, String(process.pid));
process.send({ pid: process.pid });
setInterval(() => {
  if (existsSync(process.env.OWNER_RELEASE)) finish("fixture-release");
}, 25);
setTimeout(() => finish("fixture-deadline"), 20000);
`;

const npmSource = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
process.once("SIGTERM", () => {
  appendFileSync(process.env.OWNER_EVENTS, JSON.stringify({ kind: "leader-exit", rootExists: existsSync(process.env.OWNER_ROOT) }) + "\\n");
  process.kill(process.pid, "SIGTERM");
});
const child = spawn(process.execPath, [process.env.OWNER_DESCENDANT_ENTRY], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
const ready = await new Promise((resolve, reject) => {
  child.once("message", resolve);
  child.once("error", reject);
});
writeFileSync(process.env.OWNER_READY, JSON.stringify({ pids: [process.pid, ready.pid] }));
process.stdout.write("npm descendant ready\\n");
process.stderr.write("selected npm diagnostics\\n");
setInterval(() => {}, 1000);
`;

const reportSchema = z.object({
  pids: z.array(z.number().int().positive()).length(2),
  liveAtRemoval: z.array(z.number().int().positive()),
  rootRemoved: z.boolean(),
  failure: z.object({
    reason: z.literal("timeout"),
    stdout: z.string(),
    stderr: z.string(),
  }),
});

const stopReceiptSchema = z.object({
  kind: z.enum(["leader-exit", "descendant-exit"]),
  rootExists: z.boolean(),
  reason: z.string().optional(),
});

processTest
  .skipIf(process.platform !== "linux")
  .for(["package", "shared"] as const)(
  "releases the cold TypeScript compiler across package/%s scopes before reporting cleanup",
  { timeout: 30_000 },
  async (secondScope, { processes }) => {
    const root = await createTestTempDirectory("rea-package-loader-owner-");
    const driver = join(root, "driver.mjs");
    const commandsModule = pathToFileURL(
      resolve("scripts/lib/verify-package-commands.mjs"),
    ).href;
    const lineageModule = pathToFileURL(
      resolve("scripts/lib/verifier-run.mjs"),
    ).href;
    const sharedCommandsModule = pathToFileURL(
      resolve("scripts/lib/verify-commands.mjs"),
    ).href;
    const sourceLoaderModule = pathToFileURL(
      resolve("scripts/lib/verifier-source-loader.mjs"),
    ).href;
    const cleanupModule = pathToFileURL(
      resolve("scripts/lib/verifier-cleanup.mjs"),
    ).href;
    const tsxModule = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/esm/api"),
    ).href;
    const tsxPackage = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx/package.json"),
    ).href;
    const lateSource = join(root, "late.ts");
    await writeFile(lateSource, "export const value: number = 42;\n");
    await writeFile(
      driver,
      `import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createPackageVerifierCommands } from ${JSON.stringify(commandsModule)};
import { createVerifierCommands } from ${JSON.stringify(sharedCommandsModule)};
import { importVerifierSource } from ${JSON.stringify(sourceLoaderModule)};
import { createVerifierRun, completeVerifierRun } from ${JSON.stringify(lineageModule)};
import { withVerifierCleanup, closeVerifierResources } from ${JSON.stringify(cleanupModule)};
import { tsImport } from ${JSON.stringify(tsxModule)};
const run = createVerifierRun();
const workspaces = await Promise.all([0, 1].map(async index => ({
  path: await mkdtemp(join(${JSON.stringify(root)}, "scope-" + index + "-")),
  async close() { await rm(this.path, { recursive: true, force: true }); },
})));
let owners = [], output, lateValues, peerResult, releasePeer;
await withVerifierCleanup(async () => {
  owners = await Promise.all([
    createPackageVerifierCommands({ workspace: workspaces[0] }),
    ${secondScope === "package" ? "createPackageVerifierCommands({ workspace: workspaces[1] })" : "createVerifierCommands()"},
  ]);
  output = await Promise.all(owners.map((owner, index) => owner.exec(
    process.execPath, ["-e", "process.stdout.write(" + JSON.stringify(String(index)) + ")"],
    { timeout: 5000 },
  )));
  const compiler = createRequire(${JSON.stringify(tsxPackage)})("esbuild");
  let acknowledgePeer;
  const peerReady = new Promise(resolve => { acknowledgePeer = resolve; });
  const peerGate = new Promise(resolve => { releasePeer = resolve; });
  const peer = compiler.build({
    stdin: { contents: "export const peer: number = 7;", loader: "ts" },
    write: false,
    plugins: [{ name: "hold-peer", setup(build) {
      build.onStart(async () => { acknowledgePeer(); await peerGate; });
    } }],
  }).then(
    value => ({ ok: true, code: value.outputFiles[0].text }),
    cause => ({ ok: false, reason: cause.message }),
  );
  await peerReady;
  await owners[0].close();
  const tracked = await importVerifierSource(${JSON.stringify(pathToFileURL(lateSource).href)}, import.meta.url);
  releasePeer();
  peerResult = await peer;
  const late = await tsImport(${JSON.stringify(pathToFileURL(lateSource).href)}, import.meta.url);
  lateValues = [tracked.value, late.value];
}, [async () => {
  releasePeer?.();
  await closeVerifierResources(owners.map(owner => () => owner.close()));
  await closeVerifierResources(workspaces.map(workspace => () => workspace.close()));
}]);
console.log(JSON.stringify({ output: output.map(item => item.stdout), lateValues, peerResult, verifier: await completeVerifierRun(run) }));
`,
    );
    const result = await processes.run(process.execPath, [driver], {
      timeoutMs: 25_000,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      output: ["0", "1"],
      lateValues: [42, 42],
      peerResult: { ok: true, code: expect.stringContaining("peer = 7") },
      verifier: { process_lineage: { status: "verified", descendants: [] } },
    });
  },
);

const releaseDescendant = async (release: string, receipt: string) => {
  await writeFile(release, "release this authored descendant");
  const pid = await readFile(receipt, "utf8").then(Number, (cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  });
  if (pid === undefined) return;
  const deadline = Date.now() + 7_500;
  while (
    liveProcesses(await systemProcessOwnershipHost.listProcesses()).some(
      (entry) => entry.pid === pid,
    )
  ) {
    if (Date.now() >= deadline)
      throw new Error(
        "Authored npm descendant did not consume its release marker",
      );
    await delay(25);
  }
};

// Actual npm-entry/descendant processes and actual scratch removal; no package
// install, native engine, or WABT behavior is simulated or claimed.
processTest.skipIf(process.platform === "win32")(
  "joins a timed-out npm entry and its acknowledged descendant before removing the verifier root",
  { timeout: 30_000 },
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-package-command-owner-");
    const scratch = join(root, "scratch");
    const entry = join(root, "selected npm entry.mjs");
    const descendant = join(root, "descendant.mjs");
    const release = join(root, "release-descendant");
    const receipt = join(root, "descendant.pid");
    const ready = join(root, "ready.json");
    const events = join(root, "events.jsonl");
    const driver = join(root, "driver.mjs");
    await writeFile(entry, npmSource);
    await writeFile(descendant, descendantSource);
    const commandsModule = pathToFileURL(
      resolve("scripts/lib/verify-package-commands.mjs"),
    ).href;
    const cleanup = pathToFileURL(
      resolve("scripts/lib/verifier-cleanup.mjs"),
    ).href;
    const observations = pathToFileURL(
      resolve("dist/process/ProcessOwnershipObservation.js"),
    ).href;
    const tree = pathToFileURL(
      resolve("dist/process/ProcessOwnershipProcessTree.js"),
    ).href;
    await writeFile(
      driver,
      `
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createPackageVerifierCommands } from ${JSON.stringify(commandsModule)};
import { withVerifierCleanup } from ${JSON.stringify(cleanup)};
import { systemProcessOwnershipHost } from ${JSON.stringify(observations)};
import { liveProcesses } from ${JSON.stringify(tree)};
const scratch = process.env.OWNER_ROOT;
await mkdir(scratch);
let commands, recoveryOwner, pids, liveAtRemoval, failure, diagnostics;
const workspace = {
  path: scratch,
  async close() {
    const ready = await readFile(process.env.OWNER_READY, "utf8").then(JSON.parse, cause => {
      if (cause.code === "ENOENT") return { pids: [] };
      throw cause;
    });
    pids = ready.pids;
    liveAtRemoval = liveProcesses(await systemProcessOwnershipHost.listProcesses()).filter(({ pid }) => pids.includes(pid)).map(({ pid }) => pid);
    await rm(scratch, { recursive: true, force: true });
  },
};
try {
  await withVerifierCleanup(
    async () => {
      commands = await createPackageVerifierCommands({ workspace });
      await commands.execNpm(["pack", "caller value with spaces"], { cwd: scratch, env: process.env, timeout: 1500 });
    },
    [async () => {
      if (commands === undefined) await rm(scratch, { recursive: true, force: true });
      else await commands.close();
    }],
  );
} catch (cause) {
  const failures = cause instanceof AggregateError ? cause.errors : [cause];
  // Capture exact cleanup authority before projecting facts or making assertions.
  recoveryOwner = failures.find(error => typeof error?.cleanupOwner?.close === "function")?.cleanupOwner ?? commands;
  const primary = failures.find(error => error?.snapshot !== undefined && typeof error?.reason === "string");
  failure = { reason: primary?.reason, stdout: primary?.snapshot?.stdout.text, stderr: primary?.snapshot?.stderr.text };
  diagnostics = failures.map(error => ({
    name: error?.name ?? typeof error,
    message: error?.message ?? String(error),
    reason: error?.reason,
    snapshotAvailable: error?.snapshot !== undefined && error?.snapshot !== null,
    stack: error?.stack,
    cleanupFailure: error?.cleanupFailure,
    processError: error?.processError?.message,
    preparationFailure: error?.preparationFailure?.message,
    cause: {
      name: error?.cause?.name,
      message: error?.cause?.message ?? String(error?.cause),
      stack: error?.cause?.stack,
      cause: error?.cause?.cause?.message ?? String(error?.cause?.cause),
    },
  }));
} finally {
  if (recoveryOwner !== undefined) await recoveryOwner.close();
  else if (commands !== undefined) await commands.close();
  else await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ pids, liveAtRemoval, rootRemoved: !existsSync(scratch), failure, diagnostics }));
`,
    );
    try {
      const result = await processes.run(process.execPath, [driver], {
        timeoutMs: 20_000,
        env: {
          ...process.env,
          npm_execpath: entry,
          OWNER_ROOT: scratch,
          OWNER_DESCENDANT_ENTRY: descendant,
          OWNER_DESCENDANT: receipt,
          OWNER_RELEASE: release,
          OWNER_READY: ready,
          OWNER_EVENTS: events,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.signal, result.stderr).toBeNull();
      const parsed = reportSchema.safeParse(JSON.parse(result.stdout));
      expect(parsed.success, result.stdout).toBe(true);
      if (!parsed.success) throw parsed.error;
      const report = parsed.data;
      expect(report.failure).toEqual({
        reason: "timeout",
        stdout: "npm descendant ready\n",
        stderr: "selected npm diagnostics\n",
      });
      expect(report.liveAtRemoval).toEqual([]);
      expect(report.rootRemoved).toBe(true);
      const receipts = await readFile(events, "utf8").catch(
        (cause: unknown) => {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
            return "";
          throw cause;
        },
      );
      const stopped = receipts
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => stopReceiptSchema.parse(JSON.parse(line)));
      for (const receipt of stopped) expect(receipt.rootExists).toBe(true);
    } finally {
      await releaseDescendant(release, receipt);
    }
  },
);
