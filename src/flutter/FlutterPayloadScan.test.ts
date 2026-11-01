import { describe, expect, it } from "vitest";

import {
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
      capped: false,
      sources: 2,
      candidates: ["65817c30a78bb44c3dc3771876b6010a"],
    });
  });

  it("keeps both hashes when sections disagree", () => {
    const scanner = new SnapshotHashScanner();
    scanner.push(realSnapshotSection("11111111111111111111111111111111"));
    scanner.push(realSnapshotSection("22222222222222222222222222222222"));
    expect(scanner.result()).toEqual({
      capped: false,
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
      capped: false,
      sources: 1,
      candidates: ["65817c30a78bb44c3dc3771876b6010a"],
    });
  });

  it.each([49, 50, 51])(
    "finds a section %i bytes after a rejected record at any chunking",
    (start) => {
      // A stray magic whose hash field is not hex, then a real section that
      // starts inside the stray record's magic-to-hash span.
      const payload = new Uint8Array(start + 52);
      payload.set([0xf5, 0xf5, 0xdc, 0xdc], 0);
      payload.set(
        realSnapshotSection("65817c30a78bb44c3dc3771876b6010a"),
        start,
      );
      const whole = new SnapshotHashScanner();
      whole.push(payload);
      expect(whole.result()).toEqual({
        capped: false,
        sources: 1,
        candidates: ["65817c30a78bb44c3dc3771876b6010a"],
      });
      for (let split = 1; split < payload.length; split += 1) {
        const scanner = new SnapshotHashScanner();
        scanner.push(payload.subarray(0, split));
        scanner.push(payload.subarray(split));
        expect(scanner.result(), `split at ${split}`).toEqual(whole.result());
      }
      const bytewise = new SnapshotHashScanner();
      for (let offset = 0; offset < payload.length; offset += 1)
        bytewise.push(payload.subarray(offset, offset + 1));
      expect(bytewise.result()).toEqual(whole.result());
    },
  );

  it("ignores a magic without a following hash", () => {
    const scanner = new SnapshotHashScanner();
    scanner.push(Uint8Array.from([0xf5, 0xf5, 0xdc, 0xdc, 0xff, 0xff, 0xff]));
    expect(scanner.result()).toEqual({
      capped: false,
      sources: 0,
      candidates: [],
    });
  });
});

it("distinguishes a full candidate set from omitted conflicts", () => {
  const scanner = new SnapshotHashScanner();
  for (let index = 0; index < 64; index += 1)
    scanner.push(realSnapshotSection(index.toString(16).padStart(32, "0")));
  expect(scanner.result().capped).toBe(false);
  scanner.push(realSnapshotSection("0".repeat(32)));
  expect(scanner.result().capped).toBe(false);
  scanner.push(realSnapshotSection("f".repeat(32)));
  expect(scanner.result()).toMatchObject({ sources: 66, capped: true });
  expect(scanner.result().candidates).toHaveLength(64);
});

const assertSingleToolchainLine = (line: string): void => {
  const scanner = new LabeledStringScanner();
  scanner.push(
    Uint8Array.from(
      Array.from(`\x00${line}\x00`, (character) => character.charCodeAt(0)),
    ),
  );
  expect(scanner.result().toolchainLines).toEqual([line]);
};

describe("LabeledStringScanner toolchain lines", () => {
  it("collects a full clang line within the 500-character bound", () => {
    assertSingleToolchainLine(
      "Android (5900059 based on r365631c1) clang version 9.0.8 (https://android.googlesource.com/toolchain/llvm-project 207d7abc1a2abf3ef8d4301736d6a7ebc224a290) (based on LLVM 9.0.8svn)",
    );
  });

  it("collects the labeled Android clang line", () => {
    assertSingleToolchainLine(
      "Android (5900059 based on r365631c) clang version 9.0.8 (https://android.googlesource.com/toolchain/llvm-project 207d7abc) (based on LLVM 9.0.8svn)",
    );
  });

  it("does not claim a toolchain cap for unrelated overlong strings", () => {
    const scanner = new LabeledStringScanner();
    const license = `Apache License Version 2.0 ${"x".repeat(700)}`;
    scanner.push(
      Uint8Array.from(
        Array.from(`\x00${license}\x00`, (character) =>
          character.charCodeAt(0),
        ),
      ),
    );
    const result = scanner.result();
    expect(result.toolchainCapped).toBe(false);
    expect(result.toolchainLines).toEqual([]);
  });

  it("preserves trailing whitespace on LLVM toolchain lines", () => {
    assertSingleToolchainLine("based on LLVM 9  ");
  });
});

