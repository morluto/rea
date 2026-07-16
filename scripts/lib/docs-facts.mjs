import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/** Return every caller-visible documentation mismatch against canonical facts. */
export const documentationFactIssues = async (root, catalog) => {
  const issues = [];
  const expectedCounts = catalog.tools.families.map(({ count }) => count);
  for (const path of README_PATHS) {
    const content = await readFile(join(root, path), "utf8");
    requireText(issues, path, content, "MCP-tool_catalog");
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

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  requireText(issues, "AGENTS.md", agents, "docs/product-catalog.json");

  const templatePath = ".github/pull_request_template.md";
  const template = await readFile(join(root, templatePath), "utf8");
  requireText(issues, templatePath, template, "docs/product-catalog.json");

  const english = await readFile(join(root, "README.md"), "utf8");
  const schemaVersion = (id) => {
    const schema = catalog.schemas.find((candidate) => candidate.id === id);
    if (schema === undefined) throw new Error(`Missing ${id} catalog schema`);
    return String(schema.version);
  };
  requireText(
    issues,
    "README.md",
    english,
    `Evidence v${schemaVersion("evidence")}`,
  );
  requireText(
    issues,
    "README.md",
    english,
    `Process Capture v${schemaVersion("process_capture")}`,
  );
  requireText(issues, "README.md", english, "docs/product-catalog.json");
  return issues;
};

/** Fail once with all documentation fact mismatches. */
export const assertDocumentationFacts = async (root, catalog) => {
  const issues = await documentationFactIssues(root, catalog);
  if (issues.length > 0)
    throw new Error(`Documentation facts drifted:\n- ${issues.join("\n- ")}`);
};
