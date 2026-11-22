const MAX_QUANTIFIED_REPEAT = 64;

const SYNTAX_ESCAPES = new Set([
  "^",
  "$",
  "\\",
  ".",
  "*",
  "+",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  "/",
]);

const CONTROL_ESCAPES: Readonly<Record<string, number>> = {
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
};

interface Quantifier {
  readonly min: number;
  readonly max: number;
  readonly nextIndex: number;
}

interface GroupIndex {
  readonly groupEnd: Int32Array;
  readonly groupHasAlt: Uint8Array;
  readonly topLevelHasAlt: boolean;
}

interface GroupFrame {
  readonly bodyEnd: number;
  readonly afterGroupIndex: number;
  readonly inline: boolean;
}

const isHexDigit = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

const isEligibleCodePoint = (
  codePoint: number,
  caseSensitive: boolean,
): boolean => {
  // Never emit NUL across C/Python/Java string boundaries.
  if (codePoint <= 0) return false;
  // For case-insensitive pushdown, only ASCII characters are safe across both
  // IDA's ASCII+U+017F/U+212A regex folding and Python's str.casefold().
  if (!caseSensitive) return codePoint <= 0x7f;
  return codePoint < 0xd800 || codePoint > 0xdfff;
};

const skipCharClass = (pattern: string, start: number, end: number): number => {
  let index = start;
  while (index < end) {
    const ch = pattern[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "]") return index + 1;
    index += 1;
  }
  return end;
};

const analyzeRegexGroups = (pattern: string): GroupIndex => {
  const length = pattern.length;
  const groupEnd = new Int32Array(length).fill(-1);
  const groupHasAlt = new Uint8Array(length);
  const stack: number[] = [];
  let index = 0;
  while (index < length) {
    const ch = pattern[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "[") {
      index = skipCharClass(pattern, index + 1, length);
      continue;
    }
    if (ch === "(") {
      stack.push(index);
      index += 1;
      continue;
    }
    if (ch === "|") {
      const top = stack.at(-1);
      if (top === undefined) {
        return { groupEnd, groupHasAlt, topLevelHasAlt: true };
      }
      groupHasAlt[top] = 1;
      index += 1;
      continue;
    }
    if (ch === ")") {
      const open = stack.pop();
      if (open !== undefined) groupEnd[open] = index;
      index += 1;
      continue;
    }
    index += 1;
  }
  return { groupEnd, groupHasAlt, topLevelHasAlt: false };
};

const consumeLazyModifier = (
  pattern: string,
  index: number,
  end: number,
): number => (index < end && pattern[index] === "?" ? index + 1 : index);

const parseQuantifier = (
  pattern: string,
  start: number,
  end: number,
): Quantifier => {
  if (start >= end) return { min: 1, max: 1, nextIndex: start };
  const ch = pattern[start];
  if (ch === "?") {
    return {
      min: 0,
      max: 1,
      nextIndex: consumeLazyModifier(pattern, start + 1, end),
    };
  }
  if (ch === "*") {
    return {
      min: 0,
      max: Infinity,
      nextIndex: consumeLazyModifier(pattern, start + 1, end),
    };
  }
  if (ch === "+") {
    return {
      min: 1,
      max: Infinity,
      nextIndex: consumeLazyModifier(pattern, start + 1, end),
    };
  }
  if (ch === "{") {
    const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(pattern.slice(start, end));
    if (match !== null) {
      const min = Number(match[1]);
      const max =
        match[2] === undefined
          ? min
          : match[2] === ""
            ? Infinity
            : Number(match[2]);
      return {
        min,
        max,
        nextIndex: consumeLazyModifier(pattern, start + match[0].length, end),
      };
    }
  }
  return { min: 1, max: 1, nextIndex: start };
};

