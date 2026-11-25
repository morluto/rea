import type { FileHandle } from "node:fs/promises";
import { open, readdir, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { join } from "node:path";

import { decode } from "@toon-format/toon";
import { expect, it, vi } from "vitest";

import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { closeCliResources } from "../../../src/cli/cliResources.js";
import { parseCliOutputArguments } from "../../../src/cli/cliOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", { spy: true });
const native =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const value = {
  rows: Array.from({ length: 20 }, () => ({ text: "x".repeat(65536) })),
};
const metadata = { command: "fixture", duration: "1ms" };

const withStageFault = async (
  fault:
    | "close"
    | "remove"
    | "capacity-and-close"
    | "capacity-and-remove"
    | "close-then-remove",
  run: (fixture: {
    root: string;
    events: string[];
    file: () => FileHandle | undefined;
    allowCleanup: () => void;
  }) => Promise<void>,
) => {
  const root = await createTestTempDirectory("rea-toon-cleanup-");
  const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const previous = process.env[variable];
  process.env[variable] = root;
  let denied = true;
  let recovering = false;
  let removalAttempts = 0;
  let file: FileHandle | undefined;
  let nativeClose: (() => Promise<void>) | undefined;
  const events: string[] = [];
  vi.mocked(open).mockImplementationOnce(async (...arguments_) => {
    file = await native.open(...arguments_);
    nativeClose = file.close.bind(file);
    let closing = false;
    vi.spyOn(file, "close").mockImplementation(async () => {
      // FileHandle.close also closes its read stream, which may reenter close.
      if (closing) return nativeClose?.();
      events.push("close");
      if (
        (fault === "close" ||
          fault === "capacity-and-close" ||
          fault === "close-then-remove") &&
        denied
      )
        throw new Error("close denied");
      closing = true;
      try {
        await nativeClose?.();
      } finally {
        closing = false;
      }
    });
    if (fault.startsWith("capacity-"))
      vi.spyOn(file, "writeFile").mockRejectedValueOnce(
        Object.assign(new Error("temporary storage full"), { code: "ENOSPC" }),
      );
    return file;
  });
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (String(path).startsWith(root)) {
      events.push("remove");
      if (
        fault === "close-then-remove" &&
        !recovering &&
        !denied &&
        removalAttempts++ === 0
      )
        throw new Error("remove denied after close recovery");
      if ((fault === "remove" || fault === "capacity-and-remove") && denied)
        throw new Error("remove denied");
    }
    await native.rm(path, options);
  });
  try {
    await run({
      root,
      events,
      file: () => file,
      allowCleanup: () => {
        denied = false;
      },
    });
  } finally {
    denied = false;
    recovering = true;
    try {
      await closeCliResources();
    } finally {
      if (file !== undefined && file.fd >= 0) await nativeClose?.();
      vi.restoreAllMocks();
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  }
};
const outputFor = (parts: Buffer[]) => {
  const output = createCliResultOutput(
    parseCliOutputArguments([]),
    new Writable({
      write(part: Buffer, _encoding, done) {
        parts.push(part);
        done();
      },
    }),
  );
  if (output === undefined) throw new Error("Missing CLI result output");
  return output;
};

it("retains a failed descriptor close and its root through shutdown retries", async () => {
  await withStageFault("close", async ({ root, events, allowCleanup }) => {
    const failure = await outputFor([])
      .write(value, metadata)
      .then(
        () => {
          throw new Error("Expected cleanup failure");
        },
        (cause: unknown) => cause,
      );
    expect(await readdir(root)).toHaveLength(1);
    expect(events).toEqual(["close"]);
    expect(failure).toMatchObject({ cleanupIncomplete: true });
    await expect(closeCliResources()).rejects.toThrow();
    expect(events).toEqual(["close", "close"]);
    expect(await readdir(root)).toHaveLength(1);
    allowCleanup();
    await closeCliResources();
    expect(events).toEqual(["close", "close", "close", "remove"]);
    expect(await readdir(root)).toEqual([]);
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
  });
});

