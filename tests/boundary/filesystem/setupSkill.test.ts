import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
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
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "preserves an unreadable existing skill instead of treating it as absent",
    async () => {
      const home = await createTestTempDirectory("rea-skill-unreadable-");
      const destination = join(
        home,
        ".agents/skills/reverse-engineer-anything/SKILL.md",
      );
      const original = "existing private skill bytes\n";
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, original, { mode: 0o200 });
      try {
        await chmod(destination, 0o200);
        expect(await installCanonicalSkill(home)).toBe("failed");
      } finally {
        await chmod(destination, 0o600);
      }
      expect(await readFile(destination, "utf8")).toBe(original);
      await expect(
        readFile(`${destination}.rea.backup`, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("installs only the selected Claude Code personal skill", async () => {
    const home = await createTestTempDirectory("rea-claude-skill-");
    const configDirectory = join(home, "claude-config");
    const skillsDirectory = join(configDirectory, "skills");
    const claudeSkill = join(
      skillsDirectory,
      "reverse-engineer-anything/SKILL.md",
    );
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      }),
    );
    const host = systemDoctorHost({
      environment: {
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: configDirectory,
      },
    });

    expect(
      await canonicalSkillNeedsInstall(home, ["claude_code"], {
        CLAUDE_CONFIG_DIR: dirname(skillsDirectory),
      }),
    ).toBe(true);
    expect(
      await installCanonicalSkill(home, ["claude_code"], {
        CLAUDE_CONFIG_DIR: dirname(skillsDirectory),
      }),
    ).toBe("installed");
    expect(
      await canonicalSkillNeedsInstall(home, ["claude_code"], {
        CLAUDE_CONFIG_DIR: dirname(skillsDirectory),
      }),
    ).toBe(false);
    await expect(access(claudeSkill)).resolves.toBeUndefined();
    await expect(
      access(join(home, ".agents/skills/reverse-engineer-anything")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await runDoctor(undefined, host, {
          clients: ["claude_code"],
          skill: true,
        })
      ).identity?.skill.state,
    ).toBe("aligned");
  });

  it("checks selected skill locations for independent drift", async () => {
    const home = await createTestTempDirectory("rea-mixed-skill-");
    const sharedSkill = join(
      home,
      ".agents/skills/reverse-engineer-anything/SKILL.md",
    );
    const claudeSkills = join(home, ".claude", "skills");
    const claudeSkill = join(
      claudeSkills,
      "reverse-engineer-anything/SKILL.md",
    );
    const host = systemDoctorHost({
      environment: { HOME: home, USERPROFILE: home },
    });
    const doctorScope = { clients: ["claude_code", "codex"], skill: true };

    expect(await installCanonicalSkill(home, ["claude_code", "codex"])).toBe(
      "installed",
    );
    await rm(sharedSkill);
    expect(
      (await runDoctor(undefined, host, doctorScope)).identity?.skill.state,
    ).toBe("stale");
    expect(await installCanonicalSkill(home, ["claude_code", "codex"])).toBe(
      "installed",
    );
    for (const skill of [sharedSkill, claudeSkill]) {
      await writeFile(skill, "selected copy changed\n");
      expect(
        (await runDoctor(undefined, host, doctorScope)).identity?.skill.state,
      ).toBe("stale");
      expect(await installCanonicalSkill(home, ["claude_code", "codex"])).toBe(
        "installed",
      );
      expect(
        (await runDoctor(undefined, host, doctorScope)).identity?.skill.state,
      ).toBe("aligned");
    }
  });
});

describe("canonical skill transaction", () => {
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

  it("binds portable conformance to the generated skill bytes that setup installs", async () => {
    const home = await createTestTempDirectory("rea-skill-commitment-");
    expect(await installCanonicalSkill(home)).toBe("installed");
    const paths = [
      "SKILL.md",
      "references/android-applications.md",
      "references/evidence-workflows.md",
      "references/javascript-applications.md",
      "references/native-and-artifacts.md",
      "references/runtime-observation.md",
    ];
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
    installedSkillIdentity: (registrations) =>
      system.installedSkillIdentity?.(registrations) ??
      Promise.resolve(undefined),
  });
  expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
    "missing",
  );
  expect(await installCanonicalSkill(home)).toBe("installed");
  expect((await runDoctor(undefined, host)).identity?.skill).toMatchObject({
    state: "aligned",
  });
  for (const [path, remove] of [
    [destination, false],
    [reference, false],
    [reference, true],
  ] as const) {
    if (remove) await rm(path);
    else await writeFile(path, "Locally changed instructions.\n");
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "stale",
    );
    expect(await installCanonicalSkill(home)).toBe("installed");
    expect((await runDoctor(undefined, host)).identity?.skill.state).toBe(
      "aligned",
    );
  }
});
