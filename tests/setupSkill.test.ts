import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCanonicalSkill } from "../src/application/Setup.js";
import { TOOL_CONTRACTS } from "../src/contracts/toolContracts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("canonical skill transaction", () => {
  it("backs up and upgrades a stale managed skill without touching siblings", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-skill-test-"));
    roots.push(home);
    const destination = join(home, ".agents/skills/rea-analysis/SKILL.md");
    const sibling = join(home, ".agents/skills/unrelated/SKILL.md");
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(destination, "stale managed skill\n");
    await writeFile(sibling, "unrelated skill\n");

    expect(await installCanonicalSkill(home)).toBe("installed");
    expect(await readFile(`${destination}.rea.backup`, "utf8")).toBe(
      "stale managed skill\n",
    );
    expect(await readFile(destination, "utf8")).toContain('version: "11"');
    expect(await readFile(destination, "utf8")).toContain(
      `tool_count: ${String(TOOL_CONTRACTS.length)}`,
    );
    expect(await readFile(sibling, "utf8")).toBe("unrelated skill\n");
    expect(await installCanonicalSkill(home)).toBe("unchanged");
  });
});