it("retries only directory removal after the descriptor has closed", async () => {
  await withStageFault(
    "remove",
    async ({ root, events, file, allowCleanup }) => {
      const failure = await outputFor([])
        .write(value, metadata)
        .then(
          () => {
            throw new Error("Expected cleanup failure");
          },
          (cause: unknown) => cause,
        );
      expect(file()?.fd).toBe(-1);
      expect(await readdir(root)).toHaveLength(1);
      await expect(closeCliResources()).rejects.toThrow();
      expect(events).toEqual(["close", "remove", "remove"]);
      allowCleanup();
      await closeCliResources();
      expect(events).toEqual(["close", "remove", "remove", "remove"]);
      expect(await readdir(root)).toEqual([]);
      expect(failure).toMatchObject({ cleanupIncomplete: false });
    },
  );
});

it.each(["capacity-and-close", "capacity-and-remove"] as const)(
  "keeps a typed capacity refusal alongside %s",
  async (fault) => {
    await withStageFault(fault, async ({ root, events, allowCleanup }) => {
      const parts: Buffer[] = [];
      const output = outputFor(parts);
      expect(await output.write(value, metadata)).toBe(true);
      const text = Buffer.concat(parts).toString("utf8");
      expect(text).not.toContain("rows[");
      expect(decode(text)).toMatchObject({ code: "cleanup_incomplete" });
      expect(text).toContain("resource_constraint");
      expect(text).toContain("ENOSPC");
      expect(text).toContain("--format json");
      expect(events).toEqual(
        fault === "capacity-and-close" ? ["close"] : ["close", "remove"],
      );
      expect(await readdir(root)).toHaveLength(1);
      allowCleanup();
      await closeCliResources();
      expect(await readdir(root)).toEqual([]);
    });
  },
);

it("retains a failed destination and cleanup without publishing a replacement document", async () => {
  await withStageFault("close", async ({ root, allowCleanup }) => {
    const cause = new Error("destination closed");
    let writes = 0;
    const output = createCliResultOutput(
      parseCliOutputArguments([]),
      new Writable({
        write(_part, _encoding, done) {
          writes++;
          done(cause);
        },
      }),
    );
    if (output === undefined) throw new Error("Missing CLI result output");
    const failure = await output.write(value, metadata).then(
      () => {
        throw new Error("Expected output and cleanup failure");
      },
      (error: unknown) => error,
    );
    expect(output.failed).toBe(true);
    expect(writes).toBe(1);
    expect(failure).toMatchObject({
      cleanupIncomplete: true,
      outputFailure: { cause },
    });
    expect(await readdir(root)).toHaveLength(1);
    allowCleanup();
    await closeCliResources();
    expect(await readdir(root)).toEqual([]);
    expect(failure).toMatchObject({ cleanupIncomplete: false });
  });
});

it("updates unresolved resources when a recovered close is followed by failed removal", async () => {
  await withStageFault(
    "close-then-remove",
    async ({ root, events, allowCleanup }) => {
      const failure = await outputFor([])
        .write(value, metadata)
        .then(
          () => {
            throw new Error("Expected cleanup failure");
          },
          (cause: unknown) => cause,
        );
      const [name] = await readdir(root);
      const stage = join(root, name!);
      expect(failure).toMatchObject({ cleanupIncomplete: true });
      allowCleanup();
      await expect(closeCliResources()).rejects.toThrow();
      expect(failure).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [stage],
      });
      expect(events).toEqual(["close", "close", "remove"]);
      await closeCliResources();
      expect(events).toEqual(["close", "close", "remove", "remove"]);
      expect(failure).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    },
  );
});

it("refuses staging when the private-root authority cannot establish privacy", async () => {
  const refusal = new Error("Private runtime unavailable");
  const create = vi
    .spyOn(PrivateRuntimeRoot, "create")
    .mockRejectedValueOnce(refusal);
  const openStage = vi.mocked(open);
  const before = openStage.mock.calls.length;
  const parts: Buffer[] = [];
  try {
    await expect(outputFor(parts).write(value, metadata)).rejects.toBe(refusal);
    expect(create).toHaveBeenCalledWith({ prefix: "rea-toon-" });
    expect(openStage.mock.calls.length).toBe(before);
    expect(parts).toEqual([]);
  } finally {
    vi.restoreAllMocks();
  }
});
