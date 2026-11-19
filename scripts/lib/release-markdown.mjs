import MarkdownIt from "markdown-it";

const parser = new MarkdownIt("commonmark");
const nonProseBlocks = new Set(["fence", "code_block", "html_block"]);

export function releaseSection(markdown, expectedVersion) {
  // The parser maps block tokens to line intervals. Use the original lines
  // to retain source offsets and publish the selected Markdown verbatim.
  const lines = Array.from(
    markdown.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/gu),
    (match, index) => ({ line: match[1], offset: match.index, index }),
  );

  const excluded = new Set();
  let start;
  let end = lines.length;
  for (const { type, level, tag, map } of parser.parse(markdown, {})) {
    if (!map) continue;
    const [first, limit] = map;
    if (nonProseBlocks.has(type)) {
      for (let index = first; index < limit; index++) excluded.add(index);
      continue;
    }
    if (type !== "heading_open" || level !== 0 || tag !== "h2") continue;
    const version = /^## \[([^\]]+)\]/u.exec(lines[first].line)?.[1];
    if (version === undefined) continue;
    if (start !== undefined) {
      end = first;
      break;
    }
    if (version !== expectedVersion) return undefined;
    start = first;
  }

  if (start === undefined) return undefined;
  const sectionOffset = lines[start].offset;
  return {
    source: markdown.slice(
      sectionOffset,
      lines[end]?.offset ?? markdown.length,
    ),
    lines: lines
      .slice(start, end)
      .filter(({ index }) => !excluded.has(index))
      .map(({ line, offset }) => ({ line, offset: offset - sectionOffset })),
  };
}
