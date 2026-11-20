import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRelative = (root, from, target) => {
  const index = target.search(/[#?]/u);
  const pathPart = index === -1 ? target : target.slice(0, index);
  const suffix = index === -1 ? "" : target.slice(index);
  if (pathPart.length === 0 || /^[a-z][a-z0-9+.-]*:/iu.test(pathPart))
    return target;
  const absolute = resolve(root, dirname(from), pathPart);
  const withinRepo = relative(root, absolute);
  if (
    withinRepo === ".." ||
    withinRepo.startsWith(`..${sep}`) ||
    isAbsolute(withinRepo)
  )
    return target;
  return `${withinRepo.split(sep).join("/")}${suffix}`;
};

const isLanguageNavigation = (target) => {
  const path = target.split(/[#?]/u)[0];
  return (
    path === "README.md" ||
    /^docs\/readme\/README_[A-Za-z0-9-]+\.md$/u.test(path)
  );
};

const readmeDestinations = (content) => [
  ...content.matchAll(/\]\(([^)\s]+)\)/gu),
  ...content.matchAll(/\b(?:src|href)="([^"]+)"/gu),
];

const readmeLinkTargets = (root, from, content, language = "en") =>
  readmeDestinations(content)
    .map((match) => repoRelative(root, from, match[1] ?? ""))
    .filter(
      (target) => !target.startsWith("#") && !isLanguageNavigation(target),
    )
    .map((target) => {
      if (language === "en" || !URL.canParse(target)) return target;
      const url = new URL(target);
      const prefix = `/${language}/`;
      if (
        url.origin !== "https://rea.tools" ||
        !url.pathname.startsWith(prefix)
      )
        return target;
      url.pathname = url.pathname.slice(prefix.length - 1);
      return url.href;
    })
    .sort();

const requireText = (issues, path, content, expected) => {
  if (!content.includes(expected)) issues.push(`${path}: missing ${expected}`);
};

/** Check that local Markdown references travel with an installed skill bundle. */
export const skillReferenceIssues = async (skillRoot) => {
  const issues = [];
  const paths = (await readdir(skillRoot, { recursive: true }))
    .filter((path) => path.endsWith(".md"))
    .sort();
  for (const path of paths) {
    const content = await readFile(join(skillRoot, path), "utf8");
    for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/gu)) {
      const destination = match[1];
      if (/^(?:https?:\/\/|mailto:|#)/u.test(destination)) continue;
      const target = resolve(
        dirname(join(skillRoot, path)),
        destination.split("#")[0],
      );
      const withinBundle = relative(resolve(skillRoot), target);
      if (
        withinBundle === ".." ||
        withinBundle.startsWith(`..${sep}`) ||
        isAbsolute(withinBundle)
      ) {
        issues.push(
          `${path}: reference escapes installed skill bundle: ${destination}`,
        );
        continue;
      }
      try {
        if (!(await stat(target)).isFile())
          issues.push(`${path}: reference is not a file: ${destination}`);
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
        issues.push(`${path}: missing skill reference: ${destination}`);
      }
    }
  }
  return issues;
};

// Living prose that would restate the catalog size. Dated records keep the
// count they measured in release notes and verification records.
export const LIVING_PROSE_ROOTS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "docs",
  ".agents/skills",
  "website/public",
];
const SKIPPED_PROSE = /^docs\/(?:releases|verification|\.vitepress\/dist)\//u;
const PROSE_FILE = /\.(?:md|html)$/u;
// A count of ten or more tools, such as "240 tools" or "all 1,024 MCP tools".
const LITERAL_TOOL_COUNT =
  /\b[1-9]\d*(?:,\d{3})*\s+(?:(?:REA|public|MCP|canonical|registered|advertised|available)\s+)*tools\b/giu;

/** Whether the literal tool count check scans this repository-relative path. */
export const isLivingProsePath = (path) =>
  PROSE_FILE.test(path) &&
  !SKIPPED_PROSE.test(path) &&
  LIVING_PROSE_ROOTS.some(
    (start) => path === start || path.startsWith(`${start}/`),
  );

