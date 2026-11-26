import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createYaraMatchesService } from "../../../src/composition/yara.js";
import { YaraMatchesService } from "../../../src/application/yara/YaraMatchesService.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ok } from "../../../src/domain/result.js";
import {
  YARA_SETTING_BOUNDS,
  yaraMatchesSchema,
} from "../../../src/domain/yara/yaraMatches.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import {
  YaraMatchesProvider,
  type YaraLauncher,
} from "../../../src/yara/YaraMatchesProvider.js";
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
    const recorded = JSON.parse(await readFile(args, "utf8")) as {
      args: string[];
      cwd: string;
    };
    expect(recorded.args.slice(0, 5)).toEqual(["-s", "-L", "-m", "-g", "-q"]);
    const snapshotRuleArg = recorded.args[5]!;
    const snapshotTarget = recorded.args[6]!;
    expect(snapshotRuleArg).toMatch(/^rea:.+rule-0\.yar$/u);
    expect(snapshotRuleArg).not.toBe(`rea:${rule}`);
    expect(snapshotTarget).not.toBe(sample);
    expect(recorded.cwd).toBe(parse(snapshotTarget).root);
    // The owned snapshot directory is removed before inspect returns.
    await expect(stat(dirname(snapshotTarget))).rejects.toMatchObject({
      code: "ENOENT",
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
      // Because yara compiles the owned snapshot bound to the hashed digest,
      // deleting the original rule path and planting a decoy after hashing
      // still compiles HashedRule and never DecoyRule.
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const report = yaraMatchesSchema.parse(result.value.normalized_result);
      expect(report.matches.map((match) => match.rule)).toEqual(["HashedRule"]);
      expect(report.rule_files.map((file) => file.path)).toEqual([rule]);
    } finally {
      await Promise.all(
        planted.map((path) => rm(path, { recursive: true, force: true })),
      );
    }
  });

  it("scans the owned snapshot even when a parent directory is swapped before yara opens the file", async () => {
    const { root, command, args } = await fixture("resolve");
    const liveDir = join(root, "live");
    const decoyDir = join(root, "decoy");
    const backupDir = join(root, "backup");
    await mkdir(liveDir);
    await mkdir(decoyDir);
    const liveSample = join(liveDir, "sample.bin");
    const liveRule = join(liveDir, "rules.yar");
    await writeFile(liveSample, SAMPLE);
    await writeFile(liveRule, "rule HashedRule { condition: true }\n");
    await writeFile(join(decoyDir, "sample.bin"), "DECOY BYTES");
    await writeFile(
      join(decoyDir, "rules.yar"),
      "rule SwappedRule { condition: true }\n",
    );
    let swapped = false;
    const launcher: YaraLauncher = async (spawn) => {
      // Simulate a POSIX parent-directory rename TOCTOU between hashing and
      // yara opening the paths; restore the directory in finally below.
      await rename(liveDir, backupDir);
      await rename(decoyDir, liveDir);
      swapped = true;
      return interpreterLauncher(spawn);
    };
    const service = stubService(
      command,
      { ...process.env, YARA_STUB_MODE: "resolve", YARA_STUB_ARGS: args },
      launcher,
    );
    try {
      const result = await service.inspect({
        path: liveSample,
        rule_paths: [liveRule],
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const report = yaraMatchesSchema.parse(result.value.normalized_result);
      expect(report.matches.map((match) => match.rule)).toEqual(["HashedRule"]);
      expect(report.artifact).toEqual({
        path: liveSample,
        sha256: createHash("sha256").update(SAMPLE).digest("hex"),
        bytes: SAMPLE.length,
      });
      expect(report.rule_files).toEqual([
        {
          path: liveRule,
          sha256: createHash("sha256")
            .update("rule HashedRule { condition: true }\n")
            .digest("hex"),
          bytes: Buffer.byteLength("rule HashedRule { condition: true }\n"),
        },
      ]);
    } finally {
      if (swapped) {
        await rename(liveDir, decoyDir);
        await rename(backupDir, liveDir);
      }
    }
  });

  it("preserves relative include lookup when staging rule files", async () => {
    const { root, command, sample, args } = await fixture("resolve");
    const rulesDir = join(root, "rules");
    await mkdir(rulesDir);
    const common = join(rulesDir, "common.yar");
    await writeFile(common, "rule CommonRule { condition: true }\n");
    const mainRuleText =
      'include "common.yar"\nrule MainRule { condition: true }\n';
    const mainRule = join(rulesDir, "main.yar");
    await writeFile(mainRule, mainRuleText);
    const service = stubService(command, {
      ...process.env,
      YARA_STUB_MODE: "resolve",
      YARA_STUB_ARGS: args,
    });
    const result = await service.inspect({
      path: sample,
      rule_paths: [mainRule],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const report = yaraMatchesSchema.parse(result.value.normalized_result);
    expect(report.matches.map((match) => match.rule)).toEqual([
      "CommonRule",
      "MainRule",
    ]);
    // The reported rule digest and byte length remain bound to the original rule file.
    expect(report.rule_files).toEqual([
      {
        path: mainRule,
        sha256: createHash("sha256").update(mainRuleText).digest("hex"),
        bytes: Buffer.byteLength(mainRuleText),
      },
    ]);
  });

  it("retains completed Evidence and retries failed snapshot directory cleanup before the next scan", async () => {
    const { command, sample, rule } = await fixture("match");
    let firstRootPath: string | undefined;
    let firstCloseAttempts = 0;
    const provider = new YaraMatchesProvider({
      environment: { ...process.env, YARA_STUB_MODE: "match" },
      selectCommand: () => ok(command),
      launcher: interpreterLauncher,
      createRuntime: async () => {
        const real = await PrivateRuntimeRoot.create({ prefix: "rea-yara-" });
        if (firstRootPath !== undefined) return real;
        firstRootPath = real.path;
        return {
          path: real.path,
          close: async () => {
            firstCloseAttempts += 1;
            if (firstCloseAttempts === 1)
              throw new Error("injected snapshot root cleanup failure");
            return real.close();
          },
        };
      },
    });
    const service = new YaraMatchesService(provider, process.env);
    const first = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.cleanupIncomplete).toBe(true);
    expect(firstRootPath).toBeDefined();
    // Completed matches survive failed snapshot cleanup as full Evidence.
    const partialEvidence = first.error.partialObservation as {
      normalized_result?: unknown;
      operation?: string;
    };
    expect(partialEvidence?.operation).toBe("inspect_yara_matches");
    const retainedReport = yaraMatchesSchema.parse(
      partialEvidence?.normalized_result,
    );
    expect(retainedReport.matches.map((match) => match.rule)).toEqual([
      "Packed",
      "Plain",
    ]);
    // Second scan retries removing the retained snapshot root before proceeding.
    const second = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(firstCloseAttempts).toBe(2);
    expect(first.error.cleanupIncomplete).toBe(false);
    await expect(stat(firstRootPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(service.close()).resolves.toBeUndefined();
  });

  it("retains completed Evidence when cancelled during snapshot directory removal", async () => {
    const { command, sample, rule } = await fixture("match");
    const controller = new AbortController();
    const provider = new YaraMatchesProvider({
      environment: { ...process.env, YARA_STUB_MODE: "match" },
      selectCommand: () => ok(command),
      launcher: interpreterLauncher,
      createRuntime: async () => {
        const real = await PrivateRuntimeRoot.create({ prefix: "rea-yara-" });
        return {
          path: real.path,
          close: async () => {
            controller.abort("cancelled during cleanup");
            return real.close();
          },
        };
      },
    });
    const service = new YaraMatchesService(provider, process.env);
    const result = await service.inspect(
      { path: sample, rule_paths: [rule] },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cleanupIncomplete).toBe(false);
    const partialEvidence = result.error.partialObservation as {
      normalized_result?: unknown;
      operation?: string;
    };
    expect(partialEvidence?.operation).toBe("inspect_yara_matches");
    const retainedReport = yaraMatchesSchema.parse(
      partialEvidence?.normalized_result,
    );
    expect(retainedReport.matches.map((match) => match.rule)).toEqual([
      "Packed",
      "Plain",
    ]);
  });

  it("retains completed Evidence when yara process cleanup fails and retries cleanup on close", async () => {
    const { command, sample, rule } = await fixture("match");
    let cleanupAttempts = 0;
    const launcher: YaraLauncher = async (spawn) => {
      const launched = await interpreterLauncher(spawn);
      return {
        ...launched,
        cleanup: async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) {
            return {
              cleaned: false,
              reason: "injected yara process cleanup failure",
            };
          }
          return cleanupOwnedProcessGroup(launched.ownership);
        },
      };
    };
    const service = stubService(
      command,
      { ...process.env, YARA_STUB_MODE: "match" },
      launcher,
    );
    const first = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.cleanupIncomplete).toBe(true);
    const partialEvidence = first.error.partialObservation as {
      normalized_result?: unknown;
      operation?: string;
    };
    expect(partialEvidence?.operation).toBe("inspect_yara_matches");
    const retainedReport = yaraMatchesSchema.parse(
      partialEvidence?.normalized_result,
    );
    expect(retainedReport.matches.map((match) => match.rule)).toEqual([
      "Packed",
      "Plain",
    ]);
    await expect(service.close()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
    expect(first.error.cleanupIncomplete).toBe(false);
  });

  it("retains completed Evidence when cancelled during yara process cleanup", async () => {
    const { command, sample, rule } = await fixture("match");
    const controller = new AbortController();
    const launcher: YaraLauncher = async (spawn) => {
      const launched = await interpreterLauncher(spawn);
      return {
        ...launched,
        cleanup: async () => {
          controller.abort("cancelled during process cleanup");
          return cleanupOwnedProcessGroup(launched.ownership);
        },
      };
    };
    const service = stubService(
      command,
      { ...process.env, YARA_STUB_MODE: "match" },
      launcher,
    );
    const result = await service.inspect(
      { path: sample, rule_paths: [rule] },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cleanupIncomplete).toBe(false);
    const partialEvidence = result.error.partialObservation as {
      normalized_result?: unknown;
      operation?: string;
    };
    expect(partialEvidence?.operation).toBe("inspect_yara_matches");
    const retainedReport = yaraMatchesSchema.parse(
      partialEvidence?.normalized_result,
    );
    expect(retainedReport.matches.map((match) => match.rule)).toEqual([
      "Packed",
      "Plain",
    ]);
  });

  it("does not retain unverified matches on process cleanup cancellation when a rule snapshot changed", async () => {
    const { command, sample, rule } = await fixture("mutate-rule");
    const controller = new AbortController();
    const launcher: YaraLauncher = async (spawn) => {
      const launched = await interpreterLauncher(spawn);
      return {
        ...launched,
        cleanup: async () => {
          controller.abort("cancelled during process cleanup");
          return cleanupOwnedProcessGroup(launched.ownership);
        },
      };
    };
    const service = stubService(
      command,
      { ...process.env, YARA_STUB_MODE: "mutate-rule" },
      launcher,
    );
    const result = await service.inspect(
      { path: sample, rule_paths: [rule] },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path: sample,
      sha256: createHash("sha256").update(SAMPLE).digest("hex"),
      bytes: SAMPLE.length,
    });
  });

  it("closes staged file handles before removing the snapshot root and retries in order", async () => {
    const { command, sample, rule } = await fixture("match");
    const events: string[] = [];
    let firstRootPath: string | undefined;
    let failedHandleOnce = false;
    let handleCloseAttempts = 0;
    const provider = new YaraMatchesProvider({
      environment: { ...process.env, YARA_STUB_MODE: "match" },
      selectCommand: () => ok(command),
      launcher: interpreterLauncher,
      createRuntime: async () => {
        const real = await PrivateRuntimeRoot.create({ prefix: "rea-yara-" });
        if (firstRootPath !== undefined) return real;
        firstRootPath = real.path;
        return {
          path: real.path,
          close: async () => {
            events.push("root-close");
            return real.close();
          },
        };
      },
      openSnapshotFile: async (path) => {
        const handle = await open(path, "wx", 0o600);
        if (failedHandleOnce || !path.endsWith("rule-0.yar")) return handle;
        failedHandleOnce = true;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "close") {
              return async () => {
                handleCloseAttempts += 1;
                if (handleCloseAttempts === 1) {
                  events.push("handle-close-fail");
                  throw new Error("injected staged handle close failure");
                }
                events.push("handle-close-ok");
                return target.close();
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const service = new YaraMatchesService(provider, process.env);
    const first = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.cleanupIncomplete).toBe(true);
    // The snapshot root must NOT be removed while a child handle failed to close.
    expect(events).toEqual(["handle-close-fail"]);
    expect(firstRootPath).toBeDefined();
    await expect(stat(firstRootPath!)).resolves.toBeDefined();
    // Retry on close() must close the handle first, then remove the root.
    await expect(service.close()).resolves.toBeUndefined();
    expect(events).toEqual([
      "handle-close-fail",
      "handle-close-ok",
      "root-close",
    ]);
    expect(first.error.cleanupIncomplete).toBe(false);
    await expect(stat(firstRootPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains completed target file identity when target snapshot handle close fails", async () => {
    const { command, sample, rule } = await fixture("match");
    let failedCloseOnce = false;
    let closeAttempts = 0;
    const provider = new YaraMatchesProvider({
      environment: { ...process.env, YARA_STUB_MODE: "match" },
      selectCommand: () => ok(command),
      launcher: interpreterLauncher,
      openSnapshotFile: async (path) => {
        const handle = await open(path, "wx", 0o600);
        if (failedCloseOnce || !path.endsWith("target.bin")) return handle;
        failedCloseOnce = true;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "close") {
              return async () => {
                closeAttempts += 1;
                if (closeAttempts === 1)
                  throw new Error("injected target handle close failure");
                return target.close();
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const service = new YaraMatchesService(provider, process.env);
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path: sample,
      sha256: createHash("sha256").update(SAMPLE).digest("hex"),
      bytes: SAMPLE.length,
    });
    await expect(service.close()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(result.error.cleanupIncomplete).toBe(false);
  });

  it("retains completed target file identity when cancelled during target snapshot handle close", async () => {
    const { command, sample, rule } = await fixture("match");
    const controller = new AbortController();
    const provider = new YaraMatchesProvider({
      environment: { ...process.env, YARA_STUB_MODE: "match" },
      selectCommand: () => ok(command),
      launcher: interpreterLauncher,
      openSnapshotFile: async (path) => {
        const handle = await open(path, "wx", 0o600);
        if (!path.endsWith("target.bin")) return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "close") {
              return async () => {
                controller.abort("cancelled during target handle close");
                return target.close();
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const service = new YaraMatchesService(provider, process.env);
    const result = await service.inspect(
      { path: sample, rule_paths: [rule] },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path: sample,
      sha256: createHash("sha256").update(SAMPLE).digest("hex"),
      bytes: SAMPLE.length,
    });
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

  it("refuses a scanned file larger than max_file_bytes with required_value", async () => {
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
      limit: expect.objectContaining({
        parameter: "max_file_bytes",
        effective_value: 8,
        required_value: Buffer.byteLength(RULE),
      }),
    });
    const largeSampleOnly = await service.inspect({
      path: sample,
      rule_paths: [rule],
      max_file_bytes: Buffer.byteLength(RULE),
    });
    if (SAMPLE.length > Buffer.byteLength(RULE)) {
      expect(largeSampleOnly.ok).toBe(false);
    } else {
      const largeTarget = join(dirname(sample), "large.bin");
      await writeFile(largeTarget, Buffer.alloc(Buffer.byteLength(RULE) + 17));
      const targetResult = await service.inspect({
        path: largeTarget,
        rule_paths: [rule],
        max_file_bytes: Buffer.byteLength(RULE),
      });
      expect(targetResult.ok).toBe(false);
      if (!targetResult.ok) {
        expect(targetResult.error).toMatchObject({
          _tag: "AnalysisResourceConstraintError",
          limit: expect.objectContaining({
            parameter: "max_file_bytes",
            effective_value: Buffer.byteLength(RULE),
            required_value: Buffer.byteLength(RULE) + 17,
          }),
        });
      }
    }
  });

  it("refuses matches when the scanned file changes during the scan", async () => {
    const { sample, rule, service } = await fixture("mutate");
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(!result.ok && result.error._tag).toBe(
      "AnalysisArtifactChangedError",
    );
  });

  it("retains the scanned file's partial_observation when a rule file fails its final check after the scan", async () => {
    const { root, sample, rule, service } = await fixture("mutate-rule");
    const second = join(root, "second.yar");
    await writeFile(second, "rule Second { condition: true }\n");
    const result = await service.inspect({
      path: sample,
      rule_paths: [rule, second],
    });
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    const expectedObservation = {
      kind: "file-snapshot-hash",
      path: sample,
      sha256: createHash("sha256").update(SAMPLE).digest("hex"),
      bytes: SAMPLE.length,
    };
    expect(result.error).toMatchObject({
      _tag: "AnalysisArtifactChangedError",
      path: second,
      partialObservation: expectedObservation,
    });
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "artifact_changed",
      details: {
        path: second,
        partial_observation: expectedObservation,
      },
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

  it("resolves a relative REA_YARA_COMMAND against cwd before launching from root", async () => {
    const { command, sample, rule, args } = await fixture("match");
    const relativeCommand = relative(process.cwd(), command);
    const service = createYaraMatchesService({
      ...process.env,
      REA_YARA_COMMAND: relativeCommand,
      YARA_STUB_MODE: "match",
      YARA_STUB_ARGS: args,
    });
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(await readFile(args, "utf8")).cwd).toBe(
      parse(sample).root,
    );
  });

  test("refuses drive-relative rooted Windows paths across drives before hashing or launching", async () => {
    const launcher = vi.fn<YaraLauncher>();
    const provider = new YaraMatchesProvider({
      environment: {},
      platform: "win32",
      selectCommand: () => ok("C:\\tools\\yara.exe"),
      launcher,
    });
    const settings = {
      max_matches: {
        value: YARA_SETTING_BOUNDS.max_matches.default_value,
        source: "default" as const,
      },
      max_output_bytes: {
        value: YARA_SETTING_BOUNDS.max_output_bytes.default_value,
        source: "default" as const,
      },
      command_timeout_ms: {
        value: YARA_SETTING_BOUNDS.command_timeout_ms.default_value,
        source: "default" as const,
      },
    };
    const crossDriveRule = await provider.inspect({
      input: {
        path: "D:\\samples\\sample.bin",
        rule_paths: ["\\rules\\packers.yar"],
      },
      settings,
    });
    expect(crossDriveRule.ok).toBe(false);
    if (!crossDriveRule.ok) {
      expect(crossDriveRule.error).toMatchObject({
        _tag: "AnalysisInputError",
        conformsToInputContract: true,
        issues: [
          expect.objectContaining({
            path: ["rule_paths", 0],
            reason: "invalid_value",
          }),
        ],
      });
    }
    const rootedTarget = await provider.inspect({
      input: {
        path: "\\samples\\sample.bin",
        rule_paths: ["D:\\rules\\packers.yar"],
      },
      settings,
    });
    expect(rootedTarget.ok).toBe(false);
    if (!rootedTarget.ok) {
      expect(rootedTarget.error).toMatchObject({
        _tag: "AnalysisInputError",
        conformsToInputContract: true,
        issues: [
          expect.objectContaining({
            path: ["path"],
            reason: "invalid_value",
          }),
        ],
      });
    }
    expect(launcher).not.toHaveBeenCalled();
  });
});
