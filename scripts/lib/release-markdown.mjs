// Release metadata uses top-level headings and bullets. Keep source offsets
// so the selected changelog section can be published with its examples intact.
export function* releaseProseLines(markdown) {
  let fence;
  for (const match of markdown.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/gu)) {
    const [, line] = match;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/su.exec(line);
    if (marker) {
      const [, run, rest] = marker;
      if (!fence) {
        if (run[0] === "~" || !rest.includes("`")) fence = run;
      } else if (
        run[0] === fence[0] &&
        run.length >= fence.length &&
        /^[ \t]*$/u.test(rest)
      ) {
        fence = undefined;
      }
      continue;
    }
    if (!fence) yield { line, offset: match.index };
  }
}

export function releaseSection(markdown, expectedVersion) {
  let start;
  for (const { line, offset } of releaseProseLines(markdown)) {
    const version = /^## \[([^\]]+)\]/u.exec(line)?.[1];
    if (version === undefined) continue;
    if (start !== undefined) return markdown.slice(start, offset);
    if (version !== expectedVersion) return undefined;
    start = offset;
  }
  return start === undefined ? undefined : markdown.slice(start);
}
