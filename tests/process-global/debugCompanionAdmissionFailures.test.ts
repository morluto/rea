import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  statPath: "",
  statFailure: undefined as Error | undefined,
  openPath: "",
  openFailure: undefined as Error | undefined,
  controller: undefined as AbortController | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    stat: async (...args: Parameters<typeof original.stat>) => {
      if (args[0] === fault.statPath && fault.statFailure !== undefined) {
        // The caller cancels while the failing metadata read is pending.
        fault.controller?.abort(new Error("caller cancelled admission"));
        throw fault.statFailure;
      }
      return await original.stat(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      if (args[0] === fault.openPath && fault.openFailure !== undefined)
        throw fault.openFailure;
      return await original.open(...args);
    },
  };
});

import { admitDebugCompanion } from "../../src/application/DebugCompanionAdmission.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import { BinaryTargetError } from "../../src/domain/configurationErrors.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

beforeEach(() => {
  fault.statPath = "";
  fault.statFailure = undefined;
  fault.openPath = "";
  fault.openFailure = undefined;
  fault.controller = undefined;
});

const UUID = "11111111-2222-3333-4444-555555555555";

const uuidImage = (): Buffer => {
  const bytes = Buffer.alloc(56);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(0x1b, 32);
  bytes.writeUInt32LE(24, 36);
  Buffer.from(UUID.replaceAll("-", ""), "hex").copy(bytes, 40);
  return bytes;
};

const admissionFixture = async () => {
  const root = await createTestTempDirectory("rea-dsym-admission-io-");
  const dsymPath = join(root, "selected.dSYM");
  const directory = join(dsymPath, "Contents", "Resources", "DWARF");
  await mkdir(directory, { recursive: true });
  const member = join(directory, "member");
  await writeFile(member, uuidImage());
  const target = join(root, "target");
  await writeFile(target, uuidImage());
  const admit = async (signal?: AbortSignal) => {
    const targetHandle = await open(target, "r");
    try {
      return await admitDebugCompanion({
        dsymPath,
        targetHandle,
        targetSize: 56,
        architecture: "x86_64",
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      await targetHandle.close();
    }
  };
  return { dsymPath, member, admit };
};

const errno = (code: string): Error =>
  Object.assign(new Error(`controlled ${code}`), { code });

it("keeps an observed bundle I/O failure primary over a later cancellation", async () => {
  const fixture = await admissionFixture();
  const controller = new AbortController();
  const failure = errno("EIO");
  fault.controller = controller;
  fault.statPath = fixture.dsymPath;
  fault.statFailure = failure;
  const rejection: unknown = await fixture.admit(controller.signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(rejection).toBeInstanceOf(BinaryTargetError);
  expect(rejection).toMatchObject({
    path: fixture.dsymPath,
    cause: failure,
  });
});

it("reports cancellation instead of caller input when a missing bundle races an abort", async () => {
  const fixture = await admissionFixture();
  const controller = new AbortController();
  fault.controller = controller;
  fault.statPath = fixture.dsymPath;
  fault.statFailure = errno("ENOENT");
  await expect(fixture.admit(controller.signal)).rejects.toBeInstanceOf(
    AnalysisCancelledError,
  );
});

it.each(["EMFILE", "EIO"])(
  "attributes a %s while opening a DWARF member to that member",
  async (code) => {
    const fixture = await admissionFixture();
    fault.openPath = fixture.member;
    fault.openFailure = errno(code);
    const rejection: unknown = await fixture.admit().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(rejection).toBeInstanceOf(BinaryTargetError);
    expect(rejection).toMatchObject({
      path: fixture.member,
      message: expect.stringContaining(code),
    });
  },
);

it("still skips an unreadable DWARF candidate as caller data", async () => {
  const fixture = await admissionFixture();
  fault.openPath = fixture.member;
  fault.openFailure = errno("EACCES");
  expect(await fixture.admit()).toMatchObject({
    ok: false,
    error: {
      reason: expect.stringContaining("no Mach-O DWARF member"),
    },
  });
});
