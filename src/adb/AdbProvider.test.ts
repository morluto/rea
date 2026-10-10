import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { AdbProvider } from "./AdbProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AdbRequest } from "../domain/adb/adbDeviceAnalysis.js";

const it = test.skipIf(process.platform === "win32");

const VERSION_BLOCK =
  "printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-stub\\nInstalled as %s\\n' \"$0\"";

const writeAdbStub = async (
  body: (root: string) => string,
): Promise<{ readonly binary: string; readonly root: string }> => {
  const root = await mkdtemp(join("/tmp", "rea-adb-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "adb");
  await writeFile(binary, `#!/bin/sh\n${body(root)}\n`, { mode: 0o755 });
  await chmod(binary, 0o755);
  return { binary, root };
};

const providerOver = (binary: string): AdbProvider =>
  new AdbProvider({ environment: { REA_ADB_PATH: binary } });

const evidenceResult = async (
  provider: AdbProvider,
  request: AdbRequest,
): Promise<Record<string, unknown>> => {
  const result = await provider.execute(request);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.result as Record<string, unknown>;
};

const refusedBy = async (
  provider: AdbProvider,
  request: AdbRequest,
): Promise<ReturnType<typeof projectAnalysisError>> => {
  const result = await provider.execute(request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  return projectAnalysisError(result.error);
};

it("inspects the adb client without contacting the server", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; fi`,
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "inspect_adb_client",
    input: {},
  });
  expect(result.client).toMatchObject({
    path_source: "environment",
    version: "34.0.5-stub",
    installed_path: binary,
  });
  expect(result.contacted_adb_server).toBe(false);
});

it("lists devices with inferred kinds and observed daemon startup", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "devices" ]; then
  printf '* daemon not running; starting now at tcp:5037\\n* daemon started successfully\\n'
  printf 'List of devices attached\\n'
  printf 'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\\n'
  exit 0
fi`,
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "list_adb_devices",
    input: {},
  });
  expect(result.may_have_started_adb_server).toBe(true);
  expect(result.devices).toEqual([
    {
      serial: "emulator-5554",
      state: "device",
      transport: "tcp",
      product: "sdk_gphone64_x86_64",
      model: "sdk_gphone64_x86_64",
      device: "emu64xa",
      transport_id: 1,
      kind: "emulator",
      kind_basis: "emulator_serial_prefix",
    },
  ]);
});

it("inspects a device through the getprop whitelist", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ] && [ "$4" = "getprop" ]; then
  printf '[ro.build.version.sdk]: [34]\\n[ro.kernel.qemu]: [1]\\n[sys.private]: [x]\\n'
  exit 0
fi`,
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "inspect_adb_device",
    input: { serial: "emulator-5554" },
  });
  expect(result.emulator_observed).toBe(true);
  expect(result.properties).toEqual([
    { name: "ro.build.version.sdk", value: "34" },
    { name: "ro.kernel.qemu", value: "1" },
  ]);
});

it("passes the caller scope as an exact fixed argv vector", async () => {
  const { binary, root } = await writeAdbStub(
    (root) => `printf '%s\\n' "$@" >> ${join(root, "argv.log")}
if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ]; then printf 'package:/data/app/x/base.apk=com.example\\n'; exit 0; fi`,
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "list_adb_packages",
    input: { serial: "emulator-5554", scope: "third_party" },
  });
  expect(result.coverage).toBe("complete");
  expect(result.packages).toEqual([
    {
      package_name: "com.example",
      base_apk_device_path: "/data/app/x/base.apk",
    },
  ]);
  const logged = (await readFile(join(root, "argv.log"), "utf8"))
    .trim()
    .split("\n");
  expect(logged).toEqual([
    "version",
    "-s",
    "emulator-5554",
    "shell",
    "pm",
    "list",
    "packages",
    "-f",
    "-3",
  ]);
});

const pullStub = (
  paths: string,
  pullBody: string,
): string => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "pm" ] && [ "$5" = "path" ]; then
  printf '%s\\n' ${paths}
  exit 0
fi
if [ "$1" = "-s" ] && [ "$3" = "pull" ]; then
${pullBody}
  exit 0
fi
printf 'unexpected arguments: %s\\n' "$@"
exit 1`;

