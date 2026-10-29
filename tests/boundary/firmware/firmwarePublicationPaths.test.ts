import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FirmwareProvider } from "../../../src/firmware/FirmwareProvider.js";
import { FirmwareAnalysisService } from "../../../src/application/firmware/FirmwareAnalysisService.js";
import { FirmwareFileAccess } from "../../../src/firmware/FirmwareFiles.js";
import { publishFirmwareExtraction } from "../../../src/firmware/FirmwarePublication.js";
import { normalizeUnblobReport } from "../../../src/firmware/FirmwareReports.js";
import { startFirmwareDeadline } from "../../../src/firmware/FirmwareDeadline.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["existing", "missing-parent", "relative"] as const)(
  "refuses %s destinations before selecting or launching a firmware engine",
  async (kind) => {
    const root = await createTestTempDirectory("rea-firmware-destination-");
    const output =
      kind === "existing"
        ? join(root, "exists")
        : kind === "missing-parent"
          ? join(root, "missing", "output")
          : "relative-output";
    if (kind === "existing") await mkdir(output);
    const launcher = vi.fn(async () => {
      throw new Error("Must not launch");
    });
    const provider = new FirmwareProvider({}, launcher);
    try {
      const result = await new FirmwareAnalysisService(provider).execute(
        "extract_firmware",
        { path: join(root, "absent-input"), output_directory: output },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisInputError",
          issues: [
            {
              path: ["output_directory"],
              reason: kind === "relative" ? "invalid_format" : "invalid_value",
            },
          ],
        },
      });
      expect(launcher).not.toHaveBeenCalled();
    } finally {
      await provider.close();
    }
  },
);

it("early destination admission creates nothing and publication still acquires exclusively", async () => {
  const root = await createTestTempDirectory("rea-firmware-preflight-");
  const output = join(root, "output");
  await SafeOutputTree.checkDestination(output);
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(output);
  await expect(SafeOutputTree.create(output)).rejects.toMatchObject({
    name: "SafeOutputTreeDestinationRefusal",
  });
  expect(await access(output)).toBeUndefined();
});

it("publishes the writer's normalized path while retaining source spelling and unclassified input coverage", async () => {
  const root = await createTestTempDirectory("rea-firmware-published-name-");
  const staging = join(root, "staging");
  await mkdir(staging);
  const name = "cafe\u0301.bin";
  const bytes = Buffer.from("child");
  const path = join(staging, name);
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const inputPath = join(root, "input");
  const inputHash = "a".repeat(64);
  const normalized = normalizeUnblobReport(
    [
      {
        task: { path: inputPath, depth: 0, blob_id: "", is_multi_file: false },
        reports: [
          {
            __typename__: "StatReport",
            path: inputPath,
            size: 1,
            is_file: true,
            is_dir: false,
            is_link: false,
            link_target: null,
          },
          { __typename__: "HashReport", sha256: inputHash },
        ],
        subtasks: [],
      },
    ],
    {
      inputPath,
      outputRoot: staging,
      sha256: inputHash,
      length: 1,
      offset: 7,
      maxDepth: 3,
    },
  );
  const files = new FirmwareFileAccess();
  const output = join(root, "published");
  const retainCleanup = vi.fn();
  try {
    const result = await publishFirmwareExtraction({
      files,
      workspacePath: root,
      deadline: startFirmwareDeadline("publication", 120_000),
      analysisTimeoutMs: 120_000,
      outputDirectory: output,
      entries: [
        {
          path,
          relativePath: name,
          size: bytes.length,
          kind: "file",
          linkTarget: null,
        },
      ],
      normalized,
      selection: { offset: 7, length: 1, sha256: inputHash },
      maxDepth: 3,
      engine: {
        name: "unblob",
        version: "26.6.4",
        executable_path: "/synthetic/unblob",
        executable_sha256: inputHash,
        source_revision: null,
        worker_count: 1,
      },
      signal: new AbortController().signal,
      retainCleanup,
    });
    expect(result.files).toMatchObject([
      {
        relative_path: name,
        path: join(output, name.normalize("NFC")),
        sha256,
      },
    ]);
    const published = result.files[0];
    if (published === undefined) throw new Error("Expected published child");
    expect(Buffer.compare(await readFile(published.path), bytes)).toBe(0);
    expect(result).toMatchObject({
      coverage: "partial",
      extraction_gaps: [
        {
          kind: "unclassified-range",
          input_path: "$input",
          provider_id: null,
          handler: null,
          range: { offset: 0, length: 1 },
          root_file_range: { offset: 7, length: 1 },
        },
      ],
    });
    expect(retainCleanup).not.toHaveBeenCalled();
  } finally {
    await files.close();
  }
});
