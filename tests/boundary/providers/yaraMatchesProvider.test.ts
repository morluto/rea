import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { createYaraMatchesService } from "../../../src/composition/yara.js";
import { yaraMatchesSchema } from "../../../src/domain/yara/yaraMatches.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import type { YaraLauncher } from "../../../src/yara/YaraMatchesProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  interpreterLauncher,
  writeYaraStub,
  YARA_STUB_RULE as RULE,
  YARA_STUB_SAMPLE as SAMPLE,
  yaraStubService as stubService,
} from "../../fixtures/yara/yaraStub.js";
import { expectProviderLaunchCleanup } from "../../support/process/expectProviderLaunchCleanup.js";

const it = test.skipIf(process.platform === "win32");

const stubPid = async (args: string): Promise<number> => {
  for (;;) {
    try {
      return Number(await readFile(`${args}.pid`, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

/** A rule file under a directory whose name holds a colon, as `a:b`. */
const colonRule = async (root: string, name: string): Promise<string> => {
  const directory = join(root, `rea-yara-ns:rea-yara-split-${randomUUID()}`);
  await mkdir(directory);
  const rule = join(directory, "rule.yar");
  await writeFile(rule, `rule ${name} { condition: true }\n`);
  return rule;
};

const fixture = async (mode: string) => {
  const root = await createTestTempDirectory("rea-yara-provider-");
  const command = await writeYaraStub(root);
  const sample = join(root, "sample.bin");
  await writeFile(sample, SAMPLE);
  const rule = join(root, "packers.yar");
  await writeFile(rule, RULE);
  const args = join(root, "args.json");
  const service = stubService(command, {
    ...process.env,
    YARA_STUB_MODE: mode,
    YARA_STUB_ARGS: args,
  });
  return { root, command, sample, rule, args, service };
};

describe("inspect_yara_matches with a yara stand-in", () => {
  it("binds matches to the file and rule digests and passes argv without a shell", async () => {
    const { sample, rule, args, service } = await fixture("match");
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const report = yaraMatchesSchema.parse(result.value.normalized_result);
    expect(JSON.parse(await readFile(args, "utf8"))).toEqual({
      args: ["-s", "-L", "-m", "-g", "-q", `rea:${rule}`, sample],
      cwd: parse(sample).root,
    });
    expect(report.artifact).toEqual({
      path: sample,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      bytes: SAMPLE.length,
    });
    expect(report.rule_files).toEqual([
      {
        path: rule,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        bytes: Buffer.byteLength(RULE),
      },
    ]);
    expect(report.matches).toEqual([
      {
        rule: "Packed",
        tags: ["packer", "upx"],
        meta: [
          { identifier: "author", type: "string", value: "Analyst" },
          { identifier: "score", type: "integer", value: 7 },
        ],
        string_match_count: 2,
        strings: [
          {
            identifier: "$mz",
            file_offset: 0,
            length: 4,
            data: "MZ\\x90\\x00",
          },
          { identifier: "$upx", file_offset: 16, length: 3, data: "UPX" },
        ],
      },
      { rule: "Plain", tags: [], meta: [], string_match_count: 0, strings: [] },
    ]);
    expect(report.coverage).toEqual({
      status: "complete",
      matched_rules: 2,
      string_matches: 2,
      listed_string_matches: 2,
    });
    expect(report.warnings).toEqual([
      expect.stringContaining('string "$a" may slow down scanning'),
    ]);
    expect(report.limits).toEqual({
      max_matches: { value: 256, source: "default" },
      max_output_bytes: { value: 64 * 1024 * 1024, source: "default" },
      command_timeout_ms: { value: 60_000, source: "default" },
      max_file_bytes: 2 * 1024 * 1024 * 1024,
    });
    expect(result.value.subject).toMatchObject({
      local_path: sample,
      identity: { sha256: report.artifact.sha256 },
    });
    expect(result.value.locations).toEqual([
      { kind: "artifact-path", path: sample },
      { kind: "artifact-path", path: rule },
    ]);
    expect(result.value.provider.id).toBe("yara.command");
  });

  it("passes fast_scan as -f", async () => {
    const { sample, rule, args, service } = await fixture("match");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule],
      fast_scan: true,
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(await readFile(args, "utf8")).args).toContain("-f");
    if (result.ok)
      expect(result.value.limitations).toContainEqual(
        expect.stringContaining("lower bounds"),
      );
  });

  it("lists up to max_matches and keeps the counts", async () => {
    const { sample, rule, service } = await fixture("many");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule],
      max_matches: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = yaraMatchesSchema.parse(result.value.normalized_result);
    expect(report.coverage).toEqual({
      status: "partial",
      matched_rules: 1,
      string_matches: 50,
      listed_string_matches: 10,
    });
    expect(report.matches[0]?.string_match_count).toBe(50);
    expect(report.matches[0]?.strings).toHaveLength(10);
    expect(report.limits.max_matches).toEqual({ value: 10, source: "request" });
    expect(report.limitations).toContainEqual(
      expect.stringContaining("40 of 50 string matches"),
    );
  });

  it("uses the launch seed when the call omits a control", async () => {
    const root = await fixture("many");
    const service = stubService(root.command, {
      ...process.env,
      YARA_STUB_MODE: "many",
      REA_YARA_MAX_MATCHES: "5",
    });
    const result = await service.inspect({
      path: root.sample,
      rule_paths: [root.rule],
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        yaraMatchesSchema.parse(result.value.normalized_result).limits
          .max_matches,
      ).toEqual({ value: 5, source: "setting" });
  });

  it("refuses an invalid launch seed instead of using the default", async () => {
    const root = await fixture("many");
    const service = stubService(root.command, {
      ...process.env,
      REA_YARA_MAX_MATCHES: "0",
    });
    const result = await service.inspect({
      path: root.sample,
      rule_paths: [root.rule],
    });
    expect(!result.ok && result.error._tag).toBe("ConfigurationError");
  });

  it("returns a rule compile error as an input error naming the rule file", async () => {
    const { sample, rule, service } = await fixture("compile");
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      conformsToInputContract: true,
      issues: [
        {
          path: ["rule_paths", 0],
          reason: "invalid_value",
          message: `${rule}(3): rule "Bad": undefined identifier "nope"`,
        },
      ],
      remediationAction: expect.stringContaining("Fix the reported rule"),
    });
  });

  it("does not report a scan error as a rule error", async () => {
    const { sample, rule, service } = await fixture("scan-error");
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).not.toBe("AnalysisInputError");
  });

  it("refuses stdout that is not yara match output", async () => {
    const { sample, rule, service } = await fixture("garbage");
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(!result.ok && result.error._tag).toBe("AnalysisOutputError");
  });

  it("stops output beyond max_output_bytes with the setting as its limit", async () => {
    const { sample, rule, service } = await fixture("flood");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule],
      max_output_bytes: 4096,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      limit: expect.objectContaining({
        setting: "yara.max_output_bytes",
        effective_value: 4096,
      }),
    });
  });

  it("stops a scan at command_timeout_ms", async () => {
    const { sample, rule, args, service } = await fixture("hang");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule],
      command_timeout_ms: 300,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisTimeoutError",
      limit: expect.objectContaining({
        setting: "yara.command_timeout_ms",
        effective_value: 300,
      }),
    });
    expect(result.error.cleanupIncomplete).toBe(false);
    await expectProviderLaunchCleanup([
      { pid: await stubPid(args), cwd: undefined },
    ]);
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("cancels a running scan and leaves nothing to clean up", async () => {
    const { sample, rule, args, service } = await fixture("hang");
    const controller = new AbortController();
    const pending = service.inspect(
      { path: sample, rule_paths: [rule] },
      { signal: controller.signal },
    );
    const pid = await stubPid(args);
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cleanupIncomplete).toBe(false);
    await expectProviderLaunchCleanup([{ pid, cwd: undefined }]);
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("retains a failed process cleanup and retries it before the next scan", async () => {
    const { command, sample, rule, args } = await fixture("hang");
    let attempts = 0;
    const launcher: YaraLauncher = async (spawn) => {
      const launched = await interpreterLauncher(spawn);
      const cleanup =
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership));
      return {
        ...launched,
        cleanup: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("injected cleanup failure");
          return cleanup();
        },
      };
    };
    const service = stubService(
      command,
      { ...process.env, YARA_STUB_MODE: "hang", YARA_STUB_ARGS: args },
      launcher,
    );
    const first = await service.inspect({
      path: sample,
      rule_paths: [rule],
      command_timeout_ms: 300,
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.cleanupIncomplete).toBe(true);
    const pid = await stubPid(args);
    const second = await service.inspect({
      path: sample,
      rule_paths: [rule],
      command_timeout_ms: 300,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error._tag).toBe("AnalysisTimeoutError");
    expect(second.error.cleanupIncomplete).toBe(false);
    await expectProviderLaunchCleanup([{ pid, cwd: undefined }]);
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("compiles the hashed rule path even when it contains a colon", async () => {
    const { root, command, sample, args } = await fixture("resolve");
    const rule = await colonRule(root, "ColonRule");
    const service = stubService(command, {
      ...process.env,
      YARA_STUB_MODE: "resolve",
      YARA_STUB_ARGS: args,
    });
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const report = yaraMatchesSchema.parse(result.value.normalized_result);
    expect(report.matches.map((match) => match.rule)).toEqual(["ColonRule"]);
    expect(report.rule_files.map((file) => file.path)).toEqual([rule]);
  });

  it("never compiles another file when a colon rule path is replaced after hashing", async () => {
    const { root, command, sample, args } = await fixture("resolve");
    const rule = await colonRule(root, "HashedRule");
    const planted: string[] = [];
    // Between hashing and launch the selected file disappears and a file
    // appears where yara's NAMESPACE:FILE split of a bare path would point.
    const launcher: YaraLauncher = async (spawn) => {
      await rm(rule);
      const split = rule.slice(rule.indexOf(":") + 1);
      const decoy = resolve(spawn.cwd ?? process.cwd(), split);
      try {
        await mkdir(dirname(decoy));
        planted.push(dirname(decoy));
        await writeFile(decoy, "rule DecoyRule { condition: true }\n");
      } catch {
        // A working directory REA chose may not be writable; nothing to plant.
      }
      return interpreterLauncher(spawn);
    };
    const service = stubService(
      command,
      { ...process.env, YARA_STUB_MODE: "resolve", YARA_STUB_ARGS: args },
      launcher,
    );
    try {
      const result = await service.inspect({
        path: sample,
        rule_paths: [rule],
      });
      expect(result.ok, JSON.stringify(result)).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [
          {
            path: ["rule_paths", 0],
            message: `${rule}: could not open file`,
          },
        ],
      });
    } finally {
      await Promise.all(
        planted.map((path) => rm(path, { recursive: true, force: true })),
      );
    }
  });

  it("reports a missing yara command as unavailable with remediation", async () => {
    const { root, sample, rule } = await fixture("match");
    const service = createYaraMatchesService({
      ...process.env,
      REA_YARA_COMMAND: join(root, "missing-yara"),
    });
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(result.error.userMessage).toContain("REA_YARA_COMMAND");
  });

  it("reports yara missing from PATH as unavailable", async () => {
    const { root, sample, rule } = await fixture("match");
    const service = createYaraMatchesService({ PATH: root });
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(!result.ok && result.error._tag).toBe(
      "AnalysisCapabilityUnavailableError",
    );
  });

  it("refuses a missing rule file before launching yara", async () => {
    const { root, sample, args, service } = await fixture("match");
    const missing = join(root, "missing.yar");
    const result = await service.inspect({
      path: sample,
      rule_paths: [missing],
    });
    expect(result.ok).toBe(false);
    await expect(readFile(args)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a scanned file larger than max_file_bytes", async () => {
    const { sample, rule, service } = await fixture("match");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule],
      max_file_bytes: 8,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      limit: expect.objectContaining({ parameter: "max_file_bytes" }),
    });
  });

  it("refuses matches when the scanned file changes during the scan", async () => {
    const { sample, rule, service } = await fixture("mutate");
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(!result.ok && result.error._tag).toBe(
      "AnalysisArtifactChangedError",
    );
  });

  it("refuses matches when a rule file is edited in place during the scan", async () => {
    const { root, sample, rule, service } = await fixture("mutate-rule");
    const second = join(root, "second.yar");
    await writeFile(second, "rule Second { condition: true }\n");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule, second],
    });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisArtifactChangedError",
      path: second,
    });
  });

  it("refuses paths containing line breaks", async () => {
    const { root, rule, service } = await fixture("match");
    const result = await service.inspect({
      path: join(root, "two\nlines.bin"),
      rule_paths: [rule],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["path"] })],
    });
  });
});