/** Stub dispatching one canned stdout per first shell word (and optional second). */
const shellStub = (
  dispatch: Readonly<Record<string, string>>,
): ((root: string) => string) => {
  const cases = Object.entries(dispatch)
    .map(([key, output]) => {
      const [first, second] = key.split(":");
      const guard =
        second === undefined
          ? `[ "$4" = "${first}" ]`
          : `[ "$4" = "${first}" ] && [ "$5" = "${second}" ]`;
      return `  if ${guard}; then printf '%b' '${output.replace(/'/gu, "'\\''")}'; exit 0; fi`;
    })
    .join("\n");
  return () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "shell" ]; then
${cases}
  printf 'unexpected shell command: %s %s %s\\n' "$4" "$5" "$6" >&2
  exit 1
fi
printf 'unexpected arguments: %s\\n' "$@"
exit 1`;
};

it("pulls a complete split set with digests into a new package directory", async () => {
  const { binary, root } = await writeAdbStub(() =>
    pullStub(
      "'package:/data/app/~~a==/com.example.b==/base.apk' 'package:/data/app/~~a==/com.example.b==/split_config.en.apk'",
      `  printf 'apk-bytes-for-testing' > "$5"
  printf '1 file pulled, 0 skipped.\\n'`,
    ),
  );
  const output = join(root, "pulls");
  const result = await evidenceResult(providerOver(binary), {
    operation: "pull_adb_package",
    input: {
      serial: "emulator-5554",
      package: "com.example",
      output_directory: output,
    },
  });
  expect(result.coverage).toBe("complete");
  expect(result.failures).toEqual([]);
  const artifacts = result.artifacts as {
    file_name: string;
    local_path: string;
    sha256: string;
    role: string;
  }[];
  expect(
    artifacts.map((artifact) => [artifact.file_name, artifact.role]),
  ).toEqual([
    ["base.apk", "base"],
    ["split_config.en.apk", "split"],
  ]);
  const digest = createHash("sha256")
    .update("apk-bytes-for-testing")
    .digest("hex");
  for (const artifact of artifacts) expect(artifact.sha256).toBe(digest);
  const pulled = await readFile(
    join(output, "com.example", "base.apk"),
    "utf8",
  );
  expect(pulled).toBe("apk-bytes-for-testing");
});

it("keeps successful artifacts when one split pull fails", async () => {
  const { binary, root } = await writeAdbStub(() =>
    pullStub(
      "'package:/data/app/y/base.apk' 'package:/data/app/y/split_dpi.apk'",
      `case "$4" in
    */split_dpi.apk) printf 'error: closed\\n' >&2; exit 1;;
    *) printf 'apk-bytes-for-testing' > "$5"; printf '1 file pulled.\\n';;
  esac`,
    ),
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "pull_adb_package",
    input: {
      serial: "emulator-5554",
      package: "com.partial",
      output_directory: join(root, "pulls"),
    },
  });
  expect(result.coverage).toBe("partial");
  expect(result.artifacts).toHaveLength(1);
  expect(result.failures).toEqual([
    {
      device_path: "/data/app/y/split_dpi.apk",
      stage: "pull",
      message: expect.stringContaining("closed") as unknown,
    },
  ]);
});

it("refuses to reuse an existing package output directory", async () => {
  const { binary, root } = await writeAdbStub(() =>
    pullStub("'package:/data/app/z/base.apk'", `  printf 'x' > "$5"`),
  );
  const output = join(root, "existing");
  await mkdir(join(output, "com.example"), { recursive: true });
  const provider = providerOver(binary);
  const result = await provider.execute({
    operation: "pull_adb_package",
    input: {
      serial: "emulator-5554",
      package: "com.example",
      output_directory: output,
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "unreadable_output",
  });
  expect(result.error.message).toContain("already exists");
});

it("reports an uninstalled package from empty pm path output", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "pm" ] && [ "$5" = "path" ]; then exit 0; fi`,
  );
  const projected = await refusedBy(providerOver(binary), {
    operation: "pull_adb_package",
    input: {
      serial: "emulator-5554",
      package: "com.absent",
      output_directory: "/tmp/rea-adb-absent",
    },
  });
  expect(projected).toMatchObject({ code: "unsupported_target" });
  expect(projected.message).toContain("no APK paths");
});

