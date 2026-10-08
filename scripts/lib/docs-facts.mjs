import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const README_PATHS = [
  "README.md",
  "README_zh.md",
  "README_ja.md",
  "README_ko.md",
  "README_ar.md",
];
const tableCounts = (content, path, expectedCounts) => {
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!/^\|\s*-/u.test(line)) continue;
    const counts = [];
    for (const row of lines.slice(index + 1)) {
      if (!row.trim().startsWith("|")) break;
      const count = Number(row.split("|")[2]?.trim());
      if (!Number.isInteger(count)) break;
      counts.push(count);
    }
    if (counts.length === expectedCounts.length) return counts;
  }
  throw new Error(`Missing tool-family inventory table in ${path}`);
};

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

/** Return every caller-visible documentation mismatch against canonical facts. */
export const documentationFactIssues = async (root, catalog) => {
  const issues = await skillReferenceIssues(
    join(root, "skills/reverse-engineer-anything"),
  );
  const expectedCounts = catalog.tools.families.map(({ count }) => count);
  for (const path of README_PATHS) {
    const content = await readFile(join(root, path), "utf8");
    requireText(issues, path, content, "MCP-tool_catalog");
    if (path === "README.md") {
      requireText(issues, path, content, "(docs/installation.md");
      requireText(issues, path, content, "(docs/product-catalog.json)");
      continue;
    }
    for (const client of catalog.setup_clients)
      requireText(issues, path, content, client.display_name);
    try {
      const actualCounts = tableCounts(content, path, expectedCounts);
      if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts))
        issues.push(
          `${path}: tool family counts ${JSON.stringify(actualCounts)} do not match ${JSON.stringify(expectedCounts)}`,
        );
    } catch (cause) {
      issues.push(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const installationPath = "docs/installation.md";
  const installation = await readFile(join(root, installationPath), "utf8");
  for (const client of catalog.setup_clients)
    requireText(issues, installationPath, installation, client.display_name);

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  requireText(issues, "AGENTS.md", agents, "docs/product-catalog.json");

  const templatePath = ".github/pull_request_template.md";
  const template = await readFile(join(root, templatePath), "utf8");
  requireText(issues, templatePath, template, "docs/product-catalog.json");

  return issues;
};

/** Fail once with all documentation fact mismatches. */
export const assertDocumentationFacts = async (root, catalog) => {
  const issues = await documentationFactIssues(root, catalog);
  if (issues.length > 0)
    throw new Error(`Documentation facts drifted:\n- ${issues.join("\n- ")}`);
};
