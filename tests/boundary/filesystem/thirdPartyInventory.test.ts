import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect } from "vitest";

import { processTest as test } from "../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { copyScriptsWithImports } from "../../support/scriptImportClosure.js";

test("generates locked inventory and rejects stale notice metadata or preserved texts", async ({
  processes,
}) => {
  const root = await createTestTempDirectory("rea-notice-records-");
  await mkdir(resolve(root, "licenses"));
  await copyScriptsWithImports(
    ["scripts/generate-third-party-inventory.mjs"],
    root,
  );
  const script = resolve(root, "scripts/generate-third-party-inventory.mjs");
  const runtime = {
    version: "1.0.0",
    license: "MIT",
    resolved:
      "https://registry.npmjs.org/fixture-runtime/-/fixture-runtime-1.0.0.tgz",
    integrity: "sha512-fixture-integrity",
    optional: true,
  };
  const bundler = {
    version: "2.0.0",
    license: "MIT",
    resolved: "https://registry.npmjs.org/rolldown/-/rolldown-2.0.0.tgz",
    integrity: "sha512-bundler-integrity",
    dev: true,
  };
  await writeFile(
    resolve(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/fixture-runtime": runtime,
        "node_modules/rolldown": bundler,
        "node_modules/vite/node_modules/rolldown": {
          ...bundler,
          version: "1.0.0",
        },
      },
    }),
  );
  const generated = await processes.run(process.execPath, [script]);
  expect(generated.exitCode, generated.stderr).toBe(0);
  const inventory = await readFile(
    resolve(root, "licenses/npm-dependencies.txt"),
    "utf8",
  );
  expect(inventory).toContain("Locked package entries: 3; runtime: 1.");
  expect(inventory).toContain(
    "fixture-runtime@1.0.0 | runtime, optional | MIT",
  );
  expect(inventory).toContain("rolldown@2.0.0 | development | MIT");
  const fingerprint = (
    JSON.parse(generated.stdout) as { runtime_dependency_fingerprint: string }
  ).runtime_dependency_fingerprint;
  const notice = [
    `Runtime dependency fingerprint (SHA-256): ${fingerprint}`,
    "",
    "===== fixture-runtime@1.0.0 =====",
    "Declared license: MIT",
    `Archive: ${runtime.resolved}`,
    `Integrity: ${runtime.integrity}`,
    "",
    "Fixture text; this test does not establish real package attribution.",
    "",
    "===== rolldown@2.0.0 =====",
    "Declared license: MIT",
    `Archive: ${bundler.resolved}`,
    `Integrity: ${bundler.integrity}`,
    "",
    "Fixture helper notice.",
    "",
  ].join("\n");
  const noticePath = resolve(root, "licenses/npm-runtime-notices.txt");
  const referencePath = resolve(root, "licenses/reference.txt");
  await writeFile(noticePath, notice);
  await writeFile(referencePath, "preserved fixture text\n");
  await writeFile(
    resolve(root, "licenses/upstream-sources.json"),
    JSON.stringify([
      {
        file: "licenses/reference.txt",
        sha256: createHash("sha256")
          .update("preserved fixture text\n")
          .digest("hex"),
      },
    ]),
  );
  const check = () => processes.run(process.execPath, [script, "--check"]);
  const valid = await check();
  expect(valid.exitCode, valid.stderr).toBe(0);
  for (const [changed, diagnostic] of [
    [
      notice.replace(
        "===== fixture-runtime@1.0.0 =====",
        "===== another-package@1.0.0 =====",
      ),
      "Missing runtime notice",
    ],
    [
      notice.replace(runtime.integrity, "sha512-different"),
      "Runtime notice metadata differs",
    ],
    [
      notice.replace(
        "===== rolldown@2.0.0 =====",
        "===== rolldown@1.0.0 =====",
      ),
      "Missing runtime notice: rolldown@2.0.0",
    ],
    [
      notice.replace(bundler.integrity, "sha512-outdated"),
      "Runtime notice metadata differs for rolldown@2.0.0",
    ],
    [
      notice.replace(fingerprint, "0".repeat(64)),
      "Runtime notice fingerprint differs",
    ],
    [
      notice + notice.slice(notice.indexOf("===== ")),
      "Duplicate runtime notice",
    ],
  ] as const) {
    await writeFile(noticePath, changed);
    const rejected = await check();
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain(diagnostic);
  }
  await writeFile(noticePath, notice);
  await writeFile(referencePath, "changed fixture text\n");
  const tampered = await check();
  expect(tampered.exitCode).toBe(1);
  expect(tampered.stderr).toContain("Preserved notice digest differs");
  expect(
    await readFile(resolve(root, "licenses/npm-dependencies.txt"), "utf8"),
  ).toBe(inventory);
});
