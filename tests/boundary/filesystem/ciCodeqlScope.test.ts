import { readFile } from "node:fs/promises";
import { matchesGlob } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import {
  CODEQL_LANGUAGES,
  planCodeqlLanguages,
} from "../../../scripts/ci/codeql-scope.mjs";

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

const triggerPathsSchema = z.object({
  branches: z.array(z.string()),
  "paths-ignore": z.array(z.string()),
});
const workflowDocument = z
  .object({
    on: z.object({
      push: triggerPathsSchema,
      pull_request: triggerPathsSchema,
      schedule: z.array(z.object({ cron: z.string() })),
      workflow_dispatch: z.unknown(),
    }),
    permissions: z.object({ contents: z.literal("read") }),
    concurrency: z.object({
      "cancel-in-progress": z.string(),
    }),
    jobs: z.object({
      scope: z.object({
        if: z.string(),
        outputs: z.object({
          run: z.string(),
          languages: z.string(),
        }),
        steps: z.array(
          z.object({
            id: z.string().optional(),
            uses: z.string().optional(),
            run: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
      analyze: z.object({
        needs: z.literal("scope"),
        if: z.string(),
        permissions: z.object({
          contents: z.literal("read"),
          "security-events": z.literal("write"),
        }),
        strategy: z.object({
          "max-parallel": z.literal(1),
          matrix: z.object({ language: z.string() }),
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

const matchesPatterns = (path: string, patterns: readonly string[]): boolean =>
  patterns.some(
    (pattern) =>
      path === pattern ||
      path.startsWith(`${pattern}/`) ||
      matchesGlob(path, pattern),
  );

const excluded = (path: string): boolean =>
  matchesPatterns(path, configuration["paths-ignore"]);

const triggerIgnored = (path: string): boolean =>
  matchesPatterns(path, workflowDocument.on.push["paths-ignore"]) ||
  matchesPatterns(path, workflowDocument.on.pull_request["paths-ignore"]);

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
  expect(triggerIgnored(path)).toBe(true);
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
  expect(triggerIgnored(path)).toBe(false);
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
  // Non-prose packaged files remain active triggers on main and pull requests.
  expect(
    manifest.files
      .filter((path) => !path.endsWith(".md"))
      .filter(triggerIgnored),
  ).toEqual([]);
  expect(configuration["threat-models"]).toEqual(["local"]);
  // A narrow allowlist would silently drop new production roots. Explicitly
  // traverse the hidden configuration directory without excluding the root.
  expect(configuration.paths).toContain(".");
  expect(configuration.paths).toContain("docs/.vitepress");
});

it("uses the scope in a bounded workflow gated on administrator activation", () => {
  expect(workflowDocument.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
  expect(workflowDocument.on.push["paths-ignore"]).toEqual(
    workflowDocument.on.pull_request["paths-ignore"],
  );
  expect(workflowDocument.jobs.scope.if).toBe(
    "vars.REA_CODEQL_ADVANCED == 'true'",
  );
  const job = workflowDocument.jobs.analyze;
  expect(job.if).toBe(
    "vars.REA_CODEQL_ADVANCED == 'true' && needs.scope.outputs.run == 'true'",
  );
  expect(job.strategy.matrix.language).toBe(
    "${{ fromJSON(needs.scope.outputs.languages) }}",
  );
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

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);
const selectPr = (files: readonly string[]) =>
  planCodeqlLanguages(
    { event: "pull_request", base: SHA_BASE, head: SHA_HEAD },
    { mergeBase: (base) => base, changedFiles: () => files },
  );

it("selects affected CodeQL languages on pull requests and fails closed on shared or unknown inputs", () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) {
    expect(
      planCodeqlLanguages(
        { event, base: undefined, head: SHA_HEAD },
        {
          mergeBase: () => {
            throw new Error("Non-PR events must not diff");
          },
          changedFiles: () => [],
        },
      ),
    ).toMatchObject({ run: true, languages: CODEQL_LANGUAGES });
  }
  expect(
    selectPr([
      "tests/boundary/filesystem/ciCodeqlScope.test.ts",
      "src/process/ExecFileOutput.test.ts",
      "docs/development/testing.md",
      "bridge/ghidra/ReaGhidraBridge.java",
    ]),
  ).toMatchObject({ run: false, languages: [] });
  expect(
    selectPr(["src/process/ExecFileOutput.ts", "docs/.vitepress/config.ts"]),
  ).toMatchObject({
    run: true,
    languages: ["javascript-typescript"],
  });
  expect(selectPr(["bridge/pwndbg/launch.py"])).toMatchObject({
    run: true,
    languages: ["python"],
  });
  expect(
    selectPr([
      ".github/workflows/release.yml",
      ".github/actions/publish-mcp/action.yml",
    ]),
  ).toMatchObject({
    run: true,
    languages: ["actions"],
  });
  for (const broad of [
    ".github/codeql/production.yml",
    ".github/workflows/codeql.yml",
    "install.sh",
    "scripts/unknown-entrypoint",
  ]) {
    expect(selectPr([broad]), broad).toMatchObject({
      run: true,
      languages: CODEQL_LANGUAGES,
    });
  }
  expect(
    planCodeqlLanguages(
      { event: "pull_request", base: "not-a-sha", head: SHA_HEAD },
      { mergeBase: (base) => base, changedFiles: () => [] },
    ),
  ).toMatchObject({ run: true, languages: CODEQL_LANGUAGES });
});
