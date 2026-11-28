import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { minVersion, subset } from "semver";
import { parse } from "yaml";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  executeWorkflowFixture,
  workflowFixtureEnvironment,
} from "../../support/workflowGit.js";

const workflow = async (filename = "ci.yml") =>
  z
    .object({
      on: z.record(z.string(), z.unknown()),
      jobs: z.record(
        z.string(),
        z
          .object({
            needs: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .passthrough(),
      ),
    })
    .parse(
      parse(
        await readFile(
          new URL(`../../../.github/workflows/${filename}`, import.meta.url),
          "utf8",
        ),
      ),
    );

const scopeFlags = async () =>
  z
    .object({ CI_FLAGS: z.array(z.string()) })
    .parse(
      await import(
        new URL("../../../scripts/ci/scopes.mjs", import.meta.url).href
      ),
    ).CI_FLAGS;

it("opts only the Noble binary-layout toolchain into the Ubuntu Azure archive fallback", async () => {
  const archive = "./.github/actions/ubuntu-archive";
  const input = "noble-azure-fallback";
  const steps = z.array(
    z.object({
      uses: z.string().optional(),
      with: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  const action = async (name: string) =>
    parse(
      await readFile(
        new URL(`../../../.github/actions/${name}/action.yml`, import.meta.url),
        "utf8",
      ),
    );
  const archiveSteps = z
    .object({
      runs: z.object({ steps: z.array(z.object({ run: z.string() })) }),
    })
    .parse(await action("ubuntu-archive")).runs.steps;
  expect(archiveSteps.map(({ run }) => run).join("\n")).toContain(
    "apt-get -o Acquire::Retries=2 -o Acquire::Languages=none --error-on=any update",
  );
  const layout = (await workflow("real-binary-layout.yml")).jobs[
    "real-binary-layout"
  ];
  expect(layout?.["runs-on"]).toBe("ubuntu-24.04");
  expect(layout?.["timeout-minutes"]).toBe(25);
  const toolchain = steps
    .parse(layout?.steps)
    .find((step) => step.uses === "./.github/actions/host-apt-packages");
  expect(toolchain?.with).toMatchObject({ "install-recommends": "false" });
  // Three attempts, each with its kill grace, plus 15 s of backoff must leave
  // the job five minutes to build and verify the fixtures.
  const attemptSeconds = Number(toolchain?.with?.["download-timeout-seconds"]);
  expect(attemptSeconds).toBeGreaterThan(0);
  expect(3 * (attemptSeconds + 5) + 15).toBeLessThanOrEqual(25 * 60 - 300);
  expect(
    steps.parse(layout?.steps).filter((step) => step.uses === archive),
  ).toEqual([{ uses: archive, with: { [input]: "true" } }]);
  expect(
    z
      .object({ runs: z.object({ steps }) })
      .parse(await action("windows-cross-compiler"))
      .runs.steps.filter((step) => step.uses === archive),
  ).toEqual([{ uses: archive }]);
  expect(
    steps
      .parse((await workflow("real-signal-recording.yml")).jobs.sigrok?.steps)
      .filter((step) => step.uses === archive),
  ).toEqual([{ uses: archive }]);
  expect(
    z
      .object({
        inputs: z.record(z.string(), z.object({ default: z.string() })),
      })
      .parse(await action("ubuntu-archive")).inputs[input]?.default,
  ).toBe("false");
});

const recordedCrashRefresh = "refresh --kill-after=5s 150s";
const recordedCrashNobleRefresh = "refresh --kill-after=5s 75s";
const recordedCrashDownload = "download --kill-after=5s 180s";

it.skipIf(process.platform === "win32").each([
  [
    "ok",
    "debian",
    0,
    [recordedCrashRefresh, recordedCrashDownload, "install untimed"],
  ],
  ["refresh", "debian", 100, [recordedCrashRefresh]],
  ["download", "debian", 124, [recordedCrashRefresh, recordedCrashDownload]],
  [
    "noble-fallback",
    "noble",
    0,
    [
      recordedCrashNobleRefresh,
      recordedCrashNobleRefresh,
      recordedCrashDownload,
      "install untimed",
    ],
  ],
  [
    "noble-refresh-fail",
    "noble",
    124,
    [recordedCrashNobleRefresh, recordedCrashNobleRefresh],
  ],
] as const)(
  "recorded-crash APT runs the expected stages and deadlines for the %s outcome",
  async (mode, distro, code, expected) => {
    const root = await createTestTempDirectory("rea-recorded-crash-apt-");
    const osRelease = join(root, "os-release");
    const aptRoot = join(root, "apt");
    const sourcesDir = join(aptRoot, "sources.list.d");
    const ubuntuSources = join(sourcesDir, "ubuntu.sources");
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(
      osRelease,
      distro === "noble"
        ? "ID=ubuntu\nVERSION_CODENAME=noble\n"
        : "ID=debian\nVERSION_CODENAME=trixie\n",
    );
    await writeFile(
      ubuntuSources,
      [
        "Types: deb",
        "URIs: http://archive.ubuntu.com/ubuntu/",
        "Suites: noble noble-updates",
        "Components: main universe",
        "",
        "Types: deb",
        "URIs: http://security.ubuntu.com/ubuntu/",
        "Suites: noble-security",
        "Components: main universe",
        "",
      ].join("\n"),
    );
    const steps = z
      .array(z.object({ run: z.string().optional() }))
      .parse(
        (await workflow("real-recorded-crash.yml")).jobs["real-recorded-crash"]
          ?.steps,
      );
    const provision = steps.find((step) =>
      step.run?.includes("python3-venv gcc libc6-dev strace gdb"),
    )?.run;
    if (!provision) throw new Error("Missing recorded-crash APT step");
    const mock = `
      mode=$1
      REA_OS_RELEASE=$2
      REA_APT_SOURCES_ROOT=$3
      refresh_calls=0
      timeout() {
        local args="$1 $2"
        shift 2
        apt_timeout="$args" "$@"
      }
      record_stage() { printf '%s %s\\n' "$1" "\${apt_timeout:-untimed}"; }
      apt-get() {
        case " $* " in
          *" update "*)
            refresh_calls=$((refresh_calls + 1))
            record_stage refresh
            [[ " $* " == *" Acquire::Languages=none "* ]] || return 98
            [[ " $* " != *" -qq "* ]] || return 99
            if [[ $mode == refresh && " $* " == *" --error-on=any "* ]]; then
              return 100
            fi
            if [[ $mode == noble-fallback && $refresh_calls -eq 1 ]]; then
              return 124
            fi
            if [[ $mode == noble-refresh-fail ]]; then
              return 124
            fi
            ;;
          *" --download-only "*)
            record_stage download
            if [[ $mode == download ]]; then return 124; fi
            ;;
          *" --no-download "*) record_stage install ;;
          *) record_stage unexpected-install ;;
        esac
      }
    `;
    const outcome = await executeWorkflowFixture("bash", [
      "-e",
      "-c",
      mock + provision,
      "fixture",
      mode,
      osRelease,
      aptRoot,
    ])
      .then(({ stdout }) => ({ code: 0, stdout }))
      .catch((cause: unknown) =>
        z.object({ code: z.number(), stdout: z.string() }).parse(cause),
      );
    expect(outcome.code).toBe(code);
    const lines = outcome.stdout.trim().split("\n");
    expect(lines.filter((line) => !line.startsWith("::error::"))).toEqual(
      expected,
    );
    if (mode === "noble-fallback" || mode === "noble-refresh-fail") {
      const rewritten = await readFile(ubuntuSources, "utf8");
      expect(rewritten).toContain(
        "URIs: http://azure.archive.ubuntu.com/ubuntu/",
      );
      expect(rewritten).not.toContain("http://archive.ubuntu.com/ubuntu/");
      expect(rewritten).not.toContain("http://security.ubuntu.com/ubuntu/");
    }
    if (code !== 0)
      expect(lines.at(-1)).toContain(
        mode === "refresh" || mode === "noble-refresh-fail"
          ? "index refresh failed"
          : "package download failed",
      );
  },
);

it("uses bounded APT provisioning before verifying packet captures", async () => {
  const job = (await workflow("real-packet-capture.yml")).jobs.tshark;
  const steps = z
    .array(
      z.object({
        uses: z.string().optional(),
        run: z.string().optional(),
        with: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .parse(job?.steps);
  const archive = steps.findIndex(
    (step) => step.uses === "./.github/actions/ubuntu-archive",
  );
  expect(archive).toBeGreaterThanOrEqual(0);
  expect(steps[archive + 1]).toEqual({
    uses: "./.github/actions/host-apt-packages",
    with: { packages: "tshark util-linux python3" },
  });
  const focused = steps.findIndex(({ run }) =>
    run?.includes("require-provider-tests.mjs packet"),
  );
  const verifier = steps.findIndex(({ run }) =>
    run?.includes("node scripts/verify-packet-capture.mjs"),
  );
  expect(focused).toBeGreaterThan(archive + 1);
  expect(verifier).toBeGreaterThan(focused);
});

it("keeps every SQLite runtime selector inside the published package engine range", async () => {
  const { engines } = z
    .object({ engines: z.object({ node: z.string() }) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../../package.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const { strategy } = z
    .object({
      strategy: z.object({ matrix: z.object({ node: z.array(z.string()) }) }),
    })
    .parse((await workflow("sqlite-runtime.yml")).jobs.sqlite);
  const selectors = strategy.matrix.node;
  const pinned = (
    await readFile(new URL("../../../.nvmrc", import.meta.url), "utf8")
  ).trim();
  expect(selectors).toContain(pinned);
  expect(
    new Set(selectors.map((selector) => minVersion(selector)?.major)),
  ).toEqual(new Set([22, 24, 26]));
  for (const selector of selectors)
    expect(subset(selector, engines.node), selector).toBe(true);
});

it("binds SQLite compatibility jobs to the build's prepared runtime artifact and root layout", async () => {
  expect((await workflow()).jobs["sqlite-runtime"]?.if).toBe(
    "needs.changes.outputs.sqlite == 'true'",
  );
  const steps = z.array(
    z.object({
      uses: z.string().optional(),
      with: z
        .object({ name: z.string().optional(), path: z.string().optional() })
        .optional(),
    }),
  );
  const uploads = steps.parse((await workflow()).jobs.build?.steps).filter(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with?.path
        ?.split(/\r?\n/u)
        .map((path) => path.trim())
        .includes("dist/"),
  );
  expect(uploads).toHaveLength(1);
  const name = z.string().min(1).parse(uploads[0]?.with?.name);
  const downloads = steps
    .parse((await workflow("sqlite-runtime.yml")).jobs.sqlite?.steps)
    .filter((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(downloads).toHaveLength(1);
  expect(downloads[0]?.with).toEqual({ name, path: "." });
});

it("requires each named SQLite compatibility test while retaining both directory suites", async () => {
  const { scripts } = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../../package.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const commands = z
    .string()
    .parse(scripts["test:sqlite:run"])
    .split("&&")
    .map((command) => command.trim().split(/\s+/u));
  const exact = commands.find(
    (command) =>
      command[0] === "node" &&
      command[1] === "scripts/run-exact-tests.mjs" &&
      command[2] === "run",
  );
  expect(exact).toEqual(
    expect.arrayContaining([
      "tests/acceptance/sqliteDatabaseCli.test.ts",
      "tests/boundary/mcp/serverLifecycleMcp.test.ts",
    ]),
  );
  const directories = commands.find(
    (command) => command[0] === "vitest" && command[1] === "run",
  );
  expect(directories).toEqual(
    expect.arrayContaining([
      "src/application/sqlite/",
      "tests/boundary/sqlite/",
    ]),
  );
  const steps = z
    .array(z.object({ run: z.string().optional() }))
    .parse((await workflow("sqlite-runtime.yml")).jobs.sqlite?.steps);
  expect(steps.some((step) => step.run === "npm run test:sqlite:run")).toBe(
    true,
  );
});

it("exports every canonical scope with read authority for admission and keeps telemetry outside the gate", async () => {
  const { jobs } = await workflow();
  const CI_FLAGS = await scopeFlags();
  const outputs = z.record(z.string(), z.string()).parse(jobs.changes?.outputs);
  expect(jobs.changes?.permissions).toEqual({
    contents: "read",
    actions: "read",
  });
  expect(jobs.build?.permissions).toEqual({
    contents: "read",
    actions: "read",
  });
  for (const flag of CI_FLAGS)
    expect(outputs[flag]).toBe(`\${{ steps.plan.outputs.${flag} }}`);
  const steps = z
    .array(
      z.object({
        run: z.string().optional(),
        if: z.string().optional(),
      }),
    )
    .parse(jobs.required?.steps);
  const telemetry = steps.find((step) =>
    step.run?.includes("scripts/ci/job-timings.mjs"),
  );
  expect(telemetry).toBeUndefined();
  const timings = z
    .object({
      on: z.object({
        schedule: z.array(z.object({ cron: z.string() })),
        workflow_dispatch: z.unknown(),
        workflow_run: z.unknown().optional(),
      }),
      permissions: z.record(z.string(), z.string()),
      jobs: z.object({
        report: z.object({
          steps: z.array(
            z.object({
              uses: z.string().optional(),
              run: z.string().optional(),
              with: z.record(z.string(), z.unknown()).optional(),
              env: z.record(z.string(), z.unknown()).optional(),
            }),
          ),
        }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci-timings.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  expect(timings.on.workflow_run).toBeUndefined();
  expect(timings.on.schedule).toHaveLength(1);
  expect(timings.permissions).toEqual({
    contents: "read",
    actions: "read",
    "pull-requests": "read",
  });
  const checkout = timings.jobs.report.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout?.with).toEqual({
    ref: "${{ github.event.repository.default_branch }}",
    "persist-credentials": false,
    "sparse-checkout": ".github/actions/npm-cache\nscripts/ci\n",
  });
  const report = timings.jobs.report.steps.find((step) =>
    step.run?.includes("scripts/ci/job-timings-batch.mjs"),
  );
  expect(report?.env?.CI_REPOSITORY).toBe("${{ github.repository }}");
});

const requiredNeeds = async () => {
  const { jobs } = await workflow();
  return { jobs, needs: z.array(z.string()).parse(jobs.required?.needs) };
};

it("makes the required gate wait for every CI lane, including future additions", async () => {
  const { jobs, needs } = await requiredNeeds();
  expect(new Set(needs)).toEqual(
    new Set(Object.keys(jobs).filter((name) => name !== "required")),
  );
});

it("runs architecture guards for fast code feedback before installing dependencies", async () => {
  const steps = z
    .array(
      z
        .object({
          run: z.string().optional(),
          uses: z.string().optional(),
          if: z.string().optional(),
        })
        .passthrough(),
    )
    .parse((await workflow()).jobs.static?.steps);
  const guard = steps.findIndex(
    (step) => step.run === "node scripts/verify/architecture-guards.mjs",
  );
  const setup = steps.findIndex((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  const install = steps.findIndex((step) => step.run === "npm ci");
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(setup).toBeGreaterThanOrEqual(0);
  expect(install).toBeGreaterThan(guard);
  expect(guard).toBeGreaterThan(setup);
  expect(steps[guard]?.if).toBe("needs.changes.outputs.code == 'true'");
  expect(steps[guard]?.["continue-on-error"]).toBeUndefined();
});

it("holds broad PR shards and native checks behind static validation", async () => {
  const { jobs } = await workflow();
  const earlyJobs = new Set([
    "changes",
    "static",
    "static-deep",
    "python",
    "build",
    "test-shard",
    "test-source",
    "test",
    "docs",
    "required",
  ]);
  for (const [name, job] of Object.entries(jobs)) {
    if (earlyJobs.has(name)) continue;
    expect(job.needs, `${name} must wait for static validation`).toContain(
      "static",
    );
    expect(job.if).not.toMatch(/always\(|cancelled\(/u);
  }
  expect(jobs["test-shard"]?.needs).not.toContain("static");
  const stepRuns = z.array(z.object({ run: z.string().optional() }));
  expect(jobs["static-deep"]?.needs).toBe("changes");
  expect(String(jobs["static-deep"]?.if)).toContain("tier == 'full'");
  expect(String(jobs["static-deep"]?.if)).toContain("code == 'true'");
  const staticRuns = stepRuns.parse(jobs.static?.steps);
  const deepRuns = stepRuns.parse(jobs["static-deep"]?.steps);
  expect(staticRuns.some((step) => step.run === "npm run check:ci:fast")).toBe(
    true,
  );
  expect(
    staticRuns.some(
      (step) =>
        step.run?.startsWith("npm run check:ci:deep") ||
        step.run === "npm run test:python",
    ),
  ).toBe(false);
  expect(
    deepRuns.some((step) => step.run === "npm run check:ci:deep:job"),
  ).toBe(true);
  for (const [name, job] of Object.entries(jobs)) {
    if (
      name === "required" ||
      name === "static-deep" ||
      job.needs === undefined
    )
      continue;
    expect(job.needs, `${name} must not wait for deep static`).not.toContain(
      "static-deep",
    );
  }
});

const trustedRemoteCacheWrite =
  "${{ inputs.remote_cache_write == true || (github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && (github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')) }}";

async function assertProviderCacheCallers(
  jobs: Awaited<ReturnType<typeof workflow>>["jobs"],
  consumers: readonly string[],
) {
  for (const name of consumers) {
    const caller = jobs[name];
    expect(caller?.needs).toContain("build");
    expect(caller?.secrets).toEqual({
      TURBO_TOKEN: "${{ secrets.TURBO_TOKEN }}",
    });
    expect(caller?.with).toEqual({
      build_cache_artifact: "rea-build-cache",
      remote_cache_write: trustedRemoteCacheWrite,
    });
    const path = z.string().parse(caller?.uses);
    const called = z
      .object({
        on: z.object({
          workflow_call: z.object({
            inputs: z.record(z.string(), z.unknown()),
            secrets: z.object({
              TURBO_TOKEN: z.object({ required: z.literal(false) }),
            }),
          }),
          workflow_dispatch: z.unknown(),
        }),
        jobs: z.record(
          z.string(),
          z.object({
            steps: z.array(
              z.object({
                uses: z.string().optional(),
                with: z.record(z.string(), z.unknown()).optional(),
              }),
            ),
          }),
        ),
      })
      .parse(
        parse(
          await readFile(new URL(`../../../${path}`, import.meta.url), "utf8"),
        ),
      );
    expect(called.on.workflow_call.inputs.build_cache_artifact).toMatchObject({
      type: "string",
      default: "",
    });
    expect(called.on.workflow_call.inputs.remote_cache_write).toMatchObject({
      type: "boolean",
      required: false,
      default: false,
    });
    expect(Object.hasOwn(called.on, "workflow_dispatch")).toBe(true);
    for (const job of Object.values(called.jobs))
      expect(
        job.steps.find(
          (step) => step.uses === "./.github/actions/portable-build-cache",
        )?.with,
      ).toEqual({
        build_cache_artifact: "${{ inputs.build_cache_artifact }}",
      });
  }
  for (const name of [
    "sqlite-runtime",
    "nativeaot",
    "android_metadata",
    "website",
  ])
    expect(jobs[name]?.secrets, name).toBeUndefined();
}

it("binds provider build reuse to the current run while keeping standalone dispatches independent", async () => {
  const { jobs } = await workflow();
  const buildSteps = z
    .array(
      z.object({
        run: z.string().optional(),
        uses: z.string().optional(),
        shell: z.string().optional(),
        if: z.string().optional(),
        with: z.record(z.string(), z.unknown()).optional(),
        "continue-on-error": z.boolean().optional(),
      }),
    )
    .parse(jobs.build?.steps);
  const prepare = buildSteps.findIndex(
    (step) => step.run === "npm run test:prepare",
  );
  const stage = buildSteps.findIndex((step) =>
    step.run?.includes("portable-build-cache.mjs snapshot"),
  );
  const upload = buildSteps.findIndex(
    (step) => step.with?.name === "rea-build-cache",
  );
  expect(prepare).toBeGreaterThanOrEqual(0);
  expect(stage).toBeGreaterThan(prepare);
  expect(upload).toBeGreaterThan(stage);
  expect(buildSteps[stage]?.run).toContain(
    "node scripts/ci/portable-build-cache.mjs snapshot .cache/ci-build-plan.json",
  );
  expect(buildSteps[stage]?.if).toBe(
    "needs.changes.outputs.build_cache == 'true'",
  );
  expect(buildSteps[stage]?.shell).toBe("bash");
  expect(buildSteps[stage]?.["continue-on-error"]).not.toBe(true);
  expect(buildSteps[upload]?.if).toBe(buildSteps[stage]?.if);
  expect(buildSteps[upload]?.with).toMatchObject({
    path: ".cache/ci-build-cache/",
    "if-no-files-found": "error",
  });
  const consumers = [
    "browser",
    "binary_layout",
    "evm",
    "apk_signature",
    "javascript_recovery",
    "recorded_crash",
    "web_network",
    "web_runtime",
    "web_source_map",
    "agentenv",
    "packet_capture",
    "signal_recording",
    "go_binary",
    "ghidra_bridge",
  ];
  const { build_cache: cacheOutput } = z
    .object({ build_cache: z.string() })
    .parse(jobs.changes?.outputs);
  const downloadStep = z.object({
    uses: z.string().optional(),
    with: z.object({ name: z.string().optional() }).optional(),
  });
  const cacheConsumers = z
    .array(
      z.object({
        if: z.string().optional(),
        with: z
          .object({ build_cache_artifact: z.string().optional() })
          .optional(),
        steps: z.array(downloadStep).optional(),
      }),
    )
    .parse(Object.values(jobs))
    .filter(
      (job) =>
        job.with?.build_cache_artifact === "rea-build-cache" ||
        job.steps?.some(
          (step) =>
            step.uses?.startsWith("actions/download-artifact@") &&
            step.with?.name === "rea-build-cache",
        ),
    );
  const cacheConditions = cacheConsumers.map((job) =>
    z.string().parse(job.if).replace("needs.changes.", "steps.plan."),
  );
  expect(cacheOutput.startsWith("${{ ") && cacheOutput.endsWith(" }}")).toBe(
    true,
  );
  expect(new Set(cacheOutput.slice(4, -3).split(/\s*\|\|\s*/u))).toEqual(
    new Set(cacheConditions),
  );
  expect(jobs.build?.if).toBe(
    "needs.changes.outputs.code == 'true' || needs.changes.outputs.build_cache == 'true'",
  );
  for (const name of ["test-shard", "test-shard-broad"])
    expect(jobs[name]?.if).toBe(
      `needs.changes.outputs.code == 'true' && needs.changes.outputs.tier != 'warm' && needs.changes.outputs.test_shard_job == '${name}'`,
    );
  expect(jobs["test-shard-broad"]?.steps).toEqual(jobs["test-shard"]?.steps);
  expect(jobs["test-shard-broad"]?.strategy).toEqual(
    jobs["test-shard"]?.strategy,
  );
  await assertProviderCacheCallers(jobs, consumers);
  const action = z
    .object({
      runs: z.object({
        steps: z.array(
          z.object({
            id: z.string().optional(),
            uses: z.string().optional(),
            if: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
            "continue-on-error": z.boolean().optional(),
            run: z.string().optional(),
          }),
        ),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL(
            "../../../.github/actions/portable-build-cache/action.yml",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  const download = action.runs.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  expect(download?.with).toEqual({
    name: "${{ inputs.build_cache_artifact }}",
    path: ".turbo/cache/",
  });
  expect(download?.if).toBe("inputs.build_cache_artifact != ''");
  expect(download?.["continue-on-error"]).not.toBe(true);
  const planRun = action.runs.steps.find((step) => step.id === "plan")?.run;
  expect(planRun).toContain(
    "npm run --silent test:prepare -- --dry=json > .cache/ci-build-plan.json",
  );
  expect(planRun).toContain(
    'node scripts/ci/portable-build-cache.mjs key .cache/ci-build-plan.json >> "$GITHUB_OUTPUT"',
  );
  for (const step of action.runs.steps.filter(
    (step) => step.id === "plan" || step.uses?.startsWith("actions/cache"),
  ))
    expect(step.if).toContain("inputs.build_cache_artifact == ''");
});

it("runs workflow validation inside required static checks when selected", async () => {
  const { jobs } = await workflow();
  const steps = z
    .array(z.object({ run: z.string().optional(), if: z.string().optional() }))
    .parse(jobs.static?.steps);
  const validation = steps.filter((step) => step.run?.includes("actionlint"));
  expect(validation).toHaveLength(1);
  expect(validation[0]?.if).toBe("needs.changes.outputs.workflows == 'true'");
  expect(jobs.workflows).toBeUndefined();
});

it("leaves cancellation ownership with CI so child lanes cannot cancel another tier", async () => {
  const { jobs } = await workflow();
  const children = Object.values(jobs).flatMap((job) =>
    typeof job.uses === "string" && job.uses.startsWith("./.github/workflows/")
      ? [job.uses]
      : [],
  );
  expect(children.length).toBeGreaterThan(0);
  for (const path of children) {
    const child = z
      .object({ concurrency: z.unknown().optional() })
      .parse(
        parse(
          await readFile(new URL(`../../../${path}`, import.meta.url), "utf8"),
        ),
      );
    expect(
      child.concurrency,
      `${path} must use caller scheduling`,
    ).toBeUndefined();
  }
});

it.each([
  ["ci.yml", null],
  ["ci-full-pr.yml", { types: ["labeled"] }],
  ["pr-title.yml", { types: ["opened", "synchronize", "reopened", "edited"] }],
] as const)(
  "admits PRs targeting stack branches in %s",
  async (file, trigger) => {
    const { on } = await workflow(file);
    expect(on.pull_request).toEqual(trigger);
    if (file === "ci.yml") expect(on.push).toEqual({ branches: ["main"] });
  },
);

it("keeps fast feedback separate from complete qualification and release proof", async () => {
  const ci = z
    .object({
      on: z.object({
        push: z.unknown(),
        pull_request: z.unknown(),
        schedule: z.array(z.object({ cron: z.string() })),
        workflow_call: z.object({
          inputs: z.object({
            source_sha: z.object({
              required: z.literal(true),
              type: z.literal("string"),
            }),
            remote_cache_write: z.object({
              required: z.literal(false),
              type: z.literal("boolean"),
              default: z.literal(false),
            }),
          }),
          secrets: z.object({
            TURBO_TOKEN: z.object({ required: z.literal(false) }),
          }),
        }),
      }),
      concurrency: z.object({
        group: z.string(),
        "cancel-in-progress": z.string(),
      }),
      jobs: z.record(
        z.string(),
        z.object({
          if: z.string().optional(),
          steps: z
            .array(
              z.object({
                run: z.string().optional(),
                if: z.string().optional(),
                with: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .optional(),
        }),
      ),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  expect(ci.on.schedule).toEqual([
    { cron: "23 1,5,7,11,13,17,19,23 * * *" },
    { cron: "23 9,15,21 * * *" },
    { cron: "23 3 * * *" },
  ]);
  expect(ci.concurrency.group).toContain("'qualification' || 'feedback'");
  expect(ci.concurrency.group).toContain("inputs.source_sha ||");
  expect(ci.concurrency.group).toContain("github.ref");
  expect(ci.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' && inputs.source_sha == '' && !contains(github.event.pull_request.labels.*.name, 'ci:full') }}",
  );
  // Failed dependencies still reach the gate, but superseded PR runs must
  // release their concurrency slot without waiting for another runner.
  expect(ci.jobs.required?.if).toBe("${{ !cancelled() }}");
  const shards = ci.jobs["test-shard"]?.steps ?? [];
  const fast = shards.find((step) => step.run?.includes("npm run test:built"));
  const full = shards.find((step) => step.run?.includes("test:ci:shard:run"));
  expect(fast?.if).toBe(
    "needs.changes.outputs.tier == 'fast' && needs.changes.outputs.test_mode == 'full'",
  );
  expect(fast?.run).toContain("--reporter=blob");
  expect(fast?.run).not.toContain("--coverage");
  expect(full?.if).toBe("needs.changes.outputs.tier == 'full'");
  const proof = ci.jobs["package-e2e"]?.steps?.find(
    (step) => step.with?.name === "verified-release-package",
  );
  expect(proof?.if).toContain("needs.changes.outputs.tier == 'full'");
  expect(proof?.if).toContain("matrix.platform == 'linux'");
  expect(proof?.if).toContain("matrix.architecture == 'x64'");
});

it.each([
  ["true", "missing", false],
  ["false", "skipped", true],
  ["false", "failure", false],
  ["false", "cancelled", false],
] as const)(
  "enforces the gate for selected=%s and result=%s",
  async (selected, result, passes) => {
    const lane = "sqlite-runtime";
    const { needs } = await requiredNeeds();
    const jobs: Record<
      string,
      { result: string; outputs?: Record<string, string> }
    > = Object.fromEntries(needs.map((name) => [name, { result: "success" }]));
    jobs.changes = {
      result: "success",
      outputs: {
        ...Object.fromEntries(
          (await scopeFlags()).map((flag) => [flag, "false"]),
        ),
        tier: "fast",
        test_mode: "full",
        sqlite: selected,
      },
    };
    if (result === "missing") delete jobs[lane];
    else jobs[lane] = { result };
    const execution = executeWorkflowFixture(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/ci/required.mjs", import.meta.url),
        ),
      ],
      {
        env: { ...workflowFixtureEnvironment(), CI_JOBS: JSON.stringify(jobs) },
      },
    );
    if (passes) await expect(execution).resolves.toMatchObject({ stderr: "" });
    else
      await expect(execution).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(`CI lanes did not pass: ${lane}`),
      });
  },
);

it("rejects incomplete or malformed classification even when available jobs succeeded", async () => {
  const flags = await scopeFlags();
  const valid = {
    ...Object.fromEntries(flags.map((flag) => [flag, "false"])),
    tier: "fast",
    test_mode: "full",
  };
  const run = (outputs: unknown) =>
    executeWorkflowFixture(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/ci/required.mjs", import.meta.url),
        ),
      ],
      {
        env: {
          ...workflowFixtureEnvironment(),
          CI_JOBS: JSON.stringify({
            changes: { result: "success", outputs },
            static: { result: "success" },
            test: { result: "skipped" },
          }),
          CI_QUALIFICATION_DIRECTORY: "",
        },
      },
    );
  await expect(run(valid)).resolves.toMatchObject({ stderr: "" });
  // Metadata is not a scope, even when its string happens to be "true".
  await expect(
    run({ ...valid, qualification_run_id: "true" }),
  ).resolves.toMatchObject({ stderr: "" });
  for (const outputs of [undefined, { ...valid, tier: "unknown" }]) {
    await expect(run(outputs)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("valid tier"),
    });
  }
  for (const flag of flags) {
    await expect(run({ ...valid, [flag]: undefined })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`scope outputs: ${flag}`),
    });
  }
  for (const value of ["", "TRUE", true, null]) {
    await expect(run({ ...valid, sqlite: value })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("scope outputs: sqlite"),
    });
  }
  for (const tier of ["full", "reused"]) {
    await expect(
      run({ ...valid, tier, sqlite: undefined }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("scope outputs: sqlite"),
    });
  }
});

it("fails fast only for ordinary PR matrices and rejects partial portable feedback", async () => {
  const { jobs } = await workflow();
  expect(jobs["test-shard"]?.strategy).toMatchObject({
    "fail-fast":
      "${{ github.event_name == 'pull_request' && needs.changes.outputs.tier == 'fast' }}",
  });
  expect(jobs["package-e2e"]?.strategy).toMatchObject({ "fail-fast": false });
  const flags = await scopeFlags();
  for (const result of ["skipped", "missing"]) {
    // Even an incorrectly successful report merge cannot hide matrix failure.
    const needs: Record<string, unknown> = {
      changes: {
        result: "success",
        outputs: {
          ...Object.fromEntries(flags.map((flag) => [flag, "false"])),
          tier: "fast",
          test_mode: "full",
          code: "true",
        },
      },
      static: { result: "success" },
      build: { result: "success" },
      test: { result: "success" },
      ...(result === "missing" ? {} : { "test-shard": { result } }),
    };
    await expect(
      executeWorkflowFixture(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../../scripts/ci/required.mjs", import.meta.url),
          ),
        ],
        {
          env: {
            ...workflowFixtureEnvironment(),
            CI_JOBS: JSON.stringify(needs),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("test-shard"),
    });
  }
});

it("runs a selected PR subset in planner-owned groups and still gates it", async () => {
  const { jobs } = await workflow();
  expect(jobs.test?.if).toBe(
    "${{ !cancelled() && (needs.changes.result != 'success' || (needs.changes.outputs.code == 'true' && needs.changes.outputs.tier != 'warm')) }}",
  );
  // The planner owns every shard list, including one job per selected group.
  expect(jobs["test-shard"]?.strategy).toMatchObject({
    matrix: { shard: "${{ fromJSON(needs.changes.outputs.test_shards) }}" },
  });
  expect(jobs["test-source"]).toMatchObject({
    if: expect.stringContaining("needs.changes.outputs.test_mode == 'full'"),
  });
  const selected = z
    .array(
      z.object({
        if: z.string().optional(),
        run: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .parse(jobs["test-shard"]?.steps)
    .find(
      (step) => step.if === "needs.changes.outputs.test_mode == 'selected'",
    );
  expect(selected?.run).toBe(
    'node scripts/ci/test-group.mjs selected "${MATRIX_SHARD}" --reporter=default --reporter=blob',
  );
  expect(selected?.env).toEqual({
    MATRIX_SHARD: "${{ matrix.shard }}",
    CI_TEST_SELECTION: "${{ needs.changes.outputs.test_selection }}",
    REA_CI_TEST_HISTORY: ".cache/ci-test-history/test-results.json",
  });

  const flags = await scopeFlags();
  const gate = (
    outputs: Record<string, unknown>,
    results: Record<string, string>,
    event = "pull_request",
  ) =>
    executeWorkflowFixture(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/ci/required.mjs", import.meta.url),
        ),
      ],
      {
        env: {
          ...workflowFixtureEnvironment(),
          GITHUB_EVENT_NAME: event,
          CI_QUALIFICATION_DIRECTORY: "",
          CI_JOBS: JSON.stringify({
            changes: {
              result: "success",
              outputs: {
                ...Object.fromEntries(flags.map((flag) => [flag, "false"])),
                tier: "fast",
                code: "true",
                test_mode: "selected",
                ...outputs,
              },
            },
            static: { result: "success" },
            test: { result: "success" },
            ...Object.fromEntries(
              Object.entries(results).map(([name, result]) => [
                name,
                { result },
              ]),
            ),
          }),
        },
      },
    );
  const ran = { build: "success", "test-shard": "success" };
  // A selected subset skips the separate source job.
  await expect(gate({}, ran)).resolves.toMatchObject({ stderr: "" });
  for (const name of ["test-shard", "build", "test"])
    await expect(gate({}, { ...ran, [name]: "skipped" })).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining(name),
      },
    );
  const broad = { ...ran, "test-source": "success", "test-shard": "skipped" };
  await expect(
    gate({ test_mode: "full" }, { ...broad, "test-shard-broad": "success" }),
  ).resolves.toMatchObject({ stderr: "" });
  await expect(
    gate({ test_mode: "full" }, { ...broad, "test-shard": "success" }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("test-shard-broad"),
  });
  // The complete fast suite still requires its source job.
  await expect(gate({ test_mode: "full" }, ran)).rejects.toMatchObject({
    stderr: expect.stringContaining("test-source"),
  });
  // Only a fast pull-request plan with code changes may select tests.
  for (const [outputs, event] of [
    [{ test_mode: undefined }, "pull_request"],
    [{ test_mode: "candidate" }, "pull_request"],
    [{}, "push"],
    [{ code: "false" }, "pull_request"],
  ] as const)
    await expect(gate(outputs, ran, event)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("valid test mode"),
    });
});

it("binds each canonical lane to its explicit fast and full workflow jobs", async () => {
  const { jobs, needs } = await requiredNeeds();
  const { CI_LANES } = await import(
    new URL("../../../scripts/ci/scopes.mjs", import.meta.url).href
  );
  // Independent contract: adding or changing a lane requires a workflow and
  // gate decision, rather than silently assuming that its job has the same name.
  const expected: Record<string, { fast: string[]; full: string[] }> = {
    code: {
      fast: ["build", "test-shard", "test-source", "test"],
      full: ["build", "test-shard", "test"],
    },
    runtime: {
      fast: ["windows-native-build", "package-e2e"],
      full: ["windows-native-build", "package-e2e"],
    },
    package: { fast: ["windows-curated"], full: ["windows-curated"] },
    apple: { fast: ["apple-artifacts"], full: ["apple-artifacts"] },
    fixtures: {
      fast: ["conformance-fixtures"],
      full: ["conformance-fixtures"],
    },
    readiness: {
      fast: ["reconstruction-readiness"],
      full: ["reconstruction-readiness"],
    },
    docs: { fast: ["docs"], full: ["docs"] },
    workflows: { fast: ["static"], full: ["static"] },
    python: { fast: ["python"], full: ["static-deep"] },
    reverse_tools: {
      fast: ["reverse-tools-quality"],
      full: ["reverse-tools-quality"],
    },
    sqlite: { fast: ["sqlite-runtime"], full: ["sqlite-runtime"] },
    ...Object.fromEntries(
      [
        "packet_capture",
        "signal_recording",
        "browser",
        "binary_layout",
        "evm",
        "apk_signature",
        "javascript_recovery",
        "recorded_crash",
        "web_network",
        "web_runtime",
        "web_source_map",
        "agentenv",
        "go_binary",
        "nativeaot",
        "ghidra_bridge",
        "android_metadata",
        "website",
      ].map((name) => [name, { fast: [name], full: [name] }]),
    ),
  };
  expect(Object.keys(CI_LANES).sort()).toEqual(Object.keys(expected).sort());
  for (const [scope, required] of Object.entries(expected)) {
    expect(CI_LANES[scope].required, scope).toEqual(required);
    for (const name of new Set([...required.fast, ...required.full])) {
      expect(needs, `${scope}: ${name}`).toContain(name);
      expect(jobs[name], `${scope}: ${name}`).toBeDefined();
      // Static and deep-static are shared gates; other mapped jobs are admitted
      // by their scope output in the workflow itself.
      if (name !== "static" && name !== "static-deep")
        expect(String(jobs[name]?.if), `${scope}: ${name}`).toContain(
          `needs.changes.outputs.${scope}`,
        );
    }
  }

  const executeGate = (context: Record<string, unknown>) =>
    executeWorkflowFixture(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/ci/required.mjs", import.meta.url),
        ),
      ],
      {
        env: {
          ...workflowFixtureEnvironment(),
          GITHUB_EVENT_NAME: "push",
          CI_JOBS: JSON.stringify(context),
          CI_QUALIFICATION_DIRECTORY: "",
        },
      },
    );
  const flags = Object.keys(expected);
  for (const [scope, required] of Object.entries(expected)) {
    const context: Record<string, unknown> = Object.fromEntries(
      needs.map((name) => [name, { result: "skipped" }]),
    );
    context.changes = {
      result: "success",
      outputs: {
        ...Object.fromEntries(flags.map((name) => [name, "false"])),
        tier: "fast",
        test_mode: "full",
        [scope]: "true",
      },
    };
    context.static = { result: "success" };
    for (const name of required.fast) context[name] = { result: "success" };
    await expect(executeGate(context), scope).resolves.toMatchObject({
      stderr: "",
    });
    for (const name of required.fast) {
      await expect(
        executeGate({ ...context, [name]: { result: "skipped" } }),
        `${scope}: ${name}`,
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(name),
      });
    }
  }
  const fullContext: Record<string, unknown> = Object.fromEntries(
    needs.map((name) => [name, { result: "success" }]),
  );
  fullContext.changes = {
    result: "success",
    outputs: {
      ...Object.fromEntries(flags.map((name) => [name, "true"])),
      tier: "full",
      test_mode: "full",
    },
  };
  await expect(executeGate(fullContext)).resolves.toMatchObject({ stderr: "" });
  for (const name of new Set(
    Object.values(expected).flatMap(({ full }) => full),
  )) {
    await expect(
      executeGate({ ...fullContext, [name]: { result: "skipped" } }),
      name,
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(name) });
  }
});

it("requires every client schema engine in the build job of every code change", async () => {
  const steps = z
    .array(
      z
        .object({
          if: z.string().optional(),
          run: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          "continue-on-error": z.unknown().optional(),
        })
        .passthrough(),
    )
    .parse((await workflow()).jobs.build?.steps);
  const checks = steps.filter((step) =>
    step.run?.includes("node scripts/verify-advertised-schemas.mjs"),
  );
  expect(checks).toHaveLength(1);
  const [check] = checks;
  expect(check?.if).toBe("needs.changes.outputs.code == 'true'");
  expect(check?.["continue-on-error"]).toBeUndefined();
  expect(check?.env?.REA_REQUIRE_SCHEMA_ENGINES).toBe("1");
  // Full qualification adds the Python jsonschema meta-validation.
  expect(check?.env?.SCHEMA_CHECK_OPTIONS).toBe(
    "${{ needs.changes.outputs.tier == 'full' && '--complete' || '' }}",
  );
  expect(check?.run).toContain("$SCHEMA_CHECK_OPTIONS");
});

it.skipIf(process.platform === "win32").each([
  ["true", "180", ["0"]],
  ["false", "120", ["0"]],
  // A slow download resumes from APT's cache on the next bounded attempt.
  ["false", "120", ["124", "0"]],
  ["false", "120", ["124", "100", "124"]],
] as const)(
  "downloads hosted packages within the selected per-attempt deadline and keeps cached install outside it (%s, %s, %j)",
  async (recommends, seconds, statuses) => {
    const { run } = z
      .object({
        runs: z.object({ steps: z.tuple([z.object({ run: z.string() })]) }),
      })
      .parse(
        parse(
          await readFile(
            new URL(
              "../../../.github/actions/host-apt-packages/action.yml",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      ).runs.steps[0];
    const result = await executeWorkflowFixture("bash", [
      "-e",
      "-c",
      `
        REA_APT_INSTALL_RECOMMENDS=$1
        REA_APT_DOWNLOAD_TIMEOUT=$2
        REA_APT_PACKAGES="package-one package-two"
        read -r -a fixture_statuses <<< "$3"
        fixture_attempt=0
        sudo() {
          printf '%s\n' "$*"
          if [[ $1 == timeout ]]; then
            fixture_attempt=$((fixture_attempt + 1))
            return "\${fixture_statuses[fixture_attempt - 1]}"
          fi
        }
        sleep() { :; }
      ` +
        "\n" +
        run,
      "fixture",
      recommends,
      seconds,
      statuses.join(" "),
    ]).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (cause: unknown) =>
        z.object({ code: z.number(), stdout: z.string() }).parse(cause),
    );
    const install = `install --yes${recommends === "false" ? " --no-install-recommends" : ""} -- package-one package-two`;
    const commands = result.stdout
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("::error::"));
    const last = statuses.at(-1)!;
    expect(result.code).toBe(Number(last));
    expect(commands).toEqual([
      ...statuses.map(
        () =>
          `timeout --kill-after=5s ${seconds}s apt-get -o Acquire::Retries=2 --download-only ${install}`,
      ),
      ...(last === "0"
        ? [`DEBIAN_FRONTEND=noninteractive apt-get --no-download ${install}`]
        : []),
    ]);
    if (last !== "0")
      expect(result.stdout).toContain(
        `failed after three bounded attempts (last exit ${last})`,
      );
  },
);

it("wires changed-file typed lint into fast Static checks", async () => {
  const ci = await workflow();
  const changesOutputs = z
    .object({ outputs: z.record(z.string(), z.string()) })
    .parse(ci.jobs.changes).outputs;
  expect(changesOutputs.typed_lint_files).toBe(
    "${{ steps.plan.outputs.typed_lint_files }}",
  );
  const staticSteps = z
    .array(
      z
        .object({
          name: z.string().optional(),
          if: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          run: z.string().optional(),
        })
        .passthrough(),
    )
    .parse(z.object({ steps: z.unknown() }).parse(ci.jobs.static).steps);
  const typedLintStep = staticSteps.find(
    (step) => step.name === "Run typed lint on changed files",
  );
  expect(typedLintStep).toMatchObject({
    env: {
      CI_TYPED_LINT_FILES: "${{ needs.changes.outputs.typed_lint_files }}",
    },
    run: "node scripts/ci/static-check-report.mjs typed-lint-changed",
  });
  expect(typedLintStep?.if).toContain("needs.changes.outputs.tier == 'fast'");
  expect(typedLintStep?.if).toContain("needs.changes.outputs.code == 'true'");
  expect(typedLintStep?.if).toContain(
    "needs.changes.outputs.typed_lint_files != '[]'",
  );
});
