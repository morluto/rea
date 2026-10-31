import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { GhidraDiagnosticExport } from "./GhidraDiagnosticExport.js";

it("retains complete streams and logs after source deletion while redacting split credentials", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const source = join(root, "source.log");
  await writeFile(source, "before secret after");
  const capture = new GhidraDiagnosticExport(root, "secret", {
    run_id: "run",
    target_sha256: "sha",
    profile_digest: "profile",
  });
  capture.write("stdout", Buffer.from("head sec"));
  capture.write("stdout", Buffer.from("ret tail"));
  capture.write("stderr", Buffer.from("err"));
  capture.finish(
    { ghidraLogPath: source, scriptLogPath: join(root, "missing") },
    true,
  );
  await writeFile(source, "overwritten");
  expect(await readFile(join(capture.path, "stdout.log"), "utf8")).toBe(
    "head [REDACTED] tail",
  );
  expect(await readFile(join(capture.path, "ghidra.log"), "utf8")).toBe(
    "before [REDACTED] after",
  );
  const manifest = JSON.parse(
    await readFile(join(capture.path, "manifest.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    run_id: "run",
    target_sha256: "sha",
    profile_digest: "profile",
  });
  expect(manifest.files.stdout).toEqual({ status: "complete" });
  expect(manifest.files.script).toEqual({ status: "unavailable" });
});

it("records incomplete transport capture rather than calling it complete", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const capture = new GhidraDiagnosticExport(root, "secret", {
    run_id: "run",
    target_sha256: "sha",
    profile_digest: "profile",
  });
  capture.write("stdout", Buffer.from("partial sec"));
  capture.finish(undefined, false);
  const manifest = JSON.parse(
    await readFile(join(capture.path, "manifest.json"), "utf8"),
  );
  expect(manifest.files.stdout).toEqual({ status: "incomplete" });
  expect(await readFile(join(capture.path, "stdout.log"), "utf8")).toBe(
    "partial [REDACTED]",
  );
});

it("publishes a partial manifest and reports a failed log copy", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const source = join(root, "source.log");
  await writeFile(source, "source");
  const capture = new GhidraDiagnosticExport(root, "secret", {
    run_id: "run",
    target_sha256: "sha",
    profile_digest: "profile",
  });
  await writeFile(join(capture.path, "ghidra.log"), "occupied");
  expect(() =>
    capture.finish(
      { ghidraLogPath: source, scriptLogPath: join(root, "missing") },
      true,
    ),
  ).toThrow("diagnostic export failed");
  const manifest = JSON.parse(
    await readFile(join(capture.path, "manifest.json"), "utf8"),
  );
  expect(manifest.files.ghidra.status).toBe("error");
  expect(manifest.files.script.status).toBe("unavailable");
});
