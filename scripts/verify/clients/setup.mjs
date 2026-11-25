import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isPathWithinRoot } from "#dist/domain/localPath.js";

/** Verify client setup and return the installed instructions expected in model requests. */
export async function verifyClientSetup({
  client,
  commands,
  runtimeRoot,
  environment,
  workspace,
  lab,
  configPath,
  original,
  skillDirectory,
  checkConfigured,
}) {
  const run = async (command, flag, output) => {
    const result = await commands.exec(
      process.execPath,
      [
        join(runtimeRoot, "scripts/rea.mjs"),
        command,
        "--client",
        client,
        flag,
        "--json",
      ],
      { env: environment, cwd: workspace, timeout: 60_000, stdin: "pipe" },
    );
    if (output !== undefined) await writeFile(join(lab, output), result.stdout);
    return JSON.parse(result.stdout);
  };
  const plan = await run("setup", "--dry-run", "setup-plan.json");
  assert.equal(plan.status, "planned");
  assert(plan.plannedActions.some((action) => action.target === configPath));
  assert(
    plan.plannedActions.some((action) => action.target === skillDirectory),
  );
  assert(
    plan.plannedActions.every(
      (action) =>
        action.target === configPath ||
        (isAbsolute(action.target) &&
          isPathWithinRoot(skillDirectory, action.target)),
    ),
  );

  const applied = await run("setup", "--yes", "setup.json");
  assert.equal(applied.status, "ready");
  const doctor = await run("doctor", "--skill", "doctor.json");
  assert.equal(doctor.healthy, true);

  const backup = `${configPath}.rea.backup`;
  assert.equal(await readFile(backup, "utf8"), original);
  const configured = await readFile(configPath, "utf8");
  checkConfigured(configured);
  const repeated = await run("setup", "--yes");
  assert.deepEqual(repeated.appliedActions, []);
  assert.equal(await readFile(configPath, "utf8"), configured);
  assert.equal(await readFile(backup, "utf8"), original);

  const installedSkill = await readFile(
    join(skillDirectory, "SKILL.md"),
    "utf8",
  );
  assert(installedSkill.includes("name: reverse-engineer-anything"));
  const lines = installedSkill.split("\n");
  const headerEnd = lines.indexOf("---", 1);
  assert(
    lines[0] === "---" && headerEnd > 0,
    "Installed skill must have its authored frontmatter",
  );
  const expectedSkillBody = lines
    .slice(headerEnd + 1)
    .join("\n")
    .trim();
  assert(expectedSkillBody.length > 0);
  return expectedSkillBody;
}
