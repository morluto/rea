#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32")
  throw new Error(
    "Windows native conformance requires a real Windows x64 host.",
  );
const packageRoot = resolve(process.argv[2] ?? ".");
const { requireWindowsNativeAuthority } = await import(
  pathToFileURL(join(packageRoot, "dist/windows/WindowsNativeLoader.js"))
);
const native = requireWindowsNativeAuthority();
const { WindowsPrivateRuntime } = await import(
  pathToFileURL(join(packageRoot, "dist/windows/WindowsPrivateRuntime.js"))
);
const workspace = await mkdtemp(join(tmpdir(), "rea-native-conformance-"));
const environment = Object.entries(process.env)
  .filter(([, value]) => value !== undefined)
  .map(([key, value]) => `${key}=${value}`);
const quote = (value) =>
  `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const live = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const launch = (arguments_) =>
  native.call("process_spawn", [
    process.execPath,
    [process.execPath, ...arguments_].map(quote).join(" "),
    workspace,
    environment,
  ]);
const wait = async (child) => {
  let output = "";
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = native.call("process_poll", [child.handle]);
    output += state.stdout.toString();
    if (
      state.exitCode !== null &&
      state.activeProcesses === 0 &&
      state.stdoutEnded &&
      state.stderrEnded
    )
      return { ...state, output };
    await delay();
  }
  throw new Error("Owned job did not settle within the fixture deadline.");
};
const report = { ok: false, artifact: "verified", controls: {}, processes: {} };
try {
  const sourceDirectory = join(workspace, "source");
  await mkdir(sourceDirectory);
  const source = join(sourceDirectory, "target.bin");
  await writeFile(source, Buffer.alloc(1024 * 1024, 0x37));
  const sourceIdentity = native.call("open", [source]);
  try {
    for (const requested of [
      source.replaceAll("\\", "/"),
      source.replace(/\\/u, "/"),
    ]) {
      const admitted = native.call("open", [requested]);
      try {
        assert.equal(admitted.requestedPath, requested);
        assert.equal(admitted.finalPath, sourceIdentity.finalPath);
        assert.equal(admitted.fileId, sourceIdentity.fileId);
        assert.equal(native.call("read", [admitted.handle, 0, 1])[0], 0x37);
      } finally {
        native.call("close", [admitted.handle]);
      }
    }
  } finally {
    native.call("close", [sourceIdentity.handle]);
  }
  for (const rejected of [
    source.replace(/^([A-Za-z]):\\/u, "$1:"),
    `${sourceDirectory}/../source/target.bin`,
    `${sourceDirectory}//target.bin`,
    `${source}:stream`,
    `\\\\?\\${source.replaceAll("\\", "/")}`,
    "//localhost/share/target.bin",
  ])
    assert.throws(() => native.call("open", [rejected]));
  report.controls.ordinaryDriveSeparatorsAndRequestedIdentity = true;
  const snapshotOwner = WindowsPrivateRuntime.create(
    workspace.replace(/\\/u, "/"),
    "single-flight-",
  );
  try {
    const rejectedController = new AbortController();
    const requestedSource = source.replaceAll("\\", "/");
    const accepted = snapshotOwner.snapshot(requestedSource, "accepted.bin");
    const rejected = snapshotOwner.snapshot(
      source,
      "rejected.bin",
      rejectedController.signal,
    );
    rejectedController.abort();
    await assert.rejects(rejected, /Runtime snapshot is still pending/u);
    const completed = await accepted;
    assert.equal(completed.source.requestedPath, requestedSource);
    assert.equal(
      completed.sha256,
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    );
    assert.equal(
      await exists(join(snapshotOwner.observation.path, "rejected.bin")),
      false,
    );
    report.controls.singleFlightCancellationOwnership = true;
  } finally {
    await snapshotOwner.close();
  }
  const unrelatedFile = join(workspace, "unrelated-file");
  await writeFile(unrelatedFile, "preserve unrelated writes");
  const admitted = native.call("open", [source]);
  try {
    await assert.rejects(
      rename(sourceDirectory, `${sourceDirectory}-replacement`),
    );
    await assert.rejects(open(source, "r+"));
    await rename(unrelatedFile, `${unrelatedFile}-renamed`);
    if (process.argv[3] !== undefined) {
      const observation = JSON.parse(
        execFileSync(
          resolve(process.argv[3]),
          ["reparse-directory", sourceDirectory, workspace],
          { encoding: "utf8" },
        ),
      );
      assert.equal(
        observation.reparseConversionDenied,
        true,
        "An admitted ancestor was converted into a junction.",
      );
      report.controls.inPlaceAncestorReparseDenied = true;
    }
    assert.throws(() => native.call("read", [{}, 0, 1]));
    assert.throws(() => native.call("read", [admitted.handle, NaN, 1]));
    assert.equal(native.call("read", [admitted.handle, 0, 1])[0], 0x37);
  } finally {
    native.call("close", [admitted.handle]);
  }
  assert.throws(() => native.call("read", [admitted.handle, 0, 1]));
  const junction = join(workspace, "junction");
  await symlink(sourceDirectory, junction, "junction");
  assert.throws(
    () => native.call("open", [join(junction, "target.bin")]),
    /Reparse/u,
  );
  assert.throws(() => native.call("open", [source + ":stream"]));
  const runtime = native.call("runtime_create", [
    workspace.replaceAll("\\", "/"),
    "private root with spaces-",
  ]);
  const sentinel = join(sourceDirectory, "sentinel");
  await writeFile(sentinel, "preserve");
  try {
    const acl = JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$a=Get-Acl -LiteralPath $env:REA_TEST_PRIVATE_RUNTIME_PATH; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; @{protected=$a.AreAccessRulesProtected; ownerMatchesUser=($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u.Value); trusteesOnlyUserAndSystem=(@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -ne $u.Value -and $_.IdentityReference.Value -ne 'S-1-5-18'}).Count -eq 0); count=@($a.Access).Count} | ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          // A pwsh caller can supply module paths incompatible with the
          // Windows PowerShell observer. Let that observer build its own path.
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => name.toLowerCase() !== "psmodulepath",
              ),
            ),
            REA_TEST_PRIVATE_RUNTIME_PATH: runtime.path,
          },
        },
      ),
    );
    assert.deepEqual(acl, {
      protected: true,
      ownerMatchesUser: true,
      trusteesOnlyUserAndSystem: true,
      count: 2,
    });
    native.call("runtime_mkdir", [runtime.handle, "inputs"]);
    native.call("runtime_write", [
      runtime.handle,
      "descriptor.json",
      Buffer.from("fixture"),
    ]);
    assert.throws(() =>
      native.call("runtime_write", [
        runtime.handle,
        "descriptor.json",
        Buffer.from("replace"),
      ]),
    );
    assert.throws(() =>
      native.call("runtime_mkdir", [runtime.handle, "..\\escape"]),
    );
    const pending = native.call("runtime_snapshot", [
      runtime.handle,
      source,
      "inputs\\target.bin",
    ]);
    assert.ok(pending instanceof Promise);
    assert.throws(
      () => native.call("runtime_close", [runtime.handle]),
      /pending/u,
    );
    const snapshot = await pending;
    assert.equal(
      snapshot.sha256,
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    );
    assert.equal(snapshot.source.requestedPath, source);
    await assert.rejects(
      writeFile(join(runtime.path, "inputs", "target.bin"), "replace"),
    );
    await symlink(
      sourceDirectory,
      join(runtime.path, "outside-junction"),
      "junction",
    );
    const cancelled = native.call("runtime_snapshot", [
      runtime.handle,
      source,
      "cancelled.bin",
    ]);
    native.call("runtime_snapshot_cancel", [runtime.handle]);
    await assert.rejects(cancelled, /cancelled/u);
    assert.equal(await exists(join(runtime.path, "cancelled.bin")), false);
    const readbackRuntime = WindowsPrivateRuntime.create(
      workspace.replaceAll("\\", "/"),
      "readback-",
    );
    try {
      readbackRuntime.writeFile("written.txt", "runtime-write-readback");
      assert.equal(
        readbackRuntime.readFile("written.txt"),
        "runtime-write-readback",
      );
      const readbackSnapshot = await readbackRuntime.snapshot(
        source,
        "snapshot.bin",
      );
      assert.equal(
        readbackSnapshot.sha256,
        createHash("sha256")
          .update(await readFile(source))
          .digest("hex"),
      );
      assert.equal(
        readbackRuntime.readFile("snapshot.bin"),
        await readFile(source, "utf8"),
      );
      const writtenPath = join(readbackRuntime.observation.path, "written.txt");
      await assert.rejects(writeFile(writtenPath, "replace"));
      await assert.rejects(rename(writtenPath, `${writtenPath}.renamed`));
      await assert.rejects(rm(writtenPath));
      assert.equal(
        readbackRuntime.readFile("written.txt"),
        "runtime-write-readback",
      );
      const snapshotPath = join(
        readbackRuntime.observation.path,
        "snapshot.bin",
      );
      await assert.rejects(rename(snapshotPath, `${snapshotPath}.renamed`));
      await assert.rejects(rm(snapshotPath));
      assert.equal(
        readbackRuntime.readFile("snapshot.bin"),
        await readFile(source, "utf8"),
      );
      report.controls = {
        ...report.controls,
        completedRuntimeFileReadback: true,
        completedRuntimeFileMutationDenied: true,
      };
    } finally {
      await readbackRuntime.close();
    }
    report.controls = {
      ...report.controls,
      protectedDaclReadback: true,
      sourceReplacementDenied: true,
      sourceWriteDenied: true,
      unrelatedFilesystemRenamePreserved: true,
      junctionAdmissionDenied: true,
      alternateStreamsDenied: true,
      forgedAndClosedHandlesDenied: true,
      immutableSnapshotDigest: true,
      asynchronousSnapshot: true,
      snapshotCancellation: true,
    };
  } finally {
    native.call("runtime_close", [runtime.handle]);
  }
  assert.equal(await exists(runtime.path), false);
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
  report.controls.cleanupDoesNotTraverseJunctions = true;
  const fixture = join(workspace, "tree.mjs");
  await writeFile(
    fixture,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const depth=Number(process.argv[2]); writeFileSync(process.argv[3]+depth,String(process.pid));
if(depth>0)spawn(process.execPath,[import.meta.filename,String(depth-1),process.argv[3]],{detached:true,stdio:'ignore'});
setInterval(()=>{},1000);\n`,
  );
  const pidPrefix = join(workspace, "pid-");
  const child = launch(["--max-old-space-size=128", fixture, "2", pidPrefix]);
  const unrelated = spawn(
    process.execPath,
    ["--max-old-space-size=128", "-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  try {
    for (
      let attempt = 0;
      attempt < 200 && !(await exists(pidPrefix + "0"));
      attempt++
    )
      await delay();
    const pids = await Promise.all(
      [0, 1, 2].map(async (depth) =>
        Number(await readFile(pidPrefix + depth, "utf8")),
      ),
    );
    assert.ok(native.call("process_poll", [child.handle]).activeProcesses >= 3);
    native.call("process_terminate", [child.handle]);
    assert.equal((await wait(child)).activeProcesses, 0);
    assert.equal(pids.some(live), false);
    assert.ok(unrelated.pid !== undefined && live(unrelated.pid));
    report.processes.descendantsAndDetachedDescendantsTerminated = true;
    report.processes.unrelatedProcessPreserved = true;
  } finally {
    native.call("process_terminate", [child.handle]);
    await wait(child);
    native.call("process_close", [child.handle]);
    if (unrelated.exitCode === null) {
      const closed = new Promise((resolve) => unrelated.once("close", resolve));
      unrelated.kill();
      await closed;
    }
  }
  const ownerClose = launch([
    "--max-old-space-size=128",
    fixture,
    "0",
    join(workspace, "owner-close-"),
  ]);
  native.call("process_close", [ownerClose.handle]);
  for (let attempt = 0; attempt < 100 && live(ownerClose.pid); attempt++)
    await delay();
  assert.equal(live(ownerClose.pid), false);
  report.processes.killOnOwnerClose = true;
  const exited = launch([
    "--max-old-space-size=128",
    "-e",
    "console.log('observed');process.exit(7)",
  ]);
  const settled = await wait(exited);
  assert.equal(settled.exitCode, 7);
  assert.match(settled.output, /observed/u);
  native.call("process_close", [exited.handle]);
  report.processes.normalExitAndOutput = true;
  const forwardCommand = process.execPath.replaceAll("\\", "/");
  const forwardProcess = native.call("process_spawn", [
    forwardCommand,
    [forwardCommand, "-e", "console.log('forward executable')"]
      .map(quote)
      .join(" "),
    workspace,
    environment,
  ]);
  try {
    const completed = await wait(forwardProcess);
    assert.equal(completed.exitCode, 0);
    assert.match(completed.output, /forward executable/u);
    report.processes.ordinaryDriveSeparators = true;
  } finally {
    native.call("process_close", [forwardProcess.handle]);
  }
  const boundaryFixture = process.argv[3];
  if (boundaryFixture !== undefined) {
    const before = JSON.parse(
      execFileSync(boundaryFixture, [], { encoding: "utf8" }),
    );
    const boundary = native.call("process_spawn", [
      boundaryFixture,
      `${quote(boundaryFixture)} breakaway`,
      workspace,
      environment,
    ]);
    const denied = await wait(boundary);
    native.call("process_close", [boundary.handle]);
    assert.equal(JSON.parse(denied.output).breakawayDenied, true);
    const tokenChild = native.call("process_spawn", [
      boundaryFixture,
      quote(boundaryFixture),
      workspace,
      environment,
    ]);
    const observed = await wait(tokenChild);
    native.call("process_close", [tokenChild.handle]);
    assert.equal(JSON.parse(observed.output).defaultOwnerIsUser, true);
    const after = JSON.parse(
      execFileSync(boundaryFixture, [], { encoding: "utf8" }),
    );
    assert.deepEqual(after, before);
    report.processes.breakawayDenied = true;
    report.processes.childOwnerNormalizedWithoutChangingCaller = true;
    report.callerToken = before;
    const environmentChild = native.call("process_spawn", [
      boundaryFixture,
      `${quote(boundaryFixture)} environment`,
      workspace,
      [
        "z_REA=z",
        "_REA=underscore",
        "A_REA=a",
        "REA_CASE=first",
        "rea_case=last",
        "REA_ß=sharp",
        "REA_SS=double",
      ],
    ]);
    const childEnvironment = await wait(environmentChild);
    native.call("process_close", [environmentChild.handle]);
    assert.deepEqual(JSON.parse(childEnvironment.output), {
      ordinallySorted: true,
      lastDuplicateSelected: true,
      unicodeNamesPreserved: true,
    });
    report.processes.windowsEnvironmentSemantics = true;
  }
  const ownerFixture = join(workspace, "owner.mjs");
  const ownerPidFile = join(workspace, "crash-child.pid");
  const moduleUrl = pathToFileURL(
    join(packageRoot, "dist/windows/WindowsNativeLoader.js"),
  ).href;
  await writeFile(
    ownerFixture,
    `import {writeFileSync} from 'node:fs';
import {requireWindowsNativeAuthority} from ${JSON.stringify(moduleUrl)};
const native=requireWindowsNativeAuthority();
const env=Object.entries(process.env).map(([k,v])=>k+'='+v);
const child=native.call('process_spawn',[process.execPath,${JSON.stringify([process.execPath, "--max-old-space-size=128", fixture, "0", join(workspace, "crash-descendant-")].map(quote).join(" "))},${JSON.stringify(workspace)},env]);
writeFileSync(${JSON.stringify(ownerPidFile)},String(child.pid));setInterval(()=>{},1000);\n`,
  );
  const owner = spawn(
    process.execPath,
    ["--max-old-space-size=128", ownerFixture],
    { stdio: "ignore" },
  );
  try {
    for (
      let attempt = 0;
      attempt < 200 && !(await exists(ownerPidFile));
      attempt++
    )
      await delay();
    const pid = Number(await readFile(ownerPidFile, "utf8"));
    const closed = new Promise((resolve) => owner.once("close", resolve));
    owner.kill("SIGKILL");
    await closed;
    for (let attempt = 0; attempt < 100 && live(pid); attempt++) await delay();
    assert.equal(live(pid), false);
    report.processes.ownerForcedExitKillsOwnedChild = true;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const closed = new Promise((resolve) => owner.once("close", resolve));
      owner.kill("SIGKILL");
      await closed;
    }
  }
  report.ok = true;
  if (process.argv[4] !== undefined)
    await writeFile(process.argv[4], `${JSON.stringify(report)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (cause) {
  console.error(
    "Native conformance failed",
    cause.code ?? cause.name,
    cause.constraint ?? "assertion",
  );
  throw cause;
} finally {
  await rm(workspace, { recursive: true, force: true }).catch((cause) =>
    console.error("Fixture cleanup failed", cause.code),
  );
}
