import MarkdownIt from "markdown-it";

const parser = new MarkdownIt("commonmark");
const proseSeparators = new Set([
  "softbreak",
  "hardbreak",
  "code_inline",
  "html_inline",
  "image",
]);

function inlineFacts(tokens) {
  const parts = [];
  const wording = [];
  let link;
  for (const token of tokens) {
    if (token.type === "link_open") {
      link = { href: token.attrGet("href"), text: "" };
      parts.push(link);
    } else if (token.type === "link_close") {
      link = undefined;
    } else {
      const text =
        token.type === "text"
          ? token.content
          : proseSeparators.has(token.type)
            ? " "
            : "";
      if (link) link.text += text;
      else if (text) parts.push({ text });
      if (token.type === "code_inline")
        wording.push({ kind: "inline-code", content: token.content });
      else if (text) wording.push(text);
    }
  }
  return { parts, wording };
}

const breakingFooter = /^BREAKING(?: CHANGE|-CHANGE):[ \t]*(.*)$/u;
const otherTrailer = /^[A-Za-z][A-Za-z0-9-]*(?::[ \t]| #)/u;

function literalBlockKind(type) {
  if (type === "fence" || type === "code_block") return "code-block";
  if (type === "html_block") return "html-block";
}

function literalBlockLines(lines, start) {
  const covered = new Set();
  for (const { type, map } of parser.parse(lines.slice(start).join("\n"), {})) {
    if (literalBlockKind(type) === undefined) continue;
    for (let line = map[0]; line < map[1]; line++) covered.add(start + line);
  }
  return covered;
}

export function releaseBreakingFooters(body) {
  const lines = body.split(/\r\n?|\n/u);
  if (!lines.some((line) => breakingFooter.test(line))) return [];

  const footers = [];
  let footer;
  let literalLines = literalBlockLines(lines, 0);
  for (const [index, line] of lines.entries()) {
    if (!literalLines.has(index)) {
      const match = breakingFooter.exec(line);
      if (match !== null) {
        footer = { start: index, end: index };
        footers.push(footer);
        // Read the Markdown value from its first character, including a fence
        // that starts on the same line as the trailer label.
        lines[index] = match[1];
        literalLines = literalBlockLines(lines, index);
      } else if (otherTrailer.test(line)) {
        footer = undefined;
      }
    }
    if (
      footer !== undefined &&
      (lines[index].trim() !== "" || literalLines.has(index))
    )
      footer.end = index + 1;
  }
  return footers
    .map(({ start, end }) => lines.slice(start, end).join("\n"))
    .filter((value) => value.trim() !== "");
}

function blockFacts(tokens, index) {
  const { type, content } = tokens[index];
  if (type === "paragraph_open" || type === "heading_open")
    return inlineFacts(tokens[index + 1].children);
  const kind = literalBlockKind(type);
  if (kind !== undefined) {
    // HTML tokens include the line ending after the block when it is present.
    const wording =
      kind === "html-block" ? content.replace(/\n$/u, "") : content;
    return { parts: [], wording: [{ kind, content: wording }] };
  }
}

function releaseVersion({ type, level, tag }, source) {
  if (type === "heading_open" && level === 0 && tag === "h2")
    return /^## \[([^\]]+)\]/u.exec(source.line)?.[1];
}

export function releaseSection(markdown, expectedVersion) {
  // The parser maps block tokens to line intervals. Use the original lines
  // to retain source offsets and publish the selected Markdown verbatim.
  const lines = Array.from(
    markdown.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/gu),
    (match) => ({ line: match[1], offset: match.index }),
  );

  const blocks = [];
  const tokens = parser.parse(markdown, {});
  let start;
  let end = markdown.length;
  let item;
  for (const [index, { type, level, tag, map, markup }] of tokens.entries()) {
    const source = map && lines[map[0]];
    const version = releaseVersion({ type, level, tag }, source);
    if (version !== undefined) {
      if (start !== undefined) {
        end = source.offset;
        break;
      }
      if (version !== expectedVersion) return undefined;
      start = source.offset;
      continue;
    }
    if (start === undefined) continue;
    if (type === "list_item_open" && level === 1 && /^[-*+]$/u.test(markup)) {
      item = source.offset;
    } else if (type === "list_item_close" && level === 1) {
      item = undefined;
    }
    const facts = blockFacts(tokens, index);
    if (facts !== undefined) {
      blocks.push({
        offset: source.offset - start,
        heading:
          type === "heading_open" && level === 0 ? source.line : undefined,
        item: type === "paragraph_open" && level === 2 ? item : undefined,
        ...facts,
      });
    }
  }

  if (start === undefined) return undefined;
  return { source: markdown.slice(start, end), blocks };
}

export function releaseBullets(blocks) {
  const bullets = new Map();
  for (const { item, parts } of blocks) {
    if (item === undefined) continue;
    const bullet = bullets.get(item);
    if (bullet) {
      bullet.push({ text: " " });
      for (const part of parts) bullet.push(part);
    } else {
      bullets.set(item, [...parts]);
    }
  }
  return bullets.values();
}

function normalizeWording(parts) {
  const chunks = [];
  for (const part of parts) {
    if (typeof part === "string" && typeof chunks.at(-1) === "string")
      chunks[chunks.length - 1] += part;
    else chunks.push(part);
  }
  return chunks
    .map((part, index) => {
      if (typeof part !== "string") return part;
      let text = part.replace(/\s+/gu, " ");
      if (index === 0) text = text.trimStart();
      if (index === chunks.length - 1) text = text.trimEnd();
      return text;
    })
    .filter((part) => part !== "");
}

function normalizeBlockWording(blocks) {
  return normalizeWording(blocks.flatMap(({ wording }) => [...wording, " "]));
}

/** Match footer prose and exact literal blocks and code spans within the breaking section. */
export function releaseMigrationWording(blocks) {
  const observed = normalizeBlockWording(blocks);
  return (footer) => {
    const tokens = parser.parse(footer, {});
    const expected = normalizeBlockWording(
      tokens
        .map((_token, index) => blockFacts(tokens, index))
        .filter((facts) => facts !== undefined),
    );
    if (expected.length === 0) return false;
    // The first and last prose chunks can be part of a longer passage.
    // Literal wording must match a complete span or block of the same kind.
    return observed.some((_part, start) =>
      expected.every((part, offset) => {
        const actual = observed[start + offset];
        if (typeof part !== "string")
          return actual?.kind === part.kind && actual.content === part.content;
        if (typeof actual !== "string") return false;
        if (expected.length === 1) return actual.includes(part);
        if (offset === 0) return actual.endsWith(part);
        if (offset === expected.length - 1) return actual.startsWith(part);
        return actual === part;
      }),
    );
  };
}