it.each([
  ["not found", "error: device 'emulator-9' not found", "not found"],
  ["offline", "error: device offline", "offline"],
  ["unauthorized", "error: device unauthorized", "unauthorized"],
] as const)(
  "reports the %s device state as a target refusal",
  async (_, stderr, excerpt) => {
    const { binary } = await writeAdbStub(
      () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ]; then printf '%s\\n' "${stderr.replace(/'/gu, "'\\''")}" >&2; exit 1; fi`,
    );
    const projected = await refusedBy(providerOver(binary), {
      operation: "inspect_adb_device",
      input: { serial: "emulator-5554" },
    });
    expect(projected).toMatchObject({ code: "unsupported_target" });
    expect(projected.message).toContain(excerpt);
  },
);

it("reports a missing selected binary as a capability gap with recovery", async () => {
  const provider = new AdbProvider({
    environment: { REA_ADB_PATH: "/nonexistent/adb" },
  });
  const availability = await provider.inspectAvailability();
  expect(availability).toMatchObject({ status: "unavailable" });
  if (availability.status !== "unavailable") return;
  expect(availability.diagnostics.remediation).toContain("REA_ADB_PATH");
  const result = await provider.execute({
    operation: "list_adb_devices",
    input: {},
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({ code: "capability_unavailable" });
  expect(projected.details).toMatchObject({
    provider_id: "adb",
    reason: expect.stringContaining("not found") as unknown,
  });
});

it("cancels before spawning anything", async () => {
  const { binary, root } = await writeAdbStub(
    (root) => `: > ${join(root, "spawned")}
if [ "$1" = "version" ]; then ${VERSION_BLOCK}; fi`,
  );
  const controller = new AbortController();
  controller.abort();
  const cancelled = await providerOver(binary).execute(
    { operation: "list_adb_devices", input: {} },
    { signal: controller.signal },
  );
  expect(cancelled.ok).toBe(false);
  if (cancelled.ok) return;
  expect(projectAnalysisError(cancelled.error)).toMatchObject({
    code: "cancelled",
  });
  expect(
    await readFile(join(root, "spawned")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

it("reads a bounded logcat dump with the caller count and buffer", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      logcat:
        "08-10 13:00:00.000 I/Tag( 123): first\\n08-10 13:00:01.000 I/Tag( 123): second\\n",
    }),
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "read_adb_logcat",
    input: { serial: "emulator-5554", count: 500, buffer: "main" },
  });
  expect(result.lines).toEqual([
    "08-10 13:00:00.000 I/Tag( 123): first",
    "08-10 13:00:01.000 I/Tag( 123): second",
  ]);
});

it("projects package details from dumpsys package output", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      "dumpsys:package": `Packages:
  Package [com.example] (abcdef):
    userId=10234
    versionName=1.2.3
    versionCode=45 minSdk=24 targetSdk=34
    firstInstallTime=2026-01-02 03:04:05
    lastUpdateTime=2026-02-03 04:05:06
    installerPackageName=com.android.vending
    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    requested permissions:
      android.permission.INTERNET
      android.permission.CAMERA
`,
    }),
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "inspect_adb_package",
    input: { serial: "emulator-5554", package: "com.example" },
  });
  expect(result).toMatchObject({
    version_name: "1.2.3",
    version_code: 45,
    first_install_time: "2026-01-02 03:04:05",
    last_update_time: "2026-02-03 04:05:06",
    installer_package_name: "com.android.vending",
    user_id: 10234,
    requested_permissions_count: 2,
    coverage: "complete",
  });
});

it("reports an uninstalled package from dumpsys refusal output", async () => {
  const { binary } = await writeAdbStub(
    shellStub({ "dumpsys:package": "Unable to find package: com.absent\n" }),
  );
  const projected = await refusedBy(providerOver(binary), {
    operation: "inspect_adb_package",
    input: { serial: "emulator-5554", package: "com.absent" },
  });
  expect(projected).toMatchObject({ code: "unsupported_target" });
});

