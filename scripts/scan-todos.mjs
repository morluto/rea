#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
    return (ast.comments ?? []).map(({ type, start, end }) => [
      start ?? 0,
      (end ?? 0) - (type === "CommentBlock" ? 2 : 0),
    ]);
  } catch {
    // An unparsable file keeps the scan conservative: every marker counts.
    return undefined;
  }
};

const PYTHON_COMMENT_READER = String.raw`
import io
import json
import sys
import tokenize

if sys.version_info < (3, 12):
    sys.exit(1)

def width(text):
    return len(text.encode("utf-16-le")) // 2

source = sys.stdin.read()
lines = source.split("\n")
offsets = [0]
for line in lines:
    offsets.append(offsets[-1] + width(line) + 1)

ranges = []
for token in tokenize.generate_tokens(io.StringIO(source).readline):
    if token.type == tokenize.COMMENT:
        line, column = token.start
        start = offsets[line - 1] + width(lines[line - 1][:column])
        ranges.append((start, start + width(token.string)))
print(json.dumps(ranges))
`;

/** Python 3.12+ exposes comments within f-string replacement expressions. */
const pythonCommentRanges = (content) => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", "-B", "-X", "utf8", "-c", PYTHON_COMMENT_READER],
    { input: content, encoding: "utf8", windowsHide: true },
  );
  // Preserve the scan's conservative behavior without a suitable interpreter
  // or when tokenization fails, so an unavailable tool cannot hide debt.
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
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

/** Comment ranges in Java source, skipping quoted strings and text blocks. */
const javaCommentRanges = (content) => {
  // Java expands Unicode escapes before lexing, so raw delimiters alone cannot
  // reliably classify markers in files with these escapes.
  if (/\\u+[0-9a-fA-F]{4}/u.test(content)) return undefined;
  const ranges = [];
  let index = 0;
  while (index < content.length) {
    if (content.startsWith('"""', index)) {
      index = quotedEnd(content, index, '"""', true);
      continue;
    }
    if (content[index] === '"' || content[index] === "'") {
      index = quotedEnd(content, index, content[index], false);
      continue;
    }
    if (content.startsWith("//", index)) {
      const newline = content.indexOf("\n", index);
      const end = newline === -1 ? content.length : newline;
      ranges.push([index, end]);
      index = end;
      continue;
    }
    if (content.startsWith("/*", index)) {
      const close = content.indexOf("*/", index + 2);
      ranges.push([index, close === -1 ? content.length : close]);
      index = close === -1 ? content.length : close + 2;
      continue;
    }
    index += 1;
  }
  return ranges;
};

/** Comment ranges for this file, or `undefined` when the language is unknown. */
const commentRanges = (content, extension) => {
  if (JAVASCRIPT_EXTENSIONS.has(extension))
    return javaScriptCommentRanges(content, extension);
  if (extension === ".py") return pythonCommentRanges(content);
  if (extension === ".java") return javaCommentRanges(content);
  return undefined;
};

/** The body end of the comment at `offset`, if one of the ranges contains it. */
const containingCommentEnd = (ranges, offset) => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (offset < start) high = middle - 1;
    else if (offset >= end) low = middle + 1;
    else return end;
  }
  return undefined;
};

let count = 0;

for (const file of sourceFiles) {
  const content = readFileSync(resolve(root, file), "utf-8").replace(
    /\r\n?/gu,
    "\n",
  );
  if (content.search(MARKER) === -1) continue;
  const ranges = commentRanges(content, extname(file));
  let lineNumber = 0;
  let lineStart = 0;
  for (const line of content.split("\n")) {
    lineNumber += 1;
    for (const match of line.matchAll(MARKER)) {
      const index = match.index ?? 0;
      // A marker is debt when it sits in a comment. Quoted sample, fixture and
      // expected-output text is data, so the parse decides what is a comment.
      const commentEnd =
        ranges === undefined
          ? lineStart + line.length
          : containingCommentEnd(ranges, lineStart + index);
      if (commentEnd === undefined) continue;
      const rest = line
        .slice(index + match[0].length, commentEnd - lineStart)
        .trimEnd();
      if (rest !== "" && !rest.startsWith(":")) continue;
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
