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

const findGroupEnd = (
  pattern: string,
  start: number,
  end: number,
): { readonly bodyEnd: number; readonly hasAlternation: boolean } => {
  let depth = 0;
  let hasAlternation = false;
  let index = start;
  while (index < end) {
    const ch = pattern[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === "[") {
      index = skipCharClass(pattern, index + 1, end);
      continue;
    }
    if (ch === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) return { bodyEnd: index, hasAlternation };
      depth -= 1;
      index += 1;
      continue;
    }
    if (ch === "|" && depth === 0) hasAlternation = true;
    index += 1;
  }
  return { bodyEnd: end, hasAlternation };
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

const scanSegment = (
  pattern: string,
  start: number,
  end: number,
  caseSensitive: boolean,
  runs: string[],
  initialCurrent = "",
): string | undefined => {
  let current = initialCurrent;
  const flush = (): void => {
    if (current.length > 0) {
      runs.push(current);
      current = "";
    }
  };
  let index = start;
  while (index < end) {
    const ch = pattern[index]!;
    if (ch === "|") return undefined;
    if (ch === "^" || ch === "$" || ch === ".") {
      flush();
      index = parseQuantifier(pattern, index + 1, end).nextIndex;
      continue;
    }
    if (ch === "[") {
      flush();
      const classEnd = skipCharClass(pattern, index + 1, end);
      index = parseQuantifier(pattern, classEnd, end).nextIndex;
      continue;
    }
    if (ch === "(") {
      const { bodyStart, extractable } = parseGroupHeader(pattern, index, end);
      const { bodyEnd, hasAlternation } = findGroupEnd(pattern, bodyStart, end);
      const quantifier = parseQuantifier(pattern, bodyEnd + 1, end);
      index = quantifier.nextIndex;
      if (!extractable || hasAlternation || quantifier.min === 0) {
        flush();
        continue;
      }
      if (quantifier.min === 1 && quantifier.max === 1) {
        const inner = scanSegment(
          pattern,
          bodyStart,
          bodyEnd,
          caseSensitive,
          runs,
          current,
        );
        if (inner === undefined) {
          flush();
        } else {
          current = inner;
        }
      } else {
        flush();
        const inner = scanSegment(
          pattern,
          bodyStart,
          bodyEnd,
          caseSensitive,
          runs,
          "",
        );
        if (inner !== undefined && inner.length > 0) runs.push(inner);
      }
      continue;
    }

    let codePoint: number | undefined;
    let atomEnd: number;
    if (ch === "\\") {
      const escaped = parseEscape(pattern, index, end);
      codePoint = escaped.codePoint;
      atomEnd = escaped.nextIndex;
    } else {
      codePoint = pattern.codePointAt(index)!;
      atomEnd = index + (codePoint > 0xffff ? 2 : 1);
    }
    const quantifier = parseQuantifier(pattern, atomEnd, end);
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
    } else if (quantifier.min === quantifier.max) {
      current += literal.repeat(
        Math.min(quantifier.min, MAX_QUANTIFIED_REPEAT),
      );
    } else {
      runs.push(
        current +
          literal.repeat(Math.min(quantifier.min, MAX_QUANTIFIED_REPEAT)),
      );
      current = literal;
    }
  }
  return current;
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
  const runs: string[] = [];
  const trailing = scanSegment(pattern, 0, pattern.length, caseSensitive, runs);
  if (trailing === undefined) return undefined;
  if (trailing.length > 0) runs.push(trailing);
  let longest = "";
  for (const run of runs) if (run.length > longest.length) longest = run;
  return longest.length > 0 ? longest : undefined;
};