it("pulls one device file with a digest", async () => {
  const { binary, root } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "pull" ]; then printf 'file-bytes' > "$5"; exit 0; fi
exit 1`,
  );
  const output = join(root, "pulls");
  const result = await evidenceResult(providerOver(binary), {
    operation: "pull_adb_file",
    input: {
      serial: "emulator-5554",
      device_path: "/data/local/tmp/notes.txt",
      output_directory: output,
    },
  });
  const digest = createHash("sha256").update("file-bytes").digest("hex");
  expect(result).toMatchObject({
    device_path: "/data/local/tmp/notes.txt",
    local_path: join(output, "notes.txt"),
    bytes: 10,
    sha256: digest,
  });
});

it("pushes a file and verifies the device-side digest", async () => {
  const { binary, root } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "test" ]; then exit 1; fi
if [ "$1" = "-s" ] && [ "$3" = "push" ]; then exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "sha256sum" ]; then printf '%s  %s\\n' "8748b5d17d1ebcec7d46674fa6a8b92c0f95598a552f27c1c8a132eb58c04043" "$5"; exit 0; fi
exit 1`,
  );
  const localFile = join(root, "payload.bin");
  await writeFile(localFile, "push-payload");
  const digest = createHash("sha256").update("push-payload").digest("hex");
  const pushed = await evidenceResult(providerOver(binary), {
    operation: "push_adb_file",
    input: {
      serial: "emulator-5554",
      local_path: localFile,
      device_path: "/data/local/tmp/payload.bin",
      overwrite: false,
    },
  });
  expect(pushed).toMatchObject({
    bytes: 12,
    sha256: digest,
    device_sha256: digest,
    overwritten: false,
    device_digest_source: "device_sha256sum",
  });
});

it("reports a digest mismatch after push as a changed artifact", async () => {
  const { binary, root } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "test" ]; then exit 1; fi
if [ "$1" = "-s" ] && [ "$3" = "push" ]; then exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "sha256sum" ]; then printf '%s  %s\\n' "$(printf 'a%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64)" "$5"; exit 0; fi
exit 1`,
  );
  const localFile = join(root, "payload.bin");
  await writeFile(localFile, "push-payload");
  const projected = await refusedBy(providerOver(binary), {
    operation: "push_adb_file",
    input: {
      serial: "emulator-5554",
      local_path: localFile,
      device_path: "/data/local/tmp/payload.bin",
      overwrite: false,
    },
  });
  expect(projected).toMatchObject({ code: "artifact_changed" });
});

it("refuses a push onto an existing device path without overwrite", async () => {
  const { binary, root } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$4" = "test" ]; then exit 0; fi
exit 1`,
  );
  const localFile = join(root, "payload.bin");
  await writeFile(localFile, "x");
  const result = await providerOver(binary).execute({
    operation: "push_adb_file",
    input: {
      serial: "emulator-5554",
      local_path: localFile,
      device_path: "/data/local/tmp/exists.bin",
      overwrite: false,
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "unreadable_output",
  });
  expect(result.error.message).toContain("overwrite");
});

it("reports a local push source that does not exist", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
exit 1`,
  );
  const projected = await refusedBy(providerOver(binary), {
    operation: "push_adb_file",
    input: {
      serial: "emulator-5554",
      local_path: "/nonexistent/payload.bin",
      device_path: "/data/local/tmp/payload.bin",
      overwrite: false,
    },
  });
  expect(projected).toMatchObject({ code: "invalid_request" });
});

it("captures the screen as a digested PNG with its dimensions", async () => {
  const { binary, root } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "exec-out" ]; then
  printf '\\211PNG\\r\\n\\032\\n\\0\\0\\0\\rIHDR\\0\\0\\0\\004\\0\\0\\0\\003'
  exit 0
fi
exit 1`,
  );
  const output = join(root, "captures");
  const result = await evidenceResult(providerOver(binary), {
    operation: "capture_adb_screen",
    input: { serial: "emulator-5554", output_directory: output },
  });
  expect(result).toMatchObject({ width: 4, height: 3 });
  expect(
    await readFile(join(output, "screen.png")).then(
      (bytes) => bytes.subarray(1, 4).toString("latin1") === "PNG",
      () => false,
    ),
  ).toBe(true);
});

