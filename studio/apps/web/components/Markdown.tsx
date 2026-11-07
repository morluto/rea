import type { ReactNode } from "react";

/** Inline `code` and **bold**, rendered as elements (never raw HTML). */
const inline = (text: string, key: string): ReactNode[] =>
  text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });

/** A small, safe Markdown subset for agent-written notes, specs and reports. */
export const Markdown = ({ source }: { source: string }) => {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  let key = 0;
  const next = () => `b${key++}`;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre key={next()}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const id = next();
      const content = inline(heading[2] ?? "", id);
      blocks.push(
        level === 1 ? <h1 key={id}>{content}</h1> : level === 2 ? <h2 key={id}>{content}</h2> : <h3 key={id}>{content}</h3>,
      );
      index += 1;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      const id = next();
      const children = items.map((item, itemIndex) => (
        <li key={`${id}-${itemIndex}`}>{inline(item, `${id}-${itemIndex}`)}</li>
      ));
      blocks.push(ordered ? <ol key={id}>{children}</ol> : <ul key={id}>{children}</ul>);
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^(#{1,3}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    const id = next();
    blocks.push(<p key={id}>{inline(paragraph.join(" "), id)}</p>);
  }
  return <div className="prose-notes text-sm text-ink">{blocks}</div>;
};
