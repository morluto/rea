import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { compareProcessCaptures } from "../../../src/domain/process/processComparison.js";
import { parseProcessCapture } from "../../../src/domain/process/processCaptureParsing.js";
import { parseProcessScenario } from "../../../src/domain/process/processScenario.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  CAPTURE_SKIP_REASON,
  itWithCaptureCapability,
} from "./processCaptureCapability.js";

const exec = promisify(execFile);

const captureViaCli = async (scenario: Record<string, unknown>) => {
  const scenarioPath = join(
    await createTestTempDirectory("rea-fs-scenario-"),
    "scenario.json",
  );
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const { stdout } = await exec(process.execPath, [
    "scripts/rea.mjs",
    "capture-process",
    scenarioPath,
    "--format",
    "json",
  ]);
  return parseEvidence(JSON.parse(stdout));
};

const captureViaMcp = async (scenario: Record<string, unknown>) => {
  const session = createTestBinarySession(() => {
    throw new Error("Process capture must not launch a binary provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "filesystem-coverage", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "capture_process_scenario",
    arguments: scenario,
  });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const evidence = parseEvidence(result.structuredContent);
  await client.ping();
  return evidence;
};

itWithCaptureCapability.each(["cli", "mcp"] as const)(
  "hashes the documented complete report despite omitted terminal output through %s",
  async (adapter) => {
    const document = await readFile("docs/process-capture.md", "utf8");
    const example = document
      .split("## Hash a report independently of terminal output")[1]
      ?.match(/```json\n([\s\S]*?)\n```/u)?.[1];
    if (example === undefined)
      throw new Error("Missing report capture example");
    const scenario = parseProcessScenario(JSON.parse(example));
    const root = await createTestTempDirectory("rea-full-report-adapter-");
    const evidence = await (adapter === "cli" ? captureViaCli : captureViaMcp)({
      ...scenario,
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [join(root, "reports")],
    });
    const capture = parseProcessCapture(evidence.normalized_result);
    const bytes = await readFile(join(root, "reports", "final.json"));
    expect(JSON.parse(bytes.toString())).toEqual({
      status: "complete",
      data: "X".repeat(131072),
    });
    expect(bytes.length).toBeGreaterThan(scenario.limits.output_bytes);
    expect(capture.files_after).toContainEqual(
      expect.objectContaining({
        path: "root_0:final.json",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    expect(capture.truncation_details.filesystem_after).toMatchObject({
      enumeration_truncated: false,
      hash_budget_bytes: scenario.limits.file_bytes,
      hashed_bytes: bytes.length,
      hash_omissions: [],
    });
    expect(capture.truncation_details.raw_terminal.retained_bytes).toBeLessThan(
      capture.truncation_details.raw_terminal.observed_bytes,
    );
  },
  20_000,
);

itWithCaptureCapability.each(["cli", "mcp"] as const)(
  "accounts for exact cumulative hash budgets independently at each %s checkpoint",
  async (adapter) => {
    const runCapture = adapter === "cli" ? captureViaCli : captureViaMcp;
    for (const shortfall of [0, 1]) {
      const root = await createTestTempDirectory("rea-report-cumulative-");
      const periodic = Buffer.from('{"status":"running"}');
      const final = Buffer.from('{"status":"complete"}');
      await writeFile(join(root, "periodic.json"), periodic);
      const budget = periodic.length + final.length - shortfall;
      const evidence = await runCapture({
        executable: process.execPath,
        arguments: [
          "-e",
          "require('node:fs').writeFileSync('final.json','{\"status\":\"complete\"}')",
        ],
        working_directory: root,
        filesystem_observation_paths: [root],
        limits: { output_bytes: 1, file_bytes: budget },
      });
      const capture = parseProcessCapture(evidence.normalized_result);
      expect(capture.truncation_details.filesystem_before).toMatchObject({
        hashed_bytes: periodic.length,
        hash_omissions: [],
      });
      expect(capture.files_after).toContainEqual(
        expect.objectContaining({
          path: "root_0:final.json",
          sha256: createHash("sha256").update(final).digest("hex"),
        }),
      );
      expect(capture.truncation_details.filesystem_after).toMatchObject({
        enumeration_truncated: false,
        hashed_bytes: final.length + (shortfall === 0 ? periodic.length : 0),
        hash_omissions:
          shortfall === 0
            ? []
            : [
                {
                  path: "root_0:periodic.json",
                  reason: "file_bytes_budget",
                  remaining_budget_bytes: periodic.length - 1,
                },
              ],
      });
      expect(
        capture.files_after.find(({ path }) => path === "root_0:periodic.json")
          ?.sha256,
      ).toBe(
        shortfall === 0
          ? createHash("sha256").update(periodic).digest("hex")
          : null,
      );
    }
  },
  20_000,
);

itWithCaptureCapability.each(["cli", "mcp"] as const)(
  "reports unknown absence instead of deletion in truncated %s capture Evidence",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-fs-coverage-adapter-");
    await writeFile(join(root, "z.txt"), "unchanged");
    const scenario = {
      executable: process.execPath,
      arguments: ["-e", "require('node:fs').writeFileSync('a.txt','added')"],
      working_directory: root,
      filesystem_observation_paths: [root],
      limits: { files: 2 },
    };
    const evidence = await (adapter === "cli" ? captureViaCli : captureViaMcp)(
      scenario,
    );
    const capture = parseProcessCapture(evidence.normalized_result);
    expect(capture.truncated).toBe(true);
    expect(await readFile(join(root, "z.txt"), "utf8")).toBe("unchanged");
    expect(
      capture.filesystem_effects.find(({ path }) => path === "root_0:z.txt")
        ?.status,
    ).toBe("unknown");
    expect(
      capture.filesystem_checkpoints
        .find(({ name }) => name === "after_settlement")
        ?.effects.find(({ path }) => path === "root_0:z.txt")?.status,
    ).toBe("unknown");
  },
  20_000,
);

itWithCaptureCapability.each(["cli", "mcp"] as const)(
  "reports unknown content after a same-size rewrite without digests through %s",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-fs-content-adapter-");
    const file = join(root, "changed.txt");
    await writeFile(file, "before");
    const scenario = {
      executable: process.execPath,
      arguments: [
        "-e",
        "require('node:fs').writeFileSync('changed.txt','after!')",
      ],
      working_directory: root,
      filesystem_observation_paths: [root],
      limits: { file_bytes: 1 },
    };
    const evidence = await (adapter === "cli" ? captureViaCli : captureViaMcp)(
      scenario,
    );
    const capture = parseProcessCapture(evidence.normalized_result);
    expect(await readFile(file, "utf8")).toBe("after!");
    const effect = capture.filesystem_effects.find(
      ({ path }) => path === "root_0:changed.txt",
    );
    expect(effect).toMatchObject({
      status: "unknown",
      reason: expect.any(String),
      before: { size: 6, sha256: null },
      after: { size: 6, sha256: null },
    });
    if (effect?.status !== "unknown")
      throw new Error("Expected unknown file contents");
    expect(
      capture.filesystem_checkpoints.find(
        ({ name }) => name === "after_settlement",
      )?.effects,
    ).toContainEqual(effect);
    expect(capture.residual_unknowns).toContainEqual({
      scope: "filesystem",
      reason: effect.reason,
    });
    expect(capture.limitations).toContain(effect.reason);
    expect(
      capture.truncation_details.filesystem_after.enumeration_truncated,
    ).toBe(false);
    expect(compareProcessCaptures(capture, capture).filesystem).toBe("unknown");
  },
  20_000,
);

it.skipIf(CAPTURE_SKIP_REASON || process.platform === "win32")(
  "keeps unfollowed descendant absence unknown through MCP Evidence and comparison",
  async () => {
    const root = await createTestTempDirectory("rea-fs-symlink-adapter-");
    const target = await createTestTempDirectory(
      "rea-fs-symlink-adapter-target-",
    );
    await mkdir(join(root, "subtree"));
    await writeFile(join(root, "subtree", "z.txt"), "unchanged");
    await writeFile(join(target, "z.txt"), "unchanged");
    await writeFile(join(root, "removed.txt"), "removed");
    const evidence = await captureViaMcp({
      executable: process.execPath,
      arguments: [
        "-e",
        "const fs=require('node:fs');fs.rmSync('subtree',{recursive:true});fs.symlinkSync(process.argv[1],'subtree');fs.unlinkSync('removed.txt');",
        target,
      ],
      working_directory: root,
      filesystem_observation_paths: [root],
    });
    const capture = parseProcessCapture(evidence.normalized_result);
    expect(await readFile(join(root, "subtree", "z.txt"), "utf8")).toBe(
      "unchanged",
    );
    expect(
      capture.filesystem_effects.find(
        ({ path }) => path === "root_0:subtree/z.txt",
      )?.status,
    ).toBe("unknown");
    expect(
      capture.filesystem_effects.find(
        ({ path }) => path === "root_0:removed.txt",
      )?.status,
    ).toBe("deleted");
    expect(capture.residual_unknowns).toContainEqual({
      scope: "filesystem",
      reason: expect.any(String),
    });
    expect(compareProcessCaptures(capture, capture).filesystem).toBe("unknown");
  },
  20_000,
);
