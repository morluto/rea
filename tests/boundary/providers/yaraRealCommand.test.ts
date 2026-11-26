import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

import { YaraMatchesService } from "../../../src/application/yara/YaraMatchesService.js";
import { createYaraMatchesService } from "../../../src/composition/yara.js";
import { ok } from "../../../src/domain/result.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import {
  YaraMatchesProvider,
  type YaraLauncher,
} from "../../../src/yara/YaraMatchesProvider.js";
import { yaraMatchesSchema } from "../../../src/domain/yara/yaraMatches.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const findYara = (): string | undefined => {
  if (process.platform === "win32") return undefined;
  try {
    const path = execFileSync("which", ["yara"], { encoding: "utf8" }).trim();
    return path === "" ? undefined : path;
  } catch {
    return undefined;
  }
};

const yara = findYara();

const RULES = String.raw`rule Hello : tagA tagB
{
  meta:
    author = "A \"q\" \\ b"
    score = 42
    ok = true
  strings:
    $t = "hello"
    $h = { 4D 5A 90 00 }
  condition:
    any of them
}
rule NotMatched { strings: $a = "zzzz" condition: $a }
`;

const sampleFile = async () => {
  const root = await createTestTempDirectory("rea-yara-real-");
  const sample = join(root, "sample [x].bin");
  await writeFile(sample, Buffer.from("MZ\x90\x00hello hello\n", "latin1"));
  const rule = join(root, "rules.yar");
  await writeFile(rule, RULES);
  return { root, sample, rule };
};

it.skipIf(yara === undefined)(
  "reads matches the installed yara reports",
  async () => {
    const { sample, rule } = await sampleFile();
    const service = createYaraMatchesService({
      ...process.env,
      REA_YARA_COMMAND: yara,
    });
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const report = yaraMatchesSchema.parse(result.value.normalized_result);
    expect(report.matches).toEqual([
      {
        rule: "Hello",
        tags: ["tagA", "tagB"],
        meta: [
          { identifier: "author", type: "string", value: 'A "q" \\ b' },
          { identifier: "score", type: "integer", value: 42 },
          { identifier: "ok", type: "boolean", value: true },
        ],
        string_match_count: 3,
        strings: [
          { identifier: "$t", file_offset: 4, length: 5, data: "hello" },
          { identifier: "$t", file_offset: 10, length: 5, data: "hello" },
          { identifier: "$h", file_offset: 0, length: 4, data: "4D 5A 90 00" },
        ],
      },
    ]);
    await service.close();
  },
);

it.skipIf(yara === undefined)(
  "returns the installed yara's compile error as an input error",
  async () => {
    const { root, sample } = await sampleFile();
    const bad = join(root, "bad.yar");
    await writeFile(bad, "rule Bad { condition: nope }\n");
    const service = createYaraMatchesService({
      ...process.env,
      REA_YARA_COMMAND: yara,
    });
    const result = await service.inspect({ path: sample, rule_paths: [bad] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        expect.objectContaining({
          path: ["rule_paths", 0],
          message: expect.stringContaining('undefined identifier "nope"'),
        }),
      ],
    });
  },
);

/** A rule file under a directory whose name holds a colon, as `a:b`. */
const colonRule = async (root: string, source: string): Promise<string> => {
  const directory = join(root, `rea-yara-ns:rea-yara-split-${randomUUID()}`);
  await mkdir(directory);
  const rule = join(directory, "rule.yar");
  await writeFile(rule, source);
  return rule;
};

const realService = (command: string, launcher?: YaraLauncher) =>
  new YaraMatchesService(
    new YaraMatchesProvider({
      environment: process.env,
      selectCommand: () => ok(command),
      ...(launcher === undefined ? {} : { launcher }),
    }),
    process.env,
  );

it.skipIf(yara === undefined)(
  "compiles a rule file whose path contains a colon and maps its compile error",
  async () => {
    const { root, sample } = await sampleFile();
    const rule = await colonRule(
      root,
      'rule ColonRule { strings: $t = "hello" condition: $t }\n',
    );
    const bad = await colonRule(root, "rule Bad { condition: nope }\n");
    const service = realService(yara!);
    const result = await service.inspect({ path: sample, rule_paths: [rule] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const report = yaraMatchesSchema.parse(result.value.normalized_result);
    expect(report.matches.map((match) => match.rule)).toEqual(["ColonRule"]);
    const failed = await service.inspect({
      path: sample,
      rule_paths: [rule, bad],
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [expect.objectContaining({ path: ["rule_paths", 1] })],
    });
  },
);

it.skipIf(yara === undefined)(
  "never lets the installed yara compile another file for a replaced colon rule path",
  async () => {
    const { root, sample } = await sampleFile();
    const rule = await colonRule(root, "rule HashedRule { condition: true }\n");
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
      return spawnOwnedProviderProcess(spawn);
    };
    try {
      const result = await realService(yara!, launcher).inspect({
        path: sample,
        rule_paths: [rule],
      });
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
  },
);

it.skipIf(yara === undefined)(
  "compiles a rule file with a relative include directive against its original directory",
  async () => {
    const { root, sample } = await sampleFile();
    const rulesDir = join(root, "rules");
    await mkdir(rulesDir);
    const common = join(rulesDir, "common.yar");
    await writeFile(
      common,
      'rule CommonRule { strings: $t = "hello" condition: $t }\n',
    );
    const mainSource =
      'include "common.yar"\nrule MainRule { condition: CommonRule }\n';
    const mainRule = join(rulesDir, "main.yar");
    await writeFile(mainRule, mainSource);
    const service = realService(yara!);
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
    expect(report.rule_files).toEqual([
      {
        path: mainRule,
        sha256: createHash("sha256").update(mainSource).digest("hex"),
        bytes: Buffer.byteLength(mainSource),
      },
    ]);
    await service.close();
  },
);