describe("LabeledStringScanner Dart version strings", () => {
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

  it.each([
    [
      "release engine",
      '3.7.2 (stable) (Tue Mar 11 04:27:50 2025 -0700) on "android_arm64"',
    ],
    [
      "Flutter Gallery engine",
      "2.14.0-151.0.dev (dev) (Tue May 25 10:58:39 2021 -0700)",
    ],
  ] as const)(
    "reads an unlabeled Dart Version::String() from a %s",
    (_label, line) => {
      const scanner = new LabeledStringScanner();
      scanner.push(Buffer.from(`\x00${line}\x00`));
      expect(scanner.result()).toMatchObject({
        dartVersion: line,
        dartVersionCapped: false,
      });
    },
  );

  it("ignores unlabeled version-shaped text without a channel token", () => {
    const scanner = new LabeledStringScanner();
    scanner.push(
      Buffer.from(
        '1.2.3 (Tue May 25 10:58:39 2021 -0700) on "android_arm64"\x00',
      ),
    );
    expect(scanner.result().dartVersion).toBeNull();
  });

  it("does not claim a Dart cap for unlabeled runs that miss the grammar", () => {
    const scanner = new LabeledStringScanner();
    scanner.push(Buffer.from("3.7.2 (stable)\x00"));
    expect(scanner.result()).toMatchObject({
      dartVersion: null,
      dartVersionCapped: false,
    });
  });

  it("claims the cap only for an overlong run shaped like a toolchain line", () => {
    const overlongToolchain = `Android (${"r".repeat(700)}) clang version 9`;
    for (const [text, toolchainCapped, dartVersionCapped] of [
      [overlongToolchain, true, false],
      [`Dart VM version: ${"3".repeat(700)}`, false, true],
      [`based on LLVM 9 ${"x".repeat(700)}`, true, false],
    ] as const) {
      const scanner = new LabeledStringScanner();
      scanner.push(
        Uint8Array.from(
          Array.from(`\x00${text}\x00`, (character) => character.charCodeAt(0)),
        ),
      );
      expect(scanner.result()).toMatchObject({
        toolchainCapped,
        dartVersionCapped,
        dartVersion: null,
        toolchainLines: [],
      });
    }
  });

  it.each([
    { label: "Dart", line: `Dart VM version:${"x".repeat(200)}`, dart: true },
    {
      label: "embedded Dart",
      line: '3.7.2 (stable) (Tue Mar 11 04:27:50 2025 -0700) on "android_arm64"',
      dart: true,
      // Trailing junk breaks the whole-run grammar; do not treat as a cap.
      invalidCaps: false,
    },
    {
      label: "Android clang",
      line: `Android (${"r".repeat(80)}) clang version ${"x".repeat(500)}`,
      dart: false,
    },
    { label: "LLVM", line: `based on LLVM 9${"x".repeat(80)}`, dart: false },
  ])(
    "requires the complete $label run at its own grammar boundary",
    ({ line, dart, invalidCaps }) => {
      for (const suffix of ["", "x", "x".repeat(1000)]) {
        const payload = Buffer.from(`${line}${suffix}\x00`);
        for (const chunkSize of [1, 7, payload.length]) {
          const scanner = new LabeledStringScanner();
          for (let offset = 0; offset < payload.length; offset += chunkSize)
            scanner.push(payload.subarray(offset, offset + chunkSize));
          const valid = suffix === "";
          const capsInvalid = invalidCaps ?? true;
          expect(scanner.result()).toEqual({
            dartVersion: dart && valid ? line : null,
            dartVersionCapped: dart && !valid && capsInvalid,
            toolchainLines: !dart && valid ? [line] : [],
            toolchainCapped: !dart && !valid,
          });
        }
      }
    },
  );

  it("separates distinct Dart-label omissions", () => {
    const scanner = new LabeledStringScanner();
    scanner.push(Buffer.from("Dart VM version: 3.1\0Dart VM version: 3.2\0"));
    expect(scanner.result()).toMatchObject({
      dartVersion: "Dart VM version: 3.1",
      dartVersionCapped: true,
      toolchainCapped: false,
    });
  });
});
