import { readFile } from "node:fs/promises";
import { join } from "node:path";

const README_PATHS = [
  "README.md",
  "README_zh.md",
  "README_ja.md",
  "README_ko.md",
  "README_ar.md",
];
const familyLabel = (id) => (id === "electron" ? "Electron" : id);

const tableCounts = (content, path, total) => {
  const lines = content.split(/\r?\n/u);
  const headingIndex = lines.findIndex(
    (line) => line.startsWith("## ") && line.includes(String(total)),
  );
  if (headingIndex === -1) {
    throw new Error(`Missing ${total}-tool heading in ${path}`);
  }
  const counts = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.trim().startsWith("|") || /^\|\s*-/u.test(line)) continue;
    const count = Number(line.split("|")[2]?.trim());
    if (!Number.isInteger(count)) {
      if (counts.length === 0) continue;
      throw new Error(`Non-numeric tool count in ${path}`);
    }
    counts.push(count);
  }
  return counts;
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
    requireText(
      issues,
      path,
      content,
      `MCP_tools-${String(catalog.tools.total)}`,
    );
    for (const client of catalog.setup_clients)
      requireText(issues, path, content, client.display_name);
    try {
      const actualCounts = tableCounts(content, path, catalog.tools.total);
      if (JSON.stringify(actualCounts) !== JSON.stringify(expectedCounts))
        issues.push(
          `${path}: tool family counts ${JSON.stringify(actualCounts)} do not match ${JSON.stringify(expectedCounts)}`,
        );
    } catch (cause) {
      issues.push(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const inventory = catalog.tools.families
    .map(({ id, count }) => `${String(count)} ${familyLabel(id)}`)
    .join(", ")
    .replace(/, ([^,]+)$/u, ", and $1");
  const plusInventory = catalog.tools.families
    .map(({ id, count }) => `${String(count)} ${familyLabel(id)}`)
    .join(" + ");
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  requireText(issues, "AGENTS.md", agents, inventory);
  requireText(
    issues,
    "AGENTS.md",
    agents,
    `(${String(catalog.tools.total)} total)`,
  );
  requireText(
    issues,
    "AGENTS.md",
    agents,
    `${String(catalog.tools.total)}-tool target-free MCP server`,
  );
  requireText(issues, "AGENTS.md", agents, "docs/product-catalog.json");

  const templatePath = ".github/pull_request_template.md";
  const template = await readFile(join(root, templatePath), "utf8");
  requireText(
    issues,
    templatePath,
    template,
    `current inventory is ${String(catalog.tools.total)} tools (${plusInventory})`,
  );
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
