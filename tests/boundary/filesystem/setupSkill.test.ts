import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
  parseCanonicalSkillBundleManifest,
} from "../../../src/application/SetupSkill.js";
import {
  runDoctor,
  systemDoctorHost,
} from "../../../src/application/Doctor.js";
import { createDoctorHostFixture } from "../../../src/application/Doctor.fixture.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { z } from "zod";
import { skillReferenceIssues } from "../../../scripts/lib/docs-facts.mjs";

describe("canonical skill transaction", () => {
  it("rejects a symlinked skill path without writing outside the requested home", async () => {
    const home = await createTestTempDirectory("rea-skill-symlink-home-");
    const outside = await createTestTempDirectory("rea-skill-symlink-outside-");
    await mkdir(join(home, ".agents"), { recursive: true });
    await symlink(outside, join(home, ".agents/skills"), "dir");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("failed");
    await expect(
      readFile(join(outside, "reverse-engineer-anything/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked nested skill directory without writing through it", async () => {
    const home = await createTestTempDirectory("rea-skill-nested-link-home-");
    const outside = await createTestTempDirectory(
      "rea-skill-nested-link-outside-",
    );
    const skillRoot = join(home, ".agents/skills/reverse-engineer-anything");
    await mkdir(skillRoot, { recursive: true });
    await symlink(outside, join(skillRoot, "references"), "dir");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("failed");
    await expect(
      readFile(join(outside, "native-and-artifacts.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked managed file without changing its target", async () => {
    const home = await createTestTempDirectory("rea-skill-file-link-home-");
    const outside = await createTestTempDirectory(
      "rea-skill-file-link-outside-",
    );
    const skillRoot = join(home, ".agents/skills/reverse-engineer-anything");
    const outsideTarget = join(outside, "SKILL.md");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(outsideTarget, "outside content\n");
    await symlink(outsideTarget, join(skillRoot, "SKILL.md"));

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("failed");
    expect(await readFile(outsideTarget, "utf8")).toBe("outside content\n");
  });

  it("rejects a symlinked backup without changing its target", async () => {
    const home = await createTestTempDirectory("rea-skill-backup-link-home-");
    const outside = await createTestTempDirectory(
      "rea-skill-backup-link-outside-",
    );
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const outsideTarget = join(outside, "preserved.txt");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "stale managed skill\n");
    await writeFile(outsideTarget, "outside content\n");
    await symlink(outsideTarget, `${destination}.rea.backup`);

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("failed");
    expect(await readFile(destination, "utf8")).toBe("stale managed skill\n");
    expect(await readFile(outsideTarget, "utf8")).toBe("outside content\n");
  });
});

describe("canonical skill manifest rejection", () => {
  const digest = "0".repeat(64);
  const manifest = (files: unknown = [{ path: "SKILL.md", sha256: digest }]) =>
    JSON.stringify({
      schema_version: 1,
      skill_name: PRODUCT_IDENTITY.skillName,
      skill_version: PRODUCT_IDENTITY.skillVersion,
      files,
    });

  it.each([
    ["missing manifest fields", "{}"],
    [
      "unsupported schema",
      JSON.stringify({
        schema_version: 2,
        skill_name: PRODUCT_IDENTITY.skillName,
        skill_version: PRODUCT_IDENTITY.skillVersion,
        files: [],
      }),
    ],
    [
      "wrong skill identity",
      JSON.stringify({
        schema_version: 1,
        skill_name: "another-skill",
        skill_version: PRODUCT_IDENTITY.skillVersion,
        files: [],
      }),
    ],
    [
      "wrong skill version",
      JSON.stringify({
        schema_version: 1,
        skill_name: PRODUCT_IDENTITY.skillName,
        skill_version: "0.0.0-invalid",
        files: [],
      }),
    ],
    ["absolute path", manifest([{ path: "/SKILL.md", sha256: digest }])],
    ["parent path", manifest([{ path: "../SKILL.md", sha256: digest }])],
    [
      "empty path segment",
      manifest([{ path: "references//x.md", sha256: digest }]),
    ],
    [
      "backslash path",
      manifest([{ path: "references\\x.md", sha256: digest }]),
    ],
    ["invalid digest", manifest([{ path: "SKILL.md", sha256: "invalid" }])],
    [
      "duplicate path",
      manifest([
        { path: "SKILL.md", sha256: digest },
        { path: "SKILL.md", sha256: digest },
      ]),
    ],
  ])("rejects %s", (_name, content) => {
    expect(() => parseCanonicalSkillBundleManifest(content)).toThrow();
  });
});

describe("canonical skill upgrade and alignment", () => {
  it("backs up and upgrades a stale managed skill without touching siblings", async () => {
    const home = await createTestTempDirectory("rea-skill-test-");
    const destination = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const sibling = join(home, ".agents/skills/unrelated/SKILL.md");
    const nativeGuide = join(
      dirname(destination),
      "references/native-and-artifacts.md",
    );
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(dirname(nativeGuide), { recursive: true });
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(destination, "stale managed skill\n");
    await writeFile(nativeGuide, "stale filesystem-write permission grant\n");
    await writeFile(sibling, "unrelated skill\n");

    expect(await canonicalSkillNeedsInstall(home)).toBe(true);
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect(await readFile(`${destination}.rea.backup`, "utf8")).toBe(
      "stale managed skill\n",
    );
    const installedSkill = await readFile(destination, "utf8");
    expect(installedSkill).toBe(
      await readFile(
        new URL(
          "../../../skills/reverse-engineer-anything/SKILL.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(installedSkill).toContain(
      `version: "${PRODUCT_IDENTITY.skillVersion}"`,
    );
    expect(installedSkill).toContain("call available analysis tools");
    expect(installedSkill).toContain("obtain approval before setup writes");
    expect(await readFile(`${nativeGuide}.rea.backup`, "utf8")).toBe(
      "stale filesystem-write permission grant\n",
    );
    for (const reference of [
      "native-and-artifacts.md",
      "javascript-applications.md",
      "android-applications.md",
      "runtime-observation.md",
      "evidence-workflows.md",
    ]) {
      const installed = await readFile(
        join(dirname(destination), "references", reference),
        "utf8",
      );
      expect(installed).toBe(
        await readFile(
          new URL(
            `../../../skills/reverse-engineer-anything/references/${reference}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(installed).not.toMatch(
        /filesystem-write permission grant|native_mount_approved|only with explicit approval|Obtain the per-call/u,
      );
    }
    expect(installedSkill).toContain(
      "use normal repository tools and do not run REA",
    );
    expect(installedSkill).toContain(
      `tool_count: ${String(TOOL_CONTRACTS.length)}`,
    );
    expect(installedSkill).not.toContain("catalog_digest:");
    expect(await readFile(sibling, "utf8")).toBe("unrelated skill\n");
    expect(
      await readFile(
        join(
          home,
          ".agents/skills/reverse-engineer-anything/references/javascript-applications.md",
        ),
        "utf8",
      ),
    ).toContain("analyze_javascript_application");
    expect(await canonicalSkillNeedsInstall(home)).toBe(false);
    expect(await installCanonicalSkill(home)).toBe("unchanged");
    expect(await skillReferenceIssues(dirname(destination))).toEqual([]);
  });
});

describe("generated skill conformance", () => {
  it("binds portable conformance to the generated skill bytes that setup installs", async () => {
    const home = await createTestTempDirectory("rea-skill-commitment-");
    expect(await installCanonicalSkill(home)).toBe("installed");
    const bundleManifest = z
      .object({
        schema_version: z.literal(1),
        skill_name: z.literal("reverse-engineer-anything"),
        skill_version: z.string().min(1),
        files: z.array(
          z.object({
            path: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            join(
              home,
              ".agents/skills/reverse-engineer-anything/bundle-manifest.json",
            ),
            "utf8",
          ),
        ),
      );
    expect(bundleManifest.skill_version).toBe(PRODUCT_IDENTITY.skillVersion);
    expect(bundleManifest.files.map(({ path }) => path)).toEqual([
      "SKILL.md",
      "references/android-applications.md",
      "references/evidence-workflows.md",
      "references/javascript-applications.md",
      "references/native-and-artifacts.md",
      "references/runtime-observation.md",
    ]);
    const paths = [
      ...bundleManifest.files.map(({ path }) => path),
      "bundle-manifest.json",
    ].sort();
    const records = await Promise.all(
      paths.map(async (path) => {
        const bytes = await readFile(
          join(home, ".agents/skills/reverse-engineer-anything", path),
        );
        return `${path}\0${createHash("sha256").update(bytes).digest("hex")}\n`;
      }),
    );
    const manifest = z
      .object({
        skill_digests: z.array(
          z.object({ skill_id: z.string(), sha256: z.string() }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(
            "docs/verification/managed-conformance-manifest.json",
            "utf8",
          ),
        ),
      );
    expect(manifest.skill_digests).toContainEqual({
      skill_id: "reverse-engineer-anything",
      sha256: createHash("sha256").update(records.join("")).digest("hex"),
    });
  });
});

it("doctor verifies installed instructions and references even when metadata is current", async () => {
  const home = await createTestTempDirectory("rea-skill-doctor-");
  const destination = join(
    home,
    ".agents/skills/reverse-engineer-anything/SKILL.md",
  );
  const reference = join(
    dirname(destination),
    "references/evidence-workflows.md",
  );
  const system = systemDoctorHost({
    environment: { HOME: home, USERPROFILE: home },
  });
  const host = createDoctorHostFixture({
    installedSkillIdentity: () =>
      system.installedSkillIdentity?.() ?? Promise.resolve(undefined),
  });
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "missing",
  );
  expect(await installCanonicalSkill(home)).toBe("installed");
  expect((await runDoctor(undefined, host)).identity?.skill).toMatchObject({
    state: "aligned",
    installed_catalog_digest: null,
  });
  const legacyDigest = "0".repeat(64);
  await writeFile(
    destination,
    (await readFile(destination, "utf8")).replace(
      `  tool_count: ${String(TOOL_CONTRACTS.length)}`,
      `  tool_count: ${String(TOOL_CONTRACTS.length)}\n  catalog_digest: "${legacyDigest}"`,
    ),
  );
  expect((await runDoctor(undefined, host)).identity?.skill).toMatchObject({
    state: "stale",
    installed_catalog_digest: legacyDigest,
  });
  expect(await installCanonicalSkill(home)).toBe("installed");
  for (const path of [destination, reference]) {
    const canonical = await readFile(path, "utf8");
    await writeFile(path, `${canonical}\nLocally changed instructions.\n`);
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "stale",
    );
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "aligned",
    );
  }
  await rm(reference);
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "stale",
  );
  expect(await installCanonicalSkill(home)).toBe("installed");
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "aligned",
  );
});