it("lists processes, features, and services through fixed commands", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      ps: "USER PID PPID VSZ RSS WCHAN ADDR S NAME\nu0_a1 1234 567 123456 7890 0 0 S com.example.app\n",
      "pm:list":
        "feature:android.hardware.camera\nfeature:android.hardware.nfc=1\n",
      "service:list":
        "Found 2 services:\n  1 package: [android.content.pm.IPackageManager]\n  2 activity: [android.app.IActivityManager]\n",
    }),
  );
  const processes = await evidenceResult(providerOver(binary), {
    operation: "list_adb_processes",
    input: { serial: "emulator-5554" },
  });
  expect(processes.processes).toEqual([
    {
      user: "u0_a1",
      pid: 1234,
      ppid: 567,
      rss: 7890,
      state: "S",
      name: "com.example.app",
    },
  ]);
  const features = await evidenceResult(providerOver(binary), {
    operation: "list_adb_features",
    input: { serial: "emulator-5554" },
  });
  expect(features.features).toEqual([
    { name: "android.hardware.camera", version: null },
    { name: "android.hardware.nfc", version: 1 },
  ]);
  const services = await evidenceResult(providerOver(binary), {
    operation: "list_adb_services",
    input: { serial: "emulator-5554" },
  });
  expect(services.services).toEqual([
    { name: "package", interface: "android.content.pm.IPackageManager" },
    { name: "activity", interface: "android.app.IActivityManager" },
  ]);
});

it("lists a device directory with kinds and symlink targets", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      ls: "total 4\n-rw-rw---- u0_a1 u0_a1 4096 2026-01-02 11:00 app.db\nlrwxrwxrwx root root 2026-01-01 10:00 lib -> /apex/com.android.art/lib\n",
    }),
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "list_adb_directory",
    input: {
      serial: "emulator-5554",
      device_path: "/data/data/com.example.app",
    },
  });
  expect(result.entries).toEqual([
    {
      name: "app.db",
      kind: "file",
      permissions: "-rw-rw----",
      owner: "u0_a1",
      group: "u0_a1",
      bytes: 4096,
      date: "2026-01-02 11:00",
      link_target: null,
    },
    {
      name: "lib",
      kind: "symlink",
      permissions: "lrwxrwxrwx",
      owner: "root",
      group: "root",
      bytes: null,
      date: "2026-01-01 10:00",
      link_target: "/apex/com.android.art/lib",
    },
  ]);
});

it("inspects the display and window focus", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      "wm:size": "Physical size: 1080x2340\n",
      "wm:density": "Physical density: 420\n",
      "dumpsys:window":
        "  mCurrentFocus=Window{abcdef u0 com.example.app/com.example.app.MainActivity}\n",
    }),
  );
  const display = await evidenceResult(providerOver(binary), {
    operation: "inspect_adb_display",
    input: { serial: "emulator-5554" },
  });
  expect(display.physical_size).toEqual({ width: 1080, height: 2340 });
  expect(display.physical_density).toBe(420);
  const window = await evidenceResult(providerOver(binary), {
    operation: "inspect_adb_window",
    input: { serial: "emulator-5554" },
  });
  expect(window.focused_window).toBe(
    "Window{abcdef u0 com.example.app/com.example.app.MainActivity}",
  );
});

it("reads one settings value and reports device-side nulls", async () => {
  const { binary } = await writeAdbStub(shellStub({ "settings:get": "1\n" }));
  const enabled = await evidenceResult(providerOver(binary), {
    operation: "read_adb_setting",
    input: {
      serial: "emulator-5554",
      namespace: "secure",
      key: "adb_enabled",
    },
  });
  expect(enabled.value).toBe("1");
  const { binary: nullBinary } = await writeAdbStub(
    shellStub({ "settings:get": "null\n" }),
  );
  const absent = await evidenceResult(providerOver(nullBinary), {
    operation: "read_adb_setting",
    input: {
      serial: "emulator-5554",
      namespace: "global",
      key: "absent_key",
    },
  });
  expect(absent.value).toBeNull();
  expect(absent.device_reported_null).toBe(true);
});

