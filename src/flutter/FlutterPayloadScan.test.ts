import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BuildIdScanner,
  LabeledStringScanner,
  SnapshotHashScanner,
} from "./FlutterPayloadScan.js";

/** Real payload prefix from Flutter Gallery 2.9.2's arm64 libapp.so. */
const realSnapshotSection = (hash: string): Uint8Array =>
  Uint8Array.from([
    0xf5,
    0xf5,
    0xdc,
    0xdc,
    0x49,
    0x0d,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...Array.from(hash, (character) => character.charCodeAt(0)),
  ]);

describe("SnapshotHashScanner", () => {
  it("reads the hash from real vm and isolate sections that agree", () => {
    const scanner = new SnapshotHashScanner();
    scanner.push(realSnapshotSection("65817c30a78bb44c3dc3771876b6010a"));
    scanner.push(Uint8Array.from([0, 0, 0]));
    scanner.push(realSnapshotSection("65817c30a78bb44c3dc3771876b6010a"));
    expect(scanner.result()).toEqual({
      sources: 2,
      candidates: ["65817c30a78bb44c3dc3771876b6010a"],
    });
  });

  it("keeps both hashes when sections disagree", () => {
    const scanner = new SnapshotHashScanner();
    scanner.push(realSnapshotSection("11111111111111111111111111111111"));
    scanner.push(realSnapshotSection("22222222222222222222222222222222"));
    expect(scanner.result()).toEqual({
      sources: 2,
      candidates: [
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
      ],
    });
  });

  it("survives chunk boundaries that split the magic and hash", () => {
    const scanner = new SnapshotHashScanner();
    const payload = realSnapshotSection("65817c30a78bb44c3dc3771876b6010a");
    for (let offset = 0; offset < payload.length; offset += 7)
      scanner.push(payload.subarray(offset, offset + 7));
    expect(scanner.result()).toEqual({
      sources: 1,
      candidates: ["65817c30a78bb44c3dc3771876b6010a"],
    });
  });

  it("ignores a magic without a following hash", () => {
    const scanner = new SnapshotHashScanner();
    scanner.push(Uint8Array.from([0xf5, 0xf5, 0xdc, 0xdc, 0xff, 0xff, 0xff]));
    expect(scanner.result()).toEqual({ sources: 0, candidates: [] });
  });
});

describe("BuildIdScanner", () => {
  it("reads a real GNU build-id note", () => {
    const scanner = new BuildIdScanner();
    const note = Uint8Array.from([
      0x04,
      0x00,
      0x00,
      0x00,
      0x14,
      0x00,
      0x00,
      0x00,
      0x03,
      0x00,
      0x00,
      0x00,
      0x47,
      0x4e,
      0x55,
      0x00,
      ...Array.from({ length: 20 }, (_, index) => index),
    ]);
    scanner.push(Uint8Array.from([1, 2, 3]));
    scanner.push(note);
    expect(scanner.result()).toBe(
      Array.from({ length: 20 }, (_, index) => index)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    );
  });

  it("reports null when no note exists", () => {
    const scanner = new BuildIdScanner();
    scanner.push(Uint8Array.from([0, 0, 0, 0]));
    expect(scanner.result()).toBeNull();
  });
});

describe("LabeledStringScanner", () => {
  it.skipIf(
    !exists(
      "/tmp/opencode/flutter-target/extracted/lib/arm64-v8a/libflutter.so",
    ),
  )("collects the real clang toolchain line from libflutter.so", () => {
    const real = readFileSync(
      "/tmp/opencode/flutter-target/extracted/lib/arm64-v8a/libflutter.so",
    ).subarray(0, 4 * 1024 * 1024);
    const scanner = new LabeledStringScanner();
    for (let offset = 0; offset < real.length; offset += 1024 * 512)
      scanner.push(real.subarray(offset, offset + 1024 * 512));
    expect(scanner.result().dartVersion).toBeNull();
  });

  it("reads a labeled Dart VM version string when a build carries one", () => {
    const scanner = new LabeledStringScanner();
    scanner.push(
      Uint8Array.from(
        Array.from(
          "\x00Dart VM version: 3.1.0 (stable) somewhere\x00",
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    expect(scanner.result().dartVersion).toBe(
      "Dart VM version: 3.1.0 (stable) somewhere",
    );
  });

  it("collects the labeled Android clang line", () => {
    const line =
      "Android (5900059 based on r365631c) clang version 9.0.8 (https://android.googlesource.com/toolchain/llvm-project 207d7abc) (based on LLVM 9.0.8svn)";
    const scanner = new LabeledStringScanner();
    scanner.push(
      Uint8Array.from(
        Array.from(`\x00${line}\x00`, (character) => character.charCodeAt(0)),
      ),
    );
    expect(scanner.result().toolchainLines).toEqual([line]);
  });
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
