import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export const readBaseline = (name) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));

export function countedFindings(context, baseline, messageId) {
  const path = context.physicalFilename ?? context.filename;
  const filename = relative(root, path).replaceAll("\\", "/");
  const nodes = [];
  return {
    filename,
    add(node) {
      nodes.push(node);
    },
    report(program) {
      const allowed = baseline[filename] ?? 0;
      if (nodes.length > allowed) {
        for (const node of nodes) context.report({ node, messageId });
      } else if (nodes.length < allowed) {
        context.report({
          node: program,
          messageId: "stale",
          data: { allowed: String(allowed), actual: String(nodes.length) },
        });
      }
    },
  };
}
