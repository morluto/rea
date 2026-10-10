import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "vitest";

import { FlutterBuildProvider } from "./FlutterBuildProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

const it = test.skipIf(process.platform === "win32");
const run = promisify(execFile);

const snapshotSection = (hash: string): Buffer =>
  Buffer.concat([
    Buffer.from([
      0xf5, 0xf5, 0xdc, 0xdc, 0x49, 0x0d, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0,
      0,
    ]),
    Buffer.from(hash, "latin1"),
  ]);

const buildIdNote = (): Buffer =>
  Buffer.concat([
    Buffer.from([4, 0, 0, 0, 20, 0, 0, 0, 3, 0, 0, 0, 0x47, 0x4e, 0x55, 0]),
    Buffer.from([
      0xe8, 0xd9, 0x07, 0xef, 0x7c, 0x17, 0x5e, 0xc4, 0x31, 0x3f, 0x47, 0x11,
      0x10, 0x19, 0xad, 0xc9, 0x58, 0x8c, 0x5f, 0x61,
    ]),
  ]);

const TOOLCHAIN_LINE =
  "Android (5900059 based on r365631c) clang version 9.0.8 (based on LLVM 9.0.8svn)";

const libapp = (hash: string): Buffer =>
  Buffer.concat([
    Buffer.from("ELF-payload-prefix\x00"),
    snapshotSection(hash),
    Buffer.from("middle\x00"),
    snapshotSection(hash),
  ]);

const libflutter = (): Buffer =>
  Buffer.concat([
    Buffer.from("ELF-payload-prefix\x00"),
    buildIdNote(),
    Buffer.from(`\x00${TOOLCHAIN_LINE}\x00`),
  ]);

/** Build a real APK-shaped zip with the `zip` CLI. */
const buildApk = async (
  name: string,
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Buffer }>,
): Promise<string> => {
  const root = await mkdtemp(join("/tmp", "rea-flutter-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  await run(
    "zip",
    ["-q", "-X", join(root, name), ...files.map((file) => file.path)],
    { cwd: root },
  );
  return join(root, name);
};

it("identifies a Flutter build across ABIs with agreeing snapshot hashes", async () => {
  const apk = await buildApk("flutter.apk", [
    {
      path: "lib/arm64-v8a/libapp.so",
      bytes: libapp("65817c30a78bb44c3dc3771876b6010a"),
    },
    { path: "lib/arm64-v8a/libflutter.so", bytes: libflutter() },
    {
      path: "lib/x86_64/libapp.so",
      bytes: libapp("65817c30a78bb44c3dc3771876b6010a"),
    },
    { path: "lib/x86_64/libflutter.so", bytes: libflutter() },
  ]);
  const provider = new FlutterBuildProvider({ environment: {} });
  const result = await provider.execute({
    operation: "identify_flutter_build",
    input: { path: apk },
  });
  if (!result.ok) throw new Error(result.error.message);
  const value = result.value.result as {
    flutter_detected: boolean;
    coverage: string;
    abis: {
      abi: string;
      libapp: { snapshot_hash: string | null; snapshot_hash_sources: number };
      libflutter: {
        build_id: string | null;
        dart_version: string | null;
        toolchain_lines: string[];
      };
    }[];
  };
  expect(value.flutter_detected).toBe(true);
  expect(value.coverage).toBe("complete");
  expect(value.abis).toHaveLength(2);
  for (const abi of value.abis) {
    expect(abi.libapp.snapshot_hash).toBe("65817c30a78bb44c3dc3771876b6010a");
    expect(abi.libapp.snapshot_hash_sources).toBe(2);
    expect(abi.libflutter.build_id).toBe(
      "e8d907ef7c175ec4313f47111019adc9588c5f61",
    );
    expect(abi.libflutter.toolchain_lines).toEqual([TOOLCHAIN_LINE]);
  }
});

it("reports a missing engine library as partial coverage", async () => {
  const apk = await buildApk("half.apk", [
    {
      path: "lib/arm64-v8a/libapp.so",
      bytes: libapp("65817c30a78bb44c3dc3771876b6010a"),
    },
  ]);
  const result = await new FlutterBuildProvider({ environment: {} }).execute({
    operation: "identify_flutter_build",
    input: { path: apk },
  });
  if (!result.ok) throw new Error(result.error.message);
  const value = result.value.result as {
    flutter_detected: boolean;
    coverage: string;
    abis: { libapp: { present: boolean }; libflutter: { present: boolean } }[];
  };
  expect(value.flutter_detected).toBe(true);
  expect(value.coverage).toBe("partial");
  expect(value.abis[0]?.libapp.present).toBe(true);
  expect(value.abis[0]?.libflutter.present).toBe(false);
});

it("keeps disagreeing snapshot hashes as candidates with partial coverage", async () => {
  const apk = await buildApk("disagree.apk", [
    {
      path: "lib/arm64-v8a/libapp.so",
      bytes: Buffer.concat([
        snapshotSection("11111111111111111111111111111111"),
        snapshotSection("22222222222222222222222222222222"),
      ]),
    },
    { path: "lib/arm64-v8a/libflutter.so", bytes: libflutter() },
  ]);
  const result = await new FlutterBuildProvider({ environment: {} }).execute({
    operation: "identify_flutter_build",
    input: { path: apk },
  });
  if (!result.ok) throw new Error(result.error.message);
  const value = result.value.result as {
    abis: {
      libapp: {
        snapshot_hash: string | null;
        snapshot_hash_candidates: string[];
      };
    }[];
    coverage: string;
  };
  expect(value.coverage).toBe("partial");
  expect(value.abis[0]?.libapp.snapshot_hash).toBeNull();
  expect(value.abis[0]?.libapp.snapshot_hash_candidates).toEqual([
    "11111111111111111111111111111111",
    "22222222222222222222222222222222",
  ]);
});

it("reports a non-Flutter APK as not detected with complete coverage", async () => {
  const apk = await buildApk("plain.apk", [
    { path: "classes.dex", bytes: Buffer.from("dex\n0123456789") },
    { path: "lib/arm64-v8a/libnative.so", bytes: Buffer.from("plain-elf") },
  ]);
  const result = await new FlutterBuildProvider({ environment: {} }).execute({
    operation: "identify_flutter_build",
    input: { path: apk },
  });
  if (!result.ok) throw new Error(result.error.message);
  const value = result.value.result as {
    flutter_detected: boolean;
    abis: unknown[];
    coverage: string;
  };
  expect(value.flutter_detected).toBe(false);
  expect(value.abis).toEqual([]);
  expect(value.coverage).toBe("complete");
});

it("rejects a target that is not a readable file", async () => {
  const projected = await (async () => {
    const result = await new FlutterBuildProvider({
      environment: {},
    }).execute({
      operation: "identify_flutter_build",
      input: { path: "/nonexistent/app.apk" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    return projectAnalysisError(result.error);
  })();
  expect(projected).toMatchObject({ code: "invalid_request" });
});