const parseHex4 = (
  pattern: string,
  start: number,
  end: number,
): number | undefined => {
  if (start + 4 > end) return undefined;
  for (let offset = 0; offset < 4; offset += 1) {
    if (!isHexDigit(pattern.charCodeAt(start + offset))) return undefined;
  }
  return Number.parseInt(pattern.slice(start, start + 4), 16);
};

const parseEscape = (
  pattern: string,
  start: number,
  end: number,
): { readonly codePoint: number | undefined; readonly nextIndex: number } => {
  const next = pattern[start + 1];
  if (next === undefined) return { codePoint: undefined, nextIndex: end };
  if (SYNTAX_ESCAPES.has(next))
    return { codePoint: next.codePointAt(0), nextIndex: start + 2 };
  const control = CONTROL_ESCAPES[next];
  if (control !== undefined)
    return { codePoint: control, nextIndex: start + 2 };
  if (next === "x" && start + 4 <= end) {
    const hi = pattern.charCodeAt(start + 2);
    const lo = pattern.charCodeAt(start + 3);
    if (isHexDigit(hi) && isHexDigit(lo)) {
      return {
        codePoint: Number.parseInt(pattern.slice(start + 2, start + 4), 16),
        nextIndex: start + 4,
      };
    }
  }
  if (next === "u") {
    if (pattern[start + 2] === "{") {
      const close = pattern.indexOf("}", start + 3);
      if (close !== -1 && close < end) {
        return {
          codePoint: Number.parseInt(pattern.slice(start + 3, close), 16),
          nextIndex: close + 1,
        };
      }
    }
    const first = parseHex4(pattern, start + 2, end);
    if (first !== undefined) {
      if (
        first >= 0xd800 &&
        first <= 0xdbff &&
        pattern[start + 6] === "\\" &&
        pattern[start + 7] === "u"
      ) {
        const second = parseHex4(pattern, start + 8, end);
        if (second !== undefined && second >= 0xdc00 && second <= 0xdfff) {
          return {
            codePoint: ((first - 0xd800) << 10) + (second - 0xdc00) + 0x10000,
            nextIndex: start + 12,
          };
        }
      }
      return { codePoint: first, nextIndex: start + 6 };
    }
  }
  if ((next === "p" || next === "P") && pattern[start + 2] === "{") {
    const close = pattern.indexOf("}", start + 3);
    if (close !== -1 && close < end)
      return { codePoint: undefined, nextIndex: close + 1 };
  }
  if (next === "k" && pattern[start + 2] === "<") {
    const close = pattern.indexOf(">", start + 3);
    if (close !== -1 && close < end)
      return { codePoint: undefined, nextIndex: close + 1 };
  }
  if (next >= "1" && next <= "9") {
    let cursor = start + 2;
    while (cursor < end && pattern[cursor]! >= "0" && pattern[cursor]! <= "9")
      cursor += 1;
    return { codePoint: undefined, nextIndex: cursor };
  }
  if (next === "c" && start + 3 <= end)
    return { codePoint: undefined, nextIndex: start + 3 };
  return { codePoint: undefined, nextIndex: start + 2 };
};

const parseGroupHeader = (
  pattern: string,
  openIndex: number,
  end: number,
): { readonly bodyStart: number; readonly extractable: boolean } => {
  const afterOpen = openIndex + 1;
  if (pattern[afterOpen] !== "?")
    return { bodyStart: afterOpen, extractable: true };
  if (pattern[afterOpen + 1] === ":")
    return { bodyStart: afterOpen + 2, extractable: true };
  if (pattern[afterOpen + 1] === "<") {
    const kind = pattern[afterOpen + 2];
    if (kind === "=" || kind === "!")
      return { bodyStart: afterOpen + 3, extractable: false };
    const close = pattern.indexOf(">", afterOpen + 2);
    if (close !== -1 && close < end)
      return { bodyStart: close + 1, extractable: true };
  }
  // Lookaheads (?=...), (?!...) and ES2025 inline modifiers (?i:...).
  return { bodyStart: afterOpen + 1, extractable: false };
};

