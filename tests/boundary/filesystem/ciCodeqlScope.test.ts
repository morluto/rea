import { readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const github = new URL("../../../.github/", import.meta.url);
const configuration = z
  .strictObject({
    name: z.string(),
    "threat-models": z.array(z.string()),
    paths: z.array(z.string()),
    "paths-ignore": z.array(z.string()),
  })
  .parse(
    parse(await readFile(new URL("codeql/production.yml", github), "utf8")),
  );

const excluded = (path: string): boolean =>
  configuration["paths-ignore"].some(
    (pattern) =>
      path === pattern ||
      path.startsWith(`${pattern}/`) ||
      matchesGlob(path, pattern),
  );

it.each([
  "tests/fixtures/fakeHopper.mjs",
  "tests/conformance/ghidra/riscv-checks.mjs",
  "tests/support/analysis-efficiency/resource-run.py",
  "scripts/fixtures/http3-lab.py",
  "scripts/fixtures/managed/pe.mjs",
  "src/process/ExecFileOutput.test.ts",
  "src/process/ProcessOwnership.fixture.ts",
  "scripts/lib/http3-verifier-lifecycle.test.mjs",
  "bridge/pwndbg/test_core_context.py",
  "bridge/example_test.py",
])("excludes test-only input %s", (path) => {
  expect(excluded(path)).toBe(true);
});

it.each([
  "src/process/ExecFileOutput.ts",
  "src/filesystem/RegularFile.ts",
  "src/application/ClientConfigurationPublication.ts",
  "bridge/pwndbg/launch.py",
  "bridge/pwntools/layout_impl.py",
  "bridge/native/rea_lldb_tracer.py",
  "bridge/ghidra/ReaGhidraBridge.java",
  "install.sh",
  "scripts/rea.mjs",
  "scripts/prepack.mjs",
  "scripts/hopper-demo-x11.py",
  "scripts/ci/release-recovery.mjs",
  "scripts/verify-package-install.mjs",
  "scripts/verify-package-update.mjs",
  "scripts/verify-windows-native-artifact.mjs",
  "docs/.vitepress/config.ts",
  ".github/workflows/release.yml",
  ".github/actions/publish-mcp/action.yml",
])("retains production or release input %s", (path) => {
  expect(excluded(path)).toBe(false);
});

it("retains all packaged entrypoints and the existing local-input threat model", async () => {
  const manifest = z
    .object({ files: z.array(z.string()) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../../package.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  expect(manifest.files.filter(excluded)).toEqual([]);
  expect(configuration["threat-models"]).toEqual(["local"]);
  // A narrow allowlist would silently drop new production roots. Explicitly
  // traverse the hidden configuration directory without excluding the root.
  expect(configuration.paths).toContain(".");
  expect(configuration.paths).toContain("docs/.vitepress");
});

it("uses the scope in a bounded workflow gated on administrator activation", async () => {
  const workflow = z
    .object({
      permissions: z.object({ contents: z.literal("read") }),
      jobs: z.object({
        analyze: z.object({
          if: z.string(),
          permissions: z.object({
            contents: z.literal("read"),
            "security-events": z.literal("write"),
          }),
          strategy: z.object({
            "max-parallel": z.literal(1),
            matrix: z.object({ language: z.array(z.string()) }),
          }),
          steps: z.array(
            z.object({
              uses: z.string(),
              with: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        }),
      }),
    })
    .parse(
      parse(await readFile(new URL("workflows/codeql.yml", github), "utf8")),
    );
  const job = workflow.jobs.analyze;
  expect(job.if).toBe("vars.REA_CODEQL_ADVANCED == 'true'");
  expect(job.strategy.matrix.language).toEqual([
    "javascript-typescript",
    "python",
    "actions",
  ]);
  const init = job.steps.find((step) =>
    step.uses.startsWith("github/codeql-action/init@"),
  );
  expect(init?.with).toMatchObject({
    "config-file": ".github/codeql/production.yml",
    "build-mode": "none",
    threads: 2,
    ram: 4096,
  });
  const analyze = job.steps.find((step) =>
    step.uses.startsWith("github/codeql-action/analyze@"),
  );
  expect(analyze?.with).toMatchObject({
    category: "/language:${{ matrix.language }}",
    threads: 2,
    ram: 4096,
  });
  expect(analyze?.with).not.toHaveProperty("upload");
});
