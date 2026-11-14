import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureGeneratedFile } from "./generated-file.mjs";

// Identity fields follow the shared plugin manifest checked for local Cursor
// publication (name, release version, repository, skill, and icon). The
// Marketplace checkout has no dist/, so the server is the pinned npm command
// instead of the bundled launcher.
const CURSOR_PLUGIN_MANIFEST = ".cursor-plugin/plugin.json";
const CURSOR_PLUGIN_MCP = "mcp.json";
const AUTHORED_SKILL_DIRECTORY = ".agents/skills/reverse-engineer-anything";
const CURSOR_PLUGIN_SKILLS = ".cursor-plugin/skills";
const CURSOR_PLUGIN_SKILL = "reverse-engineer-anything";
const CURSOR_PLUGIN_LOGO = "assets/rea-plugin.png";
const CURSOR_PLUGIN_REPOSITORY = "https://github.com/morluto/rea";
const GENERATE_COMMAND = "node scripts/generate-cursor-plugin-skill.mjs";
const INSTALL_LINK_MARKERS = ["install-mcp", "deeplink/mcp", "mcp-install"];

const failure = (code, detail) => {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  return error;
};

const cursorServerArgs = (version) => ["-y", `rea-agents@${version}`, "mcp"];

/** Relative file inventory for one skill directory, in stable order. */
const cursorPluginSkillPaths = async (directory, prefix = "") => {
  const paths = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      paths.push(
        ...(await cursorPluginSkillPaths(
          join(directory, entry.name),
          relativePath,
        )),
      );
    else if (entry.isFile()) paths.push(relativePath);
    else
      throw failure(
        "cursor_plugin_skill_inventory",
        `Skill bundle requires regular files or directories: ${relativePath}`,
      );
  }
  return paths;
};

const skillFrontmatter = (content) => {
  const normalized = content.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) return null;
  const fields = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== "" && fields[key] === undefined) fields[key] = value;
  }
  return fields;
};

/**
 * Structured differences between the Cursor plugin declaration and the
 * package version it must launch. Empty means the manifest, server pin,
 * logo, and skill frontmatter agree.
 */
export const cursorPluginBundleIssues = ({
  manifest,
  mcp,
  packageVersion,
  logoExists,
  skillNames,
  skillFrontmatter: frontmatter,
}) => {
  const issues = [];
  const add = (field) => issues.push({ field });
  if (manifest?.name !== "rea") add("name");
  if (manifest?.version !== packageVersion) add("version");
  if (typeof manifest?.description !== "string" || manifest.description === "")
    add("description");
  if (typeof manifest?.author?.name !== "string" || manifest.author.name === "")
    add("author.name");
  if (manifest?.repository !== CURSOR_PLUGIN_REPOSITORY) add("repository");
  if (typeof manifest?.license !== "string" || manifest.license === "")
    add("license");
  if (
    !Array.isArray(manifest?.keywords) ||
    manifest.keywords.length === 0 ||
    manifest.keywords.some((keyword) => typeof keyword !== "string")
  )
    add("keywords");
  if (manifest?.skills !== CURSOR_PLUGIN_SKILLS) add("skills");
  if (manifest?.logo !== CURSOR_PLUGIN_LOGO) add("logo");
  if (Object.hasOwn(manifest ?? {}, "mcpServers")) add("mcpServers");
  if (logoExists !== true) add("logo.file");
  const server = mcp?.mcpServers?.rea;
  if (
    server?.command !== "npx" ||
    JSON.stringify(server?.args) !==
      JSON.stringify(cursorServerArgs(packageVersion))
  )
    add("mcp.args");
  if (
    !Array.isArray(skillNames) ||
    skillNames.length !== 1 ||
    skillNames[0] !== CURSOR_PLUGIN_SKILL
  )
    add("skills.entries");
  if (frontmatter?.name !== CURSOR_PLUGIN_SKILL) add("skill.name");
  if (
    typeof frontmatter?.description !== "string" ||
    frontmatter.description === ""
  )
    add("skill.description");
  return issues;
};

/** Copy the authored skill into the Marketplace plugin tree, or fail when it drifted. */
export const syncCursorPluginSkill = async ({ root, check }) => {
  const sourceRoot = join(root, AUTHORED_SKILL_DIRECTORY);
  const outputRoot = join(root, CURSOR_PLUGIN_SKILLS, CURSOR_PLUGIN_SKILL);
  const sourcePaths = await cursorPluginSkillPaths(sourceRoot);
  if (sourcePaths === null)
    throw failure(
      "cursor_plugin_skill_inventory",
      `Authored skill is missing: ${AUTHORED_SKILL_DIRECTORY}`,
    );
  if (!check) await rm(outputRoot, { recursive: true, force: true });
  for (const relativePath of sourcePaths) {
    const source = (
      await readFile(join(sourceRoot, relativePath), "utf8")
    ).replaceAll("\r\n", "\n");
    if (!check)
      await mkdir(dirname(join(outputRoot, relativePath)), { recursive: true });
    try {
      await ensureGeneratedFile({
        path: join(outputRoot, relativePath),
        source,
        check,
        generateCommand: GENERATE_COMMAND,
      });
    } catch (cause) {
      throw failure(
        "cursor_plugin_skill_stale",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }
  const outputPaths = await cursorPluginSkillPaths(outputRoot);
  if (
    outputPaths === null ||
    JSON.stringify(outputPaths) !== JSON.stringify(sourcePaths)
  )
    throw failure(
      "cursor_plugin_skill_inventory",
      "Cursor plugin skill inventory drifted; run node scripts/generate-cursor-plugin-skill.mjs",
    );
};

/** Read the committed plugin and report structured contract issues. */
export const inspectCursorPluginBundle = async (root) => {
  const manifest = JSON.parse(
    await readFile(join(root, CURSOR_PLUGIN_MANIFEST), "utf8"),
  );
  const mcp = JSON.parse(await readFile(join(root, CURSOR_PLUGIN_MCP), "utf8"));
  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const logoExists = await stat(join(root, CURSOR_PLUGIN_LOGO))
    .then((metadata) => metadata.isFile())
    .catch((cause) => {
      if (cause?.code === "ENOENT") return false;
      throw cause;
    });
  const skillDirectory = join(root, CURSOR_PLUGIN_SKILLS);
  const skillNames = await readdir(skillDirectory);
  const skillContent = await readFile(
    join(skillDirectory, CURSOR_PLUGIN_SKILL, "SKILL.md"),
    "utf8",
  );
  return {
    manifest,
    mcp,
    packageVersion: packageJson.version,
    issues: cursorPluginBundleIssues({
      manifest,
      mcp,
      packageVersion: packageJson.version,
      logoExists,
      skillNames,
      skillFrontmatter: skillFrontmatter(skillContent),
    }),
  };
};

/** MCP-only install links omit the skill, so Marketplace docs must not carry them. */
export const cursorMarketplaceInstallLinkIssues = (documents) =>
  documents.flatMap(({ path, text }) =>
    INSTALL_LINK_MARKERS.filter((marker) => text.includes(marker)).map(
      (marker) => ({ path, marker }),
    ),
  );