const collectRequiredRuns = (
  pattern: string,
  groups: GroupIndex,
  caseSensitive: boolean,
): readonly string[] => {
  const runs: string[] = [];
  const frames: GroupFrame[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      runs.push(current);
      current = "";
    }
  };
  let index = 0;
  while (true) {
    const top = frames.at(-1);
    const limit = top === undefined ? pattern.length : top.bodyEnd;
    if (index >= limit) {
      if (top === undefined) break;
      frames.pop();
      if (!top.inline) flush();
      index = top.afterGroupIndex;
      continue;
    }
    const ch = pattern[index]!;
    if (ch === "^" || ch === "$" || ch === ".") {
      flush();
      index = parseQuantifier(pattern, index + 1, limit).nextIndex;
      continue;
    }
    if (ch === "[") {
      flush();
      const classEnd = skipCharClass(pattern, index + 1, limit);
      index = parseQuantifier(pattern, classEnd, limit).nextIndex;
      continue;
    }
    if (ch === "(") {
      const bodyEnd = groups.groupEnd[index]!;
      const { bodyStart, extractable } = parseGroupHeader(
        pattern,
        index,
        bodyEnd,
      );
      const quantifier = parseQuantifier(pattern, bodyEnd + 1, limit);
      if (
        !extractable ||
        groups.groupHasAlt[index] === 1 ||
        quantifier.min === 0
      ) {
        flush();
        index = quantifier.nextIndex;
        continue;
      }
      const inline = quantifier.min === 1 && quantifier.max === 1;
      if (!inline) flush();
      frames.push({ bodyEnd, afterGroupIndex: quantifier.nextIndex, inline });
      index = bodyStart;
      continue;
    }

    let codePoint: number | undefined;
    let atomEnd: number;
    if (ch === "\\") {
      const escaped = parseEscape(pattern, index, limit);
      codePoint = escaped.codePoint;
      atomEnd = escaped.nextIndex;
    } else {
      codePoint = pattern.codePointAt(index)!;
      atomEnd = index + (codePoint > 0xffff ? 2 : 1);
    }
    const quantifier = parseQuantifier(pattern, atomEnd, limit);
    index = quantifier.nextIndex;
    if (
      codePoint === undefined ||
      !isEligibleCodePoint(codePoint, caseSensitive) ||
      quantifier.min === 0
    ) {
      flush();
      continue;
    }
    const literal = String.fromCodePoint(codePoint);
    if (quantifier.min === 1 && quantifier.max === 1) {
      current += literal;
    } else if (
      quantifier.min === quantifier.max &&
      quantifier.min <= MAX_QUANTIFIED_REPEAT
    ) {
      current += literal.repeat(quantifier.min);
    } else {
      // Break the run whenever characters may vary or repeats exceed the cap so
      // prefix and suffix are never joined across omitted characters.
      const capped = literal.repeat(
        Math.min(quantifier.min, MAX_QUANTIFIED_REPEAT),
      );
      runs.push(current + capped);
      current = capped;
    }
  }
  flush();
  return runs;
};

/**
 * Extract the longest contiguous literal substring that every match of a valid
 * ECMAScript `/u` (or `/iu`) regular expression is guaranteed to contain, or
 * `undefined` when no safe provider-side literal pre-filter can be derived.
 */
export const extractRequiredRegexLiteral = (
  pattern: string,
  caseSensitive: boolean,
): string | undefined => {
  if (pattern.length === 0) return undefined;
  try {
    new RegExp(pattern, caseSensitive ? "u" : "iu");
  } catch {
    return undefined;
  }
  const groups = analyzeRegexGroups(pattern);
  if (groups.topLevelHasAlt) return undefined;
  let longest = "";
  for (const run of collectRequiredRuns(pattern, groups, caseSensitive)) {
    if (run.length > longest.length) longest = run;
  }
  return longest.length > 0 ? longest : undefined;
};
