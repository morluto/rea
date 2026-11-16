#!/usr/bin/env node

import { globSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { parse } from "@babel/parser";

const root = resolve(import.meta.dirname, "..");

// Native globSync is available throughout the Node versions in package.engines.
// Its exclusion option is `exclude`; `ignore` and `nodir` belong to npm glob.
const sourceFiles = globSync(
  [
    "src/**/*.ts",
    "tests/**/*.ts",
    "scripts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
    "bridge/**/*.py",
    "bridge/**/*.java",
  ],
  {
    cwd: root,
    exclude: (path) => path.split(/[\\/]/u).includes("node_modules"),
  },
);

// A marker owns the rest of its line when nothing follows it or a colon does,
// which is the report the scan has always made.
const MARKER = /\b(?:TODO|FIXME|HACK)\b/gu;

const JAVASCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

/** Character ranges of the comments Babel parsed, or `undefined` when it cannot. */
const javaScriptCommentRanges = (content, extension) => {
  try {
    const ast = parse(content, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: [
        ...(extension === ".tsx" || extension === ".jsx" ? ["jsx"] : []),
        ...([".cts", ".mts", ".ts", ".tsx"].includes(extension)
          ? ["typescript"]
          : []),
      ],
    });
    return (ast.comments ?? []).map(({ start, end }) => [start ?? 0, end ?? 0]);
  } catch {
    // An unparsable file keeps the scan conservative: every marker counts.
    return undefined;
  }
};

/** Where a quoted string starting at `start` ends, honouring escapes. */
const quotedEnd = (content, start, delimiter, multiline) => {
  let index = start + delimiter.length;
  while (index < content.length) {
    if (content[index] === "\\") {
      index += 2;
      continue;
    }
    if (content.startsWith(delimiter, index)) return index + delimiter.length;
    if (!multiline && content[index] === "\n") return index;
    index += 1;
  }
  return content.length;
};

/**
 * Comment ranges for a language without a parser in this repository. Strings,
 * including Python's triple-quoted form and Java text blocks, are skipped so a
 * quoted sample never looks like a comment and a comment is never skipped.
 */
const scannedCommentRanges = (
  content,
  { lineComments, blockComments, quotes, tripleQuotes },
) => {
  const ranges = [];
  let index = 0;
  while (index < content.length) {
    const triple = tripleQuotes.find((quote) =>
      content.startsWith(quote, index),
    );
    if (triple !== undefined) {
      index = quotedEnd(content, index, triple, true);
      continue;
    }
    if (quotes.includes(content[index])) {
      index = quotedEnd(content, index, content[index], false);
      continue;
    }
    const lineComment = lineComments.find((comment) =>
      content.startsWith(comment, index),
    );
    if (lineComment !== undefined) {
      const newline = content.indexOf("\n", index);
      const end = newline === -1 ? content.length : newline;
      ranges.push([index, end]);
      index = end;
      continue;
    }
    const block = blockComments.find(([open]) =>
      content.startsWith(open, index),
    );
    if (block !== undefined) {
      const close = content.indexOf(block[1], index + block[0].length);
      const end = close === -1 ? content.length : close + block[1].length;
      ranges.push([index, end]);
      index = end;
      continue;
    }
    index += 1;
  }
  return ranges;
};

const PYTHON_SYNTAX = {
  lineComments: ["#"],
  blockComments: [],
  quotes: ["'", '"'],
  tripleQuotes: ["'''", '"""'],
};

const JAVA_SYNTAX = {
  lineComments: ["//"],
  blockComments: [["/*", "*/"]],
  quotes: ["'", '"'],
  tripleQuotes: ['"""'],
};

/** Comment ranges for this file, or `undefined` when the language is unknown. */
const commentRanges = (content, extension) => {
  if (JAVASCRIPT_EXTENSIONS.has(extension))
    return javaScriptCommentRanges(content, extension);
  if (extension === ".py") return scannedCommentRanges(content, PYTHON_SYNTAX);
  if (extension === ".java") return scannedCommentRanges(content, JAVA_SYNTAX);
  return undefined;
};

/** Whether `offset` falls inside one of the sorted, disjoint `ranges`. */
const insideComment = (ranges, offset) => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (offset < start) high = middle - 1;
    else if (offset >= end) low = middle + 1;
    else return true;
  }
  return false;
};

let count = 0;

for (const file of sourceFiles) {
  const content = readFileSync(resolve(root, file), "utf-8");
  const ranges = commentRanges(content, extname(file));
  let lineNumber = 0;
  let lineStart = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    for (const match of line.matchAll(MARKER)) {
      const rest = line.slice((match.index ?? 0) + match[0].length);
      if (rest !== "" && !rest.startsWith(":")) continue;
      // A marker is debt when it sits in a comment. Quoted sample, fixture and
      // expected-output text is data, so the parse decides what is a comment.
      if (
        ranges !== undefined &&
        !insideComment(ranges, lineStart + (match.index ?? 0))
      )
        continue;
      const comment = rest.startsWith(":") ? rest.slice(1).trim() : "";
      console.log(
        `${relative(root, resolve(root, file))}:${lineNumber}: ${match[0]}${comment ? ` - ${comment}` : ""}`,
      );
      count++;
    }
    lineStart += line.length + 1;
  }
}

if (count > 0) {
  console.log(`\n${count} tech-debt marker(s) found.`);
  process.exitCode = 1;
} else {
  console.log("No tech-debt markers found.");
}