const proseFiles = async (root) => {
  const files = [];
  const walk = async (path) => {
    if (SKIPPED_PROSE.test(`${path}/`)) return;
    for (const entry of await readdir(join(root, path), {
      withFileTypes: true,
    })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && isLivingProsePath(child)) files.push(child);
    }
  };
  for (const start of LIVING_PROSE_ROOTS) {
    try {
      if ((await stat(join(root, start))).isDirectory()) await walk(start);
      else if (isLivingProsePath(start)) files.push(start);
    } catch (cause) {
      if (cause?.code === "ENOENT") continue;
      throw cause;
    }
  }
  return files.sort();
};

/**
 * Refuse a literal tool count in living prose. The catalog owns the count
 * (docs/public/product-catalog.json), and every hand-written copy goes stale
 * when a tool is added.
 */
export const literalToolCountIssues = async (root) => {
  const issues = [];
  for (const path of await proseFiles(root)) {
    const content = await readFile(join(root, path), "utf8");
    for (const match of content.matchAll(LITERAL_TOOL_COUNT)) {
      if (Number(match[0].split(/\s/u)[0].replaceAll(",", "")) < 10) continue;
      const line = content.slice(0, match.index).split("\n").length;
      issues.push(
        `${path}:${line}: literal tool count "${match[0]}"; link the generated catalog instead`,
      );
    }
  }
  return issues;
};

/** Return every caller-visible documentation mismatch against canonical facts. */
export const documentationFactIssues = async (root, catalog) => {
  const issues = [
    ...(await skillReferenceIssues(
      join(root, "skills/reverse-engineer-anything"),
    )),
    ...(await literalToolCountIssues(root)),
  ];
  const translatedFolder = join(root, "docs/readme");
  let translatedNames = [];
  try {
    translatedNames = await readdir(translatedFolder);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  const readmePaths = [
    "README.md",
    ...translatedNames
      .filter((name) => /^README_[A-Za-z0-9-]+\.md$/u.test(name))
      .map((name) => `docs/readme/${name}`),
  ].sort();
  const readmes = new Map();
  for (const path of readmePaths) {
    const content = await readFile(join(root, path), "utf8");
    readmes.set(path, content);
    requireText(issues, path, content, "MCP-tool_catalog");
    if (path === "README.md") {
      requireText(
        issues,
        path,
        content,
        "(docs/getting-started/installation.md#supported-agents)",
      );
      requireText(
        issues,
        path,
        content,
        "(docs/getting-started/installation.md#mcp-registry)",
      );
      requireText(
        issues,
        path,
        content,
        "(docs/reference/mcp-contracts.md#generated-catalog)",
      );
    }
  }
  const canonicalLinks = readmeLinkTargets(
    root,
    "README.md",
    readmes.get("README.md") ?? "",
  );
  const languageInventory = JSON.parse(
    await readFile(join(root, "website/locales/languages.json"), "utf8"),
  );
  const readmeLanguages = new Map(
    languageInventory.map(({ readme, code }) => [readme, code]),
  );
  for (const path of readmePaths.filter((path) => path !== "README.md"))
    if (
      JSON.stringify(
        readmeLinkTargets(
          root,
          path,
          readmes.get(path) ?? "",
          readmeLanguages.get(path),
        ),
      ) !== JSON.stringify(canonicalLinks)
    )
      issues.push(`${path}: documentation links differ from README.md`);

  const installationPath = "docs/getting-started/installation.md";
  const installation = await readFile(join(root, installationPath), "utf8");
  for (const client of catalog.setup_clients)
    requireText(issues, installationPath, installation, client.display_name);

  // Setup accepts every catalog client ID, so the skill's registration repair
  // list must name each one for an agent choosing a `--client` value.
  const repairPath =
    ".agents/skills/reverse-engineer-anything/references/connection-and-recovery.md";
  const repair = await readFile(join(root, repairPath), "utf8");
  for (const client of catalog.setup_clients)
    requireText(issues, repairPath, repair, `\`${client.id}\``);

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  requireText(issues, "AGENTS.md", agents, "docs/public/product-catalog.json");

  const templatePath = ".github/pull_request_template.md";
  const template = await readFile(join(root, templatePath), "utf8");
  requireText(
    issues,
    templatePath,
    template,
    "docs/public/product-catalog.json",
  );

  return issues;
};

/** Fail once with all documentation fact mismatches. */
export const assertDocumentationFacts = async (root, catalog) => {
  const issues = await documentationFactIssues(root, catalog);
  if (issues.length > 0)
    throw new Error(`Documentation facts drifted:\n- ${issues.join("\n- ")}`);
};