it("resolves packages by case-insensitive substring", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      "pm:list":
        "package:/data/app/x/base.apk=com.whatsapp\\npackage:/data/app/y/base.apk=com.whatsapp.w4b\\npackage:/data/app/z/base.apk=com.example\\n",
    }),
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "resolve_adb_packages",
    input: { serial: "emulator-5554", query: "WhatsApp" },
  });
  expect(result.matches).toEqual([
    {
      package_name: "com.whatsapp",
      base_apk_device_path: "/data/app/x/base.apk",
    },
    {
      package_name: "com.whatsapp.w4b",
      base_apk_device_path: "/data/app/y/base.apk",
    },
  ]);
  expect(result.exact_match).toBe(false);
  expect(result.coverage).toBe("complete");
});

it("installs a local APK and preserves the device's failure verdict", async () => {
  const { binary, root } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "install" ]; then printf 'Success\\n'; exit 0; fi
exit 1`,
  );
  const apk = join(root, "app.apk");
  await writeFile(apk, "apk");
  const digest = createHash("sha256").update("apk").digest("hex");
  const installed = await evidenceResult(providerOver(binary), {
    operation: "install_adb_package",
    input: { serial: "emulator-5554", apk_path: apk, replace: false },
  });
  expect(installed).toMatchObject({
    bytes: 3,
    sha256: digest,
    replaced: false,
  });

  const { binary: failing } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "install" ]; then printf 'Failure [INSTALL_FAILED_ALREADY_EXISTS]\\n'; exit 0; fi
exit 1`,
  );
  const projected = await refusedBy(providerOver(failing), {
    operation: "install_adb_package",
    input: {
      serial: "emulator-5554",
      apk_path: apk,
      replace: false,
    },
  });
  expect(projected).toMatchObject({ code: "unsupported_target" });
  expect(projected.message).toContain("INSTALL_FAILED_ALREADY_EXISTS");
});

it("uninstalls a package and reports the device's refusal for absent ones", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "uninstall" ]; then printf 'Success\\n'; exit 0; fi
exit 1`,
  );
  const removed = await evidenceResult(providerOver(binary), {
    operation: "uninstall_adb_package",
    input: { serial: "emulator-5554", package: "com.example" },
  });
  expect(removed.package_name).toBe("com.example");

  const { binary: refusing } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "uninstall" ]; then printf 'Failure [not installed for 0]\\n'; exit 0; fi
exit 1`,
  );
  const projected = await refusedBy(providerOver(refusing), {
    operation: "uninstall_adb_package",
    input: { serial: "emulator-5554", package: "com.absent" },
  });
  expect(projected).toMatchObject({ code: "unsupported_target" });
  expect(projected.message).toContain("not installed for 0");
});

it("starts an app through resolved launcher component and force-stops it", async () => {
  const { binary } = await writeAdbStub(
    shellStub({
      "cmd:package":
        "priority=0 preferredOrder=0 match=0x00108000 specificIndex=-1 isDefault=true\ncom.example/.Main",
      "am:start":
        "Starting: Intent { act=android.intent.action.MAIN cat=[android.intent.category.LAUNCHER] cmp=com.example/.Main }\n",
      "am:force-stop": "",
    }),
  );
  const provider = providerOver(binary);
  const started = await evidenceResult(provider, {
    operation: "start_adb_app",
    input: { serial: "emulator-5554", package: "com.example" },
  });
  expect(started).toMatchObject({
    package_name: "com.example",
    component: "com.example/.Main",
    started_activity: expect.stringContaining(
      "cmp=com.example/.Main",
    ) as unknown,
  });
  const stopped = await evidenceResult(provider, {
    operation: "stop_adb_app",
    input: { serial: "emulator-5554", package: "com.example" },
  });
  expect(stopped.package_name).toBe("com.example");
});

it("reports an app without a launcher activity as unsupported", async () => {
  const { binary } = await writeAdbStub(
    shellStub({ "cmd:package": "No activity found\n" }),
  );
  const projected = await refusedBy(providerOver(binary), {
    operation: "start_adb_app",
    input: { serial: "emulator-5554", package: "com.library.only" },
  });
  expect(projected).toMatchObject({ code: "unsupported_target" });
  expect(projected.message).toContain("No launcher activity");
});

