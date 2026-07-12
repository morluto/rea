#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Collect all TS, MJS, and Python source files, excluding generated and third-party dirs.
const sourceFiles = [
  ...globSync("src/**/*.ts", {
    cwd: root,
    nodir: true,
    ignore: ["dist/**", "node_modules/**"],
  }),
  ...globSync("tests/**/*.ts", {
    cwd: root,
    nodir: true,
    ignore: ["node_modules/**"],
  }),
  ...globSync("scripts/**/*.mjs", { cwd: root, nodir: true }),
  ...globSync("bridge/**/*.py", { cwd: root, nodir: true }),
];

const patterns = [
  { regex: /TODO(?::\s*(.*))?$/gm, label: "TODO" },
  { regex: /FIXME(?::\s*(.*))?$/gm, label: "FIXME" },
  { regex: /HACK(?::\s*(.*))?$/gm, label: "HACK" },
];

let count = 0;

for (const file of sourceFiles) {
  const content = readFileSync(resolve(root, file), "utf-8");
  for (const { regex, label } of patterns) {
    for (const match of content.matchAll(regex)) {
      const comment = (match[1] ?? "").trim();
      const line = content.slice(0, match.index).split("\n").length;
      console.log(
        `${relative(root, resolve(root, file))}:${line}: ${label}${comment ? ` - ${comment}` : ""}`,
      );
      count++;
    }
  }
}

if (count > 0) {
  console.log(`\n${count} tech-debt marker(s) found.`);
  process.exitCode = 0;
} else {
  console.log("No tech-debt markers found.");
}
