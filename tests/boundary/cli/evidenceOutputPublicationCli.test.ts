import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { cliRetainedEvidenceDirectory } from "../../../src/cli/cliEvidenceRetention.js";
import { analysisErrorProjectionSchema } from "../../../src/domain/analysisErrorProjectionSchema.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

// Both commands reach the same staged writer. Select rows for distinct
// publication outcomes and exercise each compiled command.
const families = [
  {
    command: "inspect-model-artifact",
    operation: "inspect_model_artifact",
    target: async (root: string): Promise<string> => {
      const header = Buffer.from(
        JSON.stringify({
          weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] },
        }),
      );
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(header.length));
      const path = join(root, "fixture.safetensors");
      await writeFile(path, Buffer.concat([length, header, Buffer.alloc(4)]));
      return path;
    },
  },
  {
    command: "inspect-desktop-application",
    operation: "inspect_desktop_application",
    target: async (root: string): Promise<string> => {
      const path = join(root, "installation");
      await mkdir(join(path, "resources"), { recursive: true });
      await writeFile(join(path, "resources/app.asar"), "path convention");
      return path;
    },
  },
] as const;

const [model, desktop] = families;
type Family = (typeof families)[number];

const publish = async (
  cli: TestCli,
  family: Family,
  detail: "summary" | "complete",
  publication: Record<string, unknown>,
) => {
  const root = await createTestTempDirectory("rea-evidence-output-");
  const target = await family.target(root);
  const destination = join(root, "parent.json");
  const marker = join(root, "signal.json");
  const reply = await cli.run({
    cwd: root,
    arguments: [
      family.command,
      target,
      "--detail",
      detail,
      "--evidence_output",
      destination,
      "--json",
    ],
    environment: {
      HOME: root,
      REA_LOG_LEVEL: "silent",
      REA_TEST_EVIDENCE_PUBLICATION: JSON.stringify({
        prefix: join(await realpath(root), ".rea-write-"),
        marker,
        ...publication,
      }),
      NODE_OPTIONS: `--max-old-space-size=2048 --import=${pathToFileURL(resolve("tests/fixtures/evidencePublicationPreload.mjs")).href}`,
    },
  });
  const staging = (await readdir(root)).filter((name) =>
    name.startsWith(".rea-write-"),
  );
  return { reply, destination, marker, staging };
};

const cliError = (json: unknown) => analysisErrorProjectionSchema.parse(json);

const committedParent = async (destination: string) => {
  const bytes = await readFile(destination);
  const records = parseEvidenceBundle(JSON.parse(bytes.toString())).records;
  expect(records).toHaveLength(1);
  return { bytes: bytes.length, parent: records[0]! };
};

const signalDelivery =
  process.platform === "win32" ? ("event" as const) : ("os" as const);

cliTest.for([
  { family: model, detail: "summary", signal: "SIGINT" },
  { family: desktop, detail: "summary", signal: "SIGTERM" },
  { family: desktop, detail: "complete", signal: "SIGINT" },
] as const)(
  "$family.command keeps the committed $detail receipt when $signal arrives during final cleanup",
  async ({ family, detail, signal }, { cli }) => {
    const { reply, destination, marker, staging } = await publish(
      cli,
      family,
      detail,
      { phase: "cleanup", signal, delivery: signalDelivery },
    );
    expect(reply.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    const error = cliError(reply.json);
    expect(error.code).toBe("cancelled");
    expect(error.details?.operation).toBe(family.operation);
    const { bytes, parent } = await committedParent(destination);
    expect(error.details?.diagnostics).toEqual({
      evidence_bundle: { path: destination, bytes },
    });
    const partial = parseEvidence(error.details?.partial_observation);
    if (detail === "complete") expect(partial).toEqual(parent);
    else {
      expect(partial.evidence_links).toEqual([parent.evidence_id]);
      expect(partial.normalized_result).toMatchObject({
        kind: "summary",
        parent_evidence_id: parent.evidence_id,
      });
    }
    const proof = JSON.parse(await readFile(marker, "utf8"));
    expect(proof).toMatchObject({ phase: "cleanup", signal });
    expect(proof.listeners).toBeGreaterThan(0);
    expect(staging).toEqual([]);
  },
);

cliTest.for([model])(
  "$command creates no output or receipt when SIGINT arrives before commit",
  async (family, { cli }) => {
    const { reply, destination, marker, staging } = await publish(
      cli,
      family,
      "summary",
      { phase: "staging", signal: "SIGINT", delivery: signalDelivery },
    );
    expect(reply.exitCode).toBe(130);
    const error = cliError(reply.json);
    expect(error.code).toBe("cancelled");
    expect(error.details?.operation).toBe(family.operation);
    expect(error.details).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(reply.json)).not.toContain(destination);
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The complete Evidence remains available when nothing was published.
    expect(parseEvidence(error.details?.partial_observation).operation).toBe(
      family.operation,
    );
    const proof = JSON.parse(await readFile(marker, "utf8"));
    expect(proof).toMatchObject({ phase: "staging", signal: "SIGINT" });
    expect(proof.listeners).toBeGreaterThan(0);
    expect(staging).toEqual([]);
  },
);

