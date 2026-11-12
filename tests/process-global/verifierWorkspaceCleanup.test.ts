import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it("preserves a pre-workspace failure and command cleanup failure", async () => {
  const primary = new Error("tool lookup failed");
  const cleanup = new Error("command cleanup failed");
  const { withVerifierWorkspace } =
    await import("../../scripts/lib/verifier-workspace.mjs");
  const failure: unknown = await withVerifierWorkspace(
    () => {
      throw primary;
    },
    { close: async () => Promise.reject(cleanup) },
    () => undefined,
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toBe(primary);
  expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
});

it("retains the parent lease when workspace removal fails after command close", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-verifier-workspace-"));
  const removal = new Error("controlled workspace removal failure");
  await writeFile(join(root, "evidence"), "retained");
  let denied = true;
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
      ...actual,
      rm: async (...args: Parameters<typeof rm>) => {
        if (args[0] === root && denied) throw removal;
        await actual.rm(...args);
      },
    };
  });
  try {
    const { withVerifierWorkspace } =
      await import("../../scripts/lib/verifier-workspace.mjs");
    const failure: unknown = await withVerifierWorkspace(
      () => "verified",
      { close: async () => undefined },
      () => root,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    const retained = failure as Error & {
      cleanupLeases: { release(): Promise<void> }[];
    };
    expect((retained.cause as AggregateError).errors).toContain(removal);
    expect(retained.cleanupLeases).toHaveLength(1);
    await access(join(root, "evidence"));
    await expect(retained.cleanupLeases[0]!.release()).rejects.toBe(removal);
    denied = false;
    await retained.cleanupLeases[0]!.release();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  }
});