it("starts an intent with typed extras as a fixed argv vector", async () => {
  const { binary, root } = await writeAdbStub(
    (root) => `printf '%s\\n' "$@" >> ${join(root, "argv.log")}
${shellStub({ "am:start": "Starting: Intent { act=android.intent.action.VIEW dat=https://example.com/ }\n" })(root)}`,
  );
  const started = await evidenceResult(providerOver(binary), {
    operation: "start_adb_activity",
    input: {
      serial: "emulator-5554",
      action: "android.intent.action.VIEW",
      data_uri: "https://example.com/",
      extras: [
        { key: "level", type: "int", value: "3" },
        { key: "label", type: "string", value: "probe" },
      ],
    },
  });
  expect(started.action).toBe("android.intent.action.VIEW");
  const logged = (await readFile(join(root, "argv.log"), "utf8"))
    .trim()
    .split("\n");
  expect(logged).toEqual([
    "version",
    "-s",
    "emulator-5554",
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "https://example.com/",
    "--ei",
    "level",
    "3",
    "--es",
    "label",
    "probe",
  ]);
});

it("rejects mistyped intent extras before touching the device", async () => {
  const { binary } = await writeAdbStub(
    () => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
: > should-not-exist`,
  );
  const projected = await refusedBy(providerOver(binary), {
    operation: "start_adb_activity",
    input: {
      serial: "emulator-5554",
      action: "com.example.ACTION",
      extras: [{ key: "flag", type: "boolean", value: "yes" }],
    },
  });
  expect(projected).toMatchObject({ code: "invalid_request" });
});

it("collects a device bugreport archive with its digest", async () => {
  const { binary, root } = await writeAdbStub(
    (root) => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "-s" ] && [ "$3" = "bugreport" ]; then
  printf 'bugreport-bytes' > "${join(root, "bugreport test.zip")}"
  printf 'Bug report copied to ${join(root, "bugreport test.zip")}\\n'
  exit 0
fi
exit 1`,
  );
  const result = await evidenceResult(providerOver(binary), {
    operation: "collect_adb_bugreport",
    input: { serial: "emulator-5554", output_directory: root },
  });
  const digest = createHash("sha256").update("bugreport-bytes").digest("hex");
  expect(result).toMatchObject({
    local_path: join(root, "bugreport test.zip"),
    bytes: 15,
    sha256: digest,
    adb_reported_path: join(root, "bugreport test.zip"),
  });
});

it("quotes caller text before adb joins the remote shell command", async () => {
  const { binary, root } = await writeAdbStub(
    (root) => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
shift 3
# Model adb's remote command joining, then execute the resulting shell string.
printf '#!/bin/sh\nprintf "%%s" "$@" > "${join(root, "observed")}"\n' > "${join(root, "ls")}"
chmod +x "${join(root, "ls")}"
PATH="${root}:$PATH" sh -c "$*"
`,
  );
  const value = `/sdcard/a 'quoted'; touch ${join(root, "injected")}`;
  await providerOver(binary).execute({
    operation: "list_adb_directory",
    input: { serial: "device", device_path: value },
  });
  expect(await readFile(join(root, "observed"), "utf8")).toContain(value);
  await expect(readFile(join(root, "injected"))).rejects.toThrow();
});

it("preserves a screen output created while capture is running", async () => {
  const { binary, root } = await writeAdbStub(
    (root) => `if [ "$1" = "version" ]; then ${VERSION_BLOCK}; exit 0; fi
printf 'existing evidence' > "${join(root, "captures", "screen.png")}"
printf '\\211PNG\\r\\n\\032\\n\\0\\0\\0\\rIHDR\\0\\0\\0\\004\\0\\0\\0\\003'
`,
  );
  const result = await providerOver(binary).execute({
    operation: "capture_adb_screen",
    input: { serial: "device", output_directory: join(root, "captures") },
  });
  expect(result.ok).toBe(false);
  expect(await readFile(join(root, "captures", "screen.png"), "utf8")).toBe(
    "existing evidence",
  );
});

it("reports cancellation arriving during the version probe", async () => {
  const { binary } = await writeAdbStub(() => "exec sleep 30");
  const controller = new AbortController();
  const pending = providerOver(binary).execute(
    { operation: "inspect_adb_client", input: {} },
    { signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
  } finally {
    clearTimeout(timer);
  }
});