cliTest.for([desktop])(
  "$command delivers the receipt once a failed staging cleanup is confirmed by retry",
  async (family, { cli }) => {
    const { reply, destination, marker, staging } = await publish(
      cli,
      family,
      "summary",
      { cleanup_failures: 1 },
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      cleanup_failure: "EBUSY",
    });
    expect(reply.exitCode).toBe(0);
    const { bytes, parent } = await committedParent(destination);
    expect(reply.json).toMatchObject({
      evidence_bundle: { path: destination, bytes },
      summary: {
        normalized_result: { parent_evidence_id: parent.evidence_id },
      },
    });
    expect(staging).toEqual([]);
  },
);

cliTest.for([model])(
  "$command reports the committed receipt when staging cleanup stays incomplete",
  async (family, { cli }) => {
    const { reply, destination, marker, staging } = await publish(
      cli,
      family,
      "summary",
      { cleanup_failures: 1_000 },
    );
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      cleanup_failure: "EBUSY",
    });
    expect(reply.exitCode).not.toBe(0);
    const error = cliError(reply.json);
    expect(error.code).toBe("cleanup_incomplete");
    const { bytes, parent } = await committedParent(destination);
    expect(error.details).toMatchObject({
      published: true,
      published_path: destination,
      bytes,
      cleanup: "incomplete",
    });
    expect(parseEvidence(error.details?.partial_observation)).toEqual(parent);
    expect(staging).toHaveLength(1);
  },
);

cliTest(
  "inspect-byte-entropy reports cleanup_incomplete when retained-cache staging cleanup fails before commit",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-retain-precommit-");
    const target = join(root, "bytes");
    await writeFile(target, randomBytes(1024 * 1024));
    const home = await createTestTempDirectory("rea-retain-precommit-home-");
    const cache = await createTestTempDirectory("rea-retain-precommit-cache-");
    const marker = join(root, "signal.json");
    const environment = {
      HOME: home,
      XDG_CACHE_HOME: cache,
      LOCALAPPDATA: cache,
    };
    const cacheDirectory = cliRetainedEvidenceDirectory(
      environment,
      process.platform,
    );
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const expectedCacheReal = await realpath(cacheDirectory);
    const reply = await cli.run({
      cwd: root,
      delivery: "budgeted",
      arguments: [
        "inspect-byte-entropy",
        target,
        "--block-size",
        "256",
        "--json",
      ],
      environment: {
        ...environment,
        REA_TEST_EVIDENCE_PUBLICATION: JSON.stringify({
          prefix: join(expectedCacheReal, ".rea-write-"),
          marker,
          phase: "staging",
          signal: "SIGINT",
          delivery: signalDelivery,
          cleanup_failures: 1_000,
        }),
        NODE_OPTIONS: `--max-old-space-size=2048 --import=${pathToFileURL(resolve("tests/fixtures/evidencePublicationPreload.mjs")).href}`,
      },
    });
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
      phase: "staging",
      signal: "SIGINT",
      delivery: signalDelivery,
    });
    expect(reply.exitCode).not.toBe(0);
    const error = cliError(reply.json);
    expect(error.code).toBe("cleanup_incomplete");
    expect(error.retryable).toBe(false);
    expect(error.details).toMatchObject({ cleanup: "incomplete" });
    const resources = error.details?.resources;
    expect(Array.isArray(resources)).toBe(true);
    expect((resources as unknown[]).length).toBeGreaterThan(0);
    expect(parseEvidence(error.details?.partial_observation).operation).toBe(
      "inspect_byte_entropy",
    );
    const staging = (await readdir(expectedCacheReal)).filter((name) =>
      name.startsWith(".rea-write-"),
    );
    expect(staging).toHaveLength(1);
  },
);

