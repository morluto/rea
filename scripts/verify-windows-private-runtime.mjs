import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { requireOrdinaryWindowsVerifierCaller } from "./lib/windows-ordinary-user-verifier.mjs";
import {
  privateArtifacts,
  verifyRuntimeAccess,
} from "./lib/windows-private-runtime-access.mts";

if (process.platform !== "win32" || process.argv.length !== 4)
  throw new Error(
    "Usage on Windows: npm run verify:windows-private-runtime -- <shared qualification directory> <process-boundary.exe>",
  );
await requireOrdinaryWindowsVerifierCaller();
const { WindowsPrivateRuntime } =
  await import("../dist/windows/WindowsPrivateRuntime.js");
const byte = "R";
const probe = resolve(process.argv[3]);
const commands = await createVerifierCommands();
const interruption = bindVerifierCommandInterruption(commands);

async function verifyPeers(root) {
  const script = fileURLToPath(
    new URL("./verify/windows/private-runtime-read.ps1", import.meta.url),
  );
  const { stdout } = await interruption.exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-Root",
      root,
      "-Probe",
      probe,
    ],
    { timeout: 60_000, stdin: "closed-pipe" },
  );
  const owner = JSON.parse(stdout);
  assert.equal(verifyRuntimeAccess(root, owner.sid, owner), "owner");
  const pending = new Set(["SYSTEM", "unrelated user"]);
  const input = createInterface({
    input: process.stdin,
    signal: interruption.signal,
  });
  try {
    console.error(
      `Runtime: ${root}\nRun the read probe in each designated session and paste its JSON line here (SYSTEM and unrelated local user).`,
    );
    for await (const line of input) {
      const role = verifyRuntimeAccess(root, owner.sid, JSON.parse(line));
      assert.ok(
        pending.delete(role),
        `Unexpected or repeated ${role} observation`,
      );
      if (pending.size === 0) return;
    }
    interruption.throwIfInterrupted();
    throw new Error(`Missing read observations: ${[...pending].join(", ")}`);
  } finally {
    input.close();
  }
}

async function qualify(fixture) {
  let runtime;
  const close = fixture.releaseAfter(async () => {
    await commands.close();
    await runtime?.close();
  });
  const parent = join(fixture.path, "parent");
  const moved = join(fixture.path, "renamed");
  const outside = join(fixture.path, "outside");
  await mkdir(parent);
  await rename(parent, moved);
  await rename(moved, parent);
  await mkdir(outside);
  const sentinel = join(outside, "sentinel");
  await writeFile(sentinel, byte);
  const control = join(parent, "control.bin");
  await writeFile(control, byte);
  await interruption.exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      String.raw`
    $ErrorActionPreference = 'Stop'
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetSecurityDescriptorSddlForm("D:P(A;;FA;;;$owner)(A;;FA;;;SY)(A;;0x1;;;AU)", [Security.AccessControl.AccessControlSections]::Access)
    [IO.File]::SetAccessControl($env:REA_TEST_CONTROL_FILE, $security)
  `,
    ],
    {
      env: { ...process.env, REA_TEST_CONTROL_FILE: control },
      timeout: 60_000,
      stdin: "closed-pipe",
    },
  );
  try {
    runtime = WindowsPrivateRuntime.create(parent, "private-");
  } catch (cause) {
    fixture.retain(
      "Runtime creation failed without returning a cleanup handle.",
    );
    throw cause;
  }
  const root = runtime.observation.path;
  await mkdir(join(root, "project"));
  for (const file of privateArtifacts) {
    if (file === "snapshot.bin") await runtime.snapshot(control, file);
    else if (file === "session.log" || file === "project/data.bin")
      await writeFile(join(root, file), byte, { flag: "wx" });
    else runtime.writeFile(file.replaceAll("/", "\\"), byte);
  }
  await symlink(outside, join(root, "outside-junction"), "junction");
  await assert.rejects(rename(parent, moved), (error) =>
    ["EPERM", "EBUSY", "EACCES"].includes(error.code),
  );
  await verifyPeers(root);
  await close();
  await runtime.close();
  await assert.rejects(lstat(root), { code: "ENOENT" });
  assert.deepEqual(await readdir(parent), ["control.bin"]);
  assert.equal(await readFile(sentinel, "utf8"), byte);
}
try {
  const fixture = await VerifierFixture.open({
    parent: resolve(process.argv[2]),
    prefix: "rea-private-access-",
    private: false,
  });
  await withVerifierFixture(fixture, qualify);
  interruption.throwIfInterrupted();
} finally {
  interruption.finish();
}
console.log(
  "Owner and SYSTEM read all five artifacts; the unrelated user was denied. Parent replacement was refused and cleanup preserved the junction target.",
);
