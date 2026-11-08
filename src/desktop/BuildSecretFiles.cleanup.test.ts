import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { DesktopBuildSecrets } from "../application/desktop/DesktopBuildSecrets.js";

// Made-up values, never real credentials.
const FIRST = "e-Plum7-Kite-Throwaway-42";
const SECOND = "e-Quince3-Lantern-Throwaway-77";

const injection = vi.hoisted(() => ({
  path: "",
  remaining: 0,
  failWrite: false,
  unlinkFailures: 0,
  opened: [] as { close(): Promise<void> }[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (
        typeof args[0] === "string" &&
        injection.path !== "" &&
        args[0].startsWith(
          join(dirname(injection.path), `.${basename(injection.path)}.`),
        ) &&
        injection.unlinkFailures > 0
      ) {
        injection.unlinkFailures--;
        throw Object.assign(new Error("unlink refused"), { code: "EACCES" });
      }
      return actual.unlink(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      // The secret's file, or the one its bytes are written to before it takes the secret's name.
      if (
        args[0] === injection.path ||
        (injection.path !== "" &&
          typeof args[0] === "string" &&
          args[0].startsWith(
            join(dirname(injection.path), `.${basename(injection.path)}.`),
          ))
      ) {
        injection.opened.push(file);
        if (injection.failWrite)
          file.writeFile = async () => {
            throw Object.assign(new Error(FIRST), { code: "EIO" });
          };
        const close = file.close.bind(file);
        file.close = async () => {
          if (injection.remaining > 0) {
            injection.remaining--;
            throw new Error("close failed");
          }
          await close();
        };
      }
      return file;
    },
  };
});
afterEach(async () => {
  injection.path = "";
  injection.remaining = 0;
  injection.failWrite = false;
  injection.unlinkFailures = 0;
  await Promise.all(injection.opened.splice(0).map((file) => file.close()));
  vi.restoreAllMocks();
});

const failCloses = (directory: string, count: number) => {
  injection.path = join(directory, "master");
  injection.remaining = count;
};

it("retains a failed secret read close for retry without exposing the value", async () => {
  const directory = await folder();
  await writeSecret(directory, "master", FIRST);
  const secrets = new DesktopBuildSecrets(directory);
  await failCloses(directory, 2);
  const read = await secrets.resolve("master");
  expect(read.ok).toBe(false);
  if (read.ok || !(read.error instanceof AnalysisError))
    throw new Error("expected cleanup failure");
  expect(read.error.cleanupIncomplete).toBe(true);
  expect(read.error.cleanupResources).toEqual([join(directory, "master")]);
  expect(JSON.stringify(projectAnalysisError(read.error))).not.toContain(FIRST);
  expect(secrets.redact(FIRST)).toBe("<secret:master>");
  await expect(secrets.close()).rejects.toBeInstanceOf(AnalysisError);
  expect(read.error.cleanupIncomplete).toBe(true);
  await secrets.close();
  expect(read.error.cleanupIncomplete).toBe(false);
});

it("preserves an earlier permission refusal when the secret close fails", async () => {
  const directory = await folder();
  await writeSecret(directory, "master", FIRST);
  await chmod(join(directory, "master"), 0o644);
  const secrets = new DesktopBuildSecrets(directory);
  await failCloses(directory, 1);
  const read = await secrets.resolve("master");
  expect(read.ok).toBe(false);
  if (read.ok || !(read.error instanceof AnalysisError))
    throw new Error("expected cleanup failure");
  expect(read.error.userMessage).toContain("chmod 600");
  expect(JSON.stringify(projectAnalysisError(read.error))).not.toContain(FIRST);
  await secrets.close();
  expect(read.error.cleanupIncomplete).toBe(false);
});

it("retries an owned close before a later secret read", async () => {
  const directory = await folder();
  await writeSecret(directory, "master", FIRST);
  const secrets = new DesktopBuildSecrets(directory);
  failCloses(directory, 1);
  const first = await secrets.resolve("master");
  if (first.ok || !(first.error instanceof AnalysisError))
    throw new Error("expected cleanup failure");
  const second = await secrets.resolve("master");
  expect(second).toEqual({ ok: true, value: FIRST });
  expect(first.error.cleanupIncomplete).toBe(false);
  await secrets.close();
});

it("retains a written secret and its close owner without exposing the value", async () => {
  const directory = await folder();
  const secrets = new DesktopBuildSecrets(directory);
  await failCloses(directory, 1);
  let failure: unknown;
  try {
    await secrets.keep("master", Buffer.from(FIRST));
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AnalysisError);
  if (!(failure instanceof AnalysisError))
    throw new Error("expected cleanup failure");
  const encoded = Buffer.from(FIRST).toString("base64");
  expect(JSON.stringify(projectAnalysisError(failure))).not.toContain(encoded);
  expect(secrets.redact(encoded)).toBe("<secret:master>");
  await secrets.close();
  expect(failure.cleanupIncomplete).toBe(false);
});

it("preserves a safe write failure reason when close also fails", async () => {
  const directory = await folder();
  const secrets = new DesktopBuildSecrets(directory);
  failCloses(directory, 1);
  injection.failWrite = true;
  let failure: unknown;
  try {
    await secrets.keep("master", Buffer.from(FIRST));
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AnalysisError);
  if (!(failure instanceof AnalysisError))
    throw new Error("expected cleanup failure");
  expect(failure.userMessage).toContain("EIO");
  expect(JSON.stringify(projectAnalysisError(failure))).not.toContain(FIRST);
  await secrets.close();
  expect(failure.cleanupIncomplete).toBe(false);
});

it.each([false, true])(
  "retains temporary secret cleanup after publication or a write failure (write fails: %s)",
  async (failWrite) => {
    const directory = await folder();
    const secrets = new DesktopBuildSecrets(directory);
    failCloses(directory, 0);
    injection.failWrite = failWrite;
    injection.unlinkFailures = 2;
    let failure: unknown;
    try {
      await secrets.keep("master", Buffer.from(FIRST));
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError))
      throw new Error("expected cleanup failure");
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toHaveLength(1);
    if (failWrite) expect(failure.userMessage).toContain("EIO");
    else
      expect(failure.diagnostics).toMatchObject({ published_handle: "master" });
    expect(JSON.stringify(projectAnalysisError(failure))).not.toContain(FIRST);
    expect(
      (await readdir(directory)).some((name) => name.startsWith(".master.")),
    ).toBe(true);
    await expect(secrets.close()).rejects.toBeInstanceOf(AnalysisError);
    await secrets.close();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(
      (await readdir(directory)).some((name) => name.startsWith(".master.")),
    ).toBe(false);
    expect((await readdir(directory)).includes("master")).toBe(!failWrite);
  },
);

it("retains both descriptor and temporary-name cleanup after a failed write", async () => {
  const directory = await folder();
  const secrets = new DesktopBuildSecrets(directory);
  failCloses(directory, 1);
  injection.failWrite = true;
  injection.unlinkFailures = 1;
  let failure: unknown;
  try {
    await secrets.keep("master", Buffer.from(FIRST));
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AnalysisError);
  if (!(failure instanceof AnalysisError))
    throw new Error("expected cleanup failure");
  expect(failure.cleanupIncomplete).toBe(true);
  expect(failure.userMessage).toContain("EIO");
  await secrets.close();
  expect(failure.cleanupIncomplete).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});

const folder = async () => {
  const directory = join(await createTestTempDirectory("secrets-"), "s");
  await mkdir(directory, { mode: 0o700 });
  return directory;
};

const writeSecret = async (directory: string, handle: string, text: string) => {
  await writeFile(join(directory, handle), text);
  await chmod(join(directory, handle), 0o600);
};
