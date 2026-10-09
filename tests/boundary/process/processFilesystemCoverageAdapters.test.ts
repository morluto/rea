import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  compareProcessCaptures,
  parseProcessCapture,
} from "../../../src/domain/process/processCapture.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  CAPTURE_SKIP_REASON,
  itWithCaptureCapability,
} from "./processCaptureCapability.js";
import { z } from "zod";

const exec = promisify(execFile);

const captureViaMcp = async (scenario: Record<string, unknown>) => {
  const session = createTestBinarySession(() => {
    throw new Error("Process capture must not launch a binary provider");
  });
  const server = createServer(session, session);
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
  const evidence = parseEvidence(
    z.object({ evidence: z.unknown() }).parse(result.structuredContent)
      .evidence,
  );
  await client.ping();
  return evidence;
};

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
    let evidence;
    if (adapter === "cli") {
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
      evidence = parseEvidence(JSON.parse(stdout));
    } else evidence = await captureViaMcp(scenario);
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
    expect(["unknown", "truncated"]).toContain(
      compareProcessCaptures(capture, capture).filesystem,
    );
  },
  20_000,
);
