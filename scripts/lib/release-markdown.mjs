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
      wording.push({ kind: "link-open", content: link.href });
    } else if (token.type === "link_close") {
      wording.push({ kind: "link-close" });
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
      if (token.type === "code_inline" || token.type === "html_inline")
        wording.push({ kind: token.type, content: token.content });
      else if (text) wording.push(text);
    }
  }
  return { parts, wording };
}

export function canonicalGitHubReleaseUrl(href) {
  const url = URL.parse(href ?? "");
  return url?.origin === "https://github.com" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
    ? url
    : undefined;
}

/** A link names its repository and target regardless of its display text. */
export function githubReleaseReference(href) {
  const url = canonicalGitHubReleaseUrl(href);
  if (url === undefined) return undefined;
  const match = /^\/([\w.-]+\/[\w.-]+)\/(pull|issues|commit)\/([^/]+)$/u.exec(
    url.pathname,
  );
  if (match === null) return undefined;
  const [, repository, route, target] = match;
  if (route === "commit")
    return /^[a-f0-9]{7,40}$/iu.test(target)
      ? { repository: repository.toLowerCase(), commit: target.toLowerCase() }
      : undefined;
  return /^\d+$/u.test(target)
    ? { repository: repository.toLowerCase(), number: Number(target) }
    : undefined;
}

export function plainReleaseNumbers(prose) {
  return Array.from(prose.matchAll(/(?<![\w/])#(\d+)\b/gu), (match) =>
    Number(match[1]),
  );
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

function migrationProjection(blocks) {
  const chunks = [];
  const literals = new Map();
  const links = [];
  let position = 0;
  let space = false;
  let link;

  function append(text) {
    if (space && position > 0) {
      chunks.push(" ");
      position++;
    }
    space = false;
    if (link) link.start ??= position;
    chunks.push(text);
    position += text.length;
  }

  for (const { wording } of blocks) {
    for (const part of wording) {
      if (typeof part === "string") {
        const prose = part.replace(/\s+/gu, " ");
        if (prose.startsWith(" ")) space = true;
        const text = prose.trim();
        if (text) append(text);
        if (prose.endsWith(" ")) space = true;
      } else if (part.kind === "link-open") {
        link = { href: part.content, start: undefined };
      } else if (part.kind === "link-close") {
        links.push({
          href: link.href,
          start: link.start ?? position,
          end: position,
        });
        link = undefined;
      } else {
        // Markdown-it replaces source NULs. Reserve one position for each
        // literal and compare its kind and exact content at that position.
        append("\0");
        literals.set(position - 1, part);
      }
    }
    space = true;
  }

  return { text: chunks.join(""), literals, links };
}

function linkKey(start, end, href) {
  return JSON.stringify([start, end, href]);
}

/** Match footer prose and literals, then verify links at their label positions. */
export function releaseMigrationWording(blocks) {
  const observed = migrationProjection(blocks);
  const observedLinks = new Set(
    observed.links.map(({ start, end, href }) => linkKey(start, end, href)),
  );
  return (footer) => {
    const tokens = parser.parse(footer, {});
    const expected = migrationProjection(
      tokens
        .map((_token, index) => blockFacts(tokens, index))
        .filter((facts) => facts !== undefined),
    );
    if (expected.text === "" && expected.links.length === 0) return false;

    for (let from = 0; from <= observed.text.length;) {
      const offset = observed.text.indexOf(expected.text, from);
      if (offset === -1) return false;
      const linksMatch = expected.links.every(({ start, end, href }) =>
        observedLinks.has(linkKey(start + offset, end + offset, href)),
      );
      if (linksMatch) {
        const literalsMatch = [...expected.literals].every(
          ([position, part]) => {
            const actual = observed.literals.get(position + offset);
            return (
              actual?.kind === part.kind && actual.content === part.content
            );
          },
        );
        if (literalsMatch) return true;
      }
      from = offset + 1;
    }
    return false;
  };
}
