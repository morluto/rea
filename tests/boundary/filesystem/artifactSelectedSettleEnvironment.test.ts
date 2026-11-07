import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { withArtifactTargetIdentity } from "../../../src/artifacts/withArtifactTargetIdentity.js";
import { openRegularFile } from "../../../src/filesystem/RegularFile.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { elf, pe, thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { buildGodotPck, pckU64 } from "../../fixtures/godotPck.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createSingleEntryZip } from "../../fixtures/zipNames.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["zip", "inventory_artifact"],
  ["zip", "extract_artifact"],
  ["elf", "inventory_artifact"],
  ["elf", "extract_artifact"],
  ["pe", "inventory_artifact"],
  ["pe", "extract_artifact"],
  ["mach-o", "inventory_artifact"],
  ["mach-o", "extract_artifact"],
] as const)(
  "%s %s keeps the provider's selected settle environment through root admission",
  async (format, operation) => {
    const root = await createTestTempDirectory("rea-selected-settle-");
    const path = join(root, `selected.${format}`);
    const pack = buildGodotPck(
      2,
      [{ path: "res://payload.txt", data: Buffer.from("selected bytes") }],
      { packFlags: 2 },
    );
    const header =
      format === "elf"
        ? elf(2, 1, 62)
        : format === "pe"
          ? pe(0x8664)
          : thinMach(0xfeedfacf, 0x0100000c);
    await writeFile(
      path,
      format === "zip"
        ? await createSingleEntryZip("payload.txt", "selected bytes")
        : Buffer.concat([
            header,
            pack,
            pckU64(pack.length),
            Buffer.from("GDPC"),
          ]),
    );
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    expect(target.value.format).toBe(format);
    const client = new ArtifactProvider({}).createClient(target.value);
    vi.stubEnv("REA_WINDOWS_CHANGE_TIME_DRIFT_MS", "invalid ambient value");
    try {
      const output = join(root, "output");
      const execution = await client.execute(
        operation,
        operation === "extract_artifact" ? { output_root: output } : {},
      );
      if (!execution.ok) throw execution.error;
      if (operation === "inventory_artifact") {
        const inventory = artifactInventoryResultSchema.parse(
          execution.value.result,
        );
        expect(inventory.manifest.root_sha256).toBe(target.value.sha256);
        expect(
          inventory.occurrences.some(
            (entry) => entry.logical_path === "payload.txt",
          ),
        ).toBe(true);
      } else {
        expect(await readFile(join(output, "payload.txt"), "utf8")).toBe(
          "selected bytes",
        );
      }
    } finally {
      await client.close();
    }
  },
);

it("rejects invalid selected settle settings even when ambient settings are valid", async () => {
  const root = await createTestTempDirectory("rea-invalid-selected-settle-");
  const path = join(root, "selected.zip");
  await writeFile(path, await createSingleEntryZip("payload.txt"));
  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const client = new ArtifactProvider({
    REA_WINDOWS_CHANGE_TIME_DRIFT_MS: "invalid selected value",
  }).createClient(target.value);
  vi.stubEnv("REA_WINDOWS_CHANGE_TIME_DRIFT_MS", "2000");
  try {
    const execution = await client.execute("inventory_artifact", {});
    expect(execution).toMatchObject({
      ok: false,
      error: {
        settings: [
          {
            setting: "REA_WINDOWS_CHANGE_TIME_DRIFT_MS",
            constraint: expect.stringContaining("invalid selected value"),
          },
        ],
      },
    });
  } finally {
    await client.close();
  }
});

it.each([false, true])(
  "root identity checks keep the selected environment and detect rewriting=%s",
  async (rewrite) => {
    const root = await createTestTempDirectory("rea-selected-identity-settle-");
    const path = join(root, "selected.zip");
    await writeFile(path, await createSingleEntryZip("payload.txt"));
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    const scope = new ArtifactResourceScope();
    vi.stubEnv("REA_WINDOWS_CHANGE_TIME_DRIFT_MS", "invalid ambient value");
    try {
      const operation = withArtifactTargetIdentity(
        target.value,
        scope,
        async () => {
          if (rewrite) await writeFile(path, "changed source");
          return "read completed";
        },
        undefined,
        {},
      );
      if (rewrite) {
        await expect(operation).rejects.toMatchObject({
          reason: "integrity",
          message: expect.stringContaining("Active target digest changed"),
        });
      } else {
        await expect(operation).resolves.toBe("read completed");
      }
    } finally {
      await scope.close();
    }
  },
);

it("keeps ambient settle validation for regular-file callers that omit an environment", async () => {
  const root = await createTestTempDirectory("rea-ambient-settle-");
  const path = join(root, "selected.bin");
  await writeFile(path, "unchanged bytes");
  vi.stubEnv("REA_WINDOWS_CHANGE_TIME_DRIFT_MS", "invalid ambient value");
  await expect(openRegularFile(path, { symlinks: "reject" })).rejects.toThrow(
    "invalid ambient value",
  );
});