cliTest(
  "inspect-byte-entropy reports the surviving cache receipt and paging cursor when removing an oversized retained bundle fails",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-retain-remains-");
    const target = join(root, "bytes");
    await writeFile(target, randomBytes(1024 * 1024));
    const home = await createTestTempDirectory("rea-retain-remains-home-");
    const cache = await createTestTempDirectory("rea-retain-remains-cache-");
    const marker = join(root, "rm-signal.json");
    const environment = {
      HOME: home,
      XDG_CACHE_HOME: cache,
      LOCALAPPDATA: cache,
    };
    const cacheDirectory = cliRetainedEvidenceDirectory(
      environment,
      process.platform,
    );
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const expectedCacheReal = await realpath(cacheDirectory);

    const baseline = await cli.run({
      cwd: root,
      delivery: "budgeted",
      arguments: [
        "inspect-byte-entropy",
        target,
        "--block-size",
        "256",
        "--no-retain",
        "--json",
      ],
      environment,
    });
    expect(baseline.exitCode).toBe(0);
    const completeBytes = z
      .object({
        delivery: z.object({ complete_bytes: z.number().int().positive() }),
      })
      .parse(baseline.json).delivery.complete_bytes;

    const reply = await cli.run({
      cwd: root,
      delivery: "budgeted",
      arguments: [
        "inspect-byte-entropy",
        target,
        "--block-size",
        "256",
        "--json",
      ],
      environment: {
        ...environment,
        REA_CLI_RETAINED_EVIDENCE_BYTES: String(completeBytes + 32),
        REA_TEST_EVIDENCE_PUBLICATION: JSON.stringify({
          prefix: `${expectedCacheReal}${sep}`,
          marker,
          rm_failures: 1,
        }),
        NODE_OPTIONS: `--max-old-space-size=2048 --import=${pathToFileURL(resolve("tests/fixtures/evidencePublicationPreload.mjs")).href}`,
      },
    });
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      rm_failure: "EBUSY",
    });
    expect(reply.exitCode).toBe(0);
    const parsed = z
      .object({
        summary: z.unknown(),
        evidence_bundle: z.object({
          path: z.string(),
          bytes: z.number().int().positive(),
          record_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        }),
        delivery: z.object({
          retained: z.literal("cache-file"),
          retention_failure: z.string(),
          next: z.object({
            arguments: z.object({
              source: z.object({
                kind: z.literal("evidence-file"),
                path: z.string(),
              }),
            }),
          }),
        }),
      })
      .parse(reply.json);
    expect(parsed.delivery.next.arguments.source.path).toBe(
      parsed.evidence_bundle.path,
    );
    expect(parsed.delivery.retention_failure).toContain("larger than");
    expect(parsed.delivery.retention_failure).toContain("could not be removed");
    const [record] = parseEvidenceBundle(
      JSON.parse(await readFile(parsed.evidence_bundle.path, "utf8")),
    ).records;
    if (record === undefined)
      throw new Error("The surviving cache bundle lacks the Evidence record");
    expect(record.operation).toBe("inspect_byte_entropy");
    expect(parsed.summary).toMatchObject({
      normalized_result: {
        kind: "summary",
        parent_evidence_id: record.evidence_id,
      },
    });
  },
);
