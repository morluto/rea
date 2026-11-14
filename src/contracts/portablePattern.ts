import { portablePatternViolations } from "./advertisedDialect.js";

/**
 * An advertised `pattern` re-emitted into the portable regex grammar.
 * `exact` matches the same strings as the source under ECMAScript `u`
 * semantics, `wider` matches a superset, and `unexpressible` has neither form
 * (a backreference, for example), so the advertisement must omit it. Server
 * validation keeps the canonical expression either way.
 */
export type PortablePatternProjection =
  | { readonly kind: "exact"; readonly pattern: string }
  | { readonly kind: "wider"; readonly pattern: string }
  | { readonly kind: "unexpressible" };

class Unexpressible extends Error {}

// Any string, as runs separated by NUL. A single-class loop keeps V8 from
// recording one backtracking frame per character on large inputs.
const ANY_STRING = "[^\\x00]*(?:\\x00[^\\x00]*)*";
const ANY_CHARACTER = "(?:[^\\x00]|\\x00)";
const NON_ASCII = "[^\\x00-\\x7f]";
const ALNUM = /^[A-Za-z0-9]$/u;
const LITERAL_OUTSIDE_CLASS = new Set("_ !#%&,:;<=>@`~'\"-");
const ESCAPED_OUTSIDE_CLASS = new Set("^$\\.*+?()[]{}|/");
const LITERAL_IN_CLASS = new Set("!#%&,:;<=>@`~'\" _.+*?$");
const ESCAPED_IN_CLASS = new Set("^$\\.*+?()[]{}|/-");
const MAX_REPEAT = 1000;

const hex = (code: number) => `\\x${code.toString(16).padStart(2, "0")}`;

const emitOutside = (code: number): string => {
  const character = String.fromCodePoint(code);
  if (ALNUM.test(character) || LITERAL_OUTSIDE_CLASS.has(character))
    return character;
  if (ESCAPED_OUTSIDE_CLASS.has(character)) return `\\${character}`;
  return hex(code);
};

const emitInClass = (code: number, rangeEndpoint: boolean): string => {
  const character = String.fromCodePoint(code);
  if (ALNUM.test(character)) return character;
  // A punctuator that starts a range is read as a literal followed by `-` in
  // some engines, so range endpoints use the hexadecimal form.
  if (!rangeEndpoint && LITERAL_IN_CLASS.has(character)) return character;
  if (!rangeEndpoint && ESCAPED_IN_CLASS.has(character))
    return `\\${character}`;
  return hex(code);
};

/** ASCII members as merged ranges, emitted without repeated punctuators. */
const emitAsciiMembers = (members: ReadonlySet<number>): string => {
  const sorted = [...members].sort((left, right) => left - right);
  let emitted = "";
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1)
      end++;
    const first = sorted[index]!;
    const last = sorted[end]!;
    if (last - first >= 2)
      emitted += `${emitInClass(first, true)}-${emitInClass(last, true)}`;
    else
      for (let code = first; code <= last; code++)
        emitted += emitInClass(code, false);
    index = end + 1;
  }
  return emitted;
};

/** Non-ASCII membership of a class, as far as it changes the projection. */
type NonAscii = "none" | "some" | "all";

const unionNonAscii = (left: NonAscii, right: NonAscii): NonAscii =>
  left === "all" || right === "all"
    ? "all"
    : left === "some" || right === "some"
      ? "some"
      : "none";

const ASCII_CODES = Array.from({ length: 0x80 }, (_, code) => code);

/**
 * Re-emit one character class, given its exact ASCII members (computed with
 * V8 itself) and how much of the non-ASCII range it contains.
 */
const emitClass = (
  ascii: ReadonlySet<number>,
  nonAscii: NonAscii,
  negated: boolean,
  widen: () => void,
): string => {
  if (nonAscii === "some") widen();
  if (!negated) {
    if (nonAscii === "none") {
      if (ascii.size === 0) throw new Unexpressible();
      return `[${emitAsciiMembers(ascii)}]`;
    }
    return ascii.size === 0
      ? NON_ASCII
      : `(?:[${emitAsciiMembers(ascii)}]|${NON_ASCII})`;
  }
  if (nonAscii === "all") {
    const rest = new Set(ASCII_CODES.filter((code) => !ascii.has(code)));
    if (rest.size === 0) throw new Unexpressible();
    return `[${emitAsciiMembers(rest)}]`;
  }
  // A negated class keeps every non-ASCII character it does not name; with
  // "some" named, admitting all of them only widens.
  return ascii.size === 0 ? ANY_CHARACTER : `[^${emitAsciiMembers(ascii)}]`;
};

const SHORTHAND_NON_ASCII: Readonly<Record<string, NonAscii>> = {
  d: "none",
  w: "none",
  s: "some",
  D: "all",
  W: "all",
  S: "some",
};

class Projector {
  #index = 0;
  #wider = false;

  constructor(private readonly source: string) {}

  project(): {
    readonly kind: "exact" | "wider";
    readonly pattern: string;
  } {
    const alternatives = this.#disjunction();
    if (this.#index !== this.source.length) throw new Unexpressible();
    // A search for an unanchored alternative is a full match of the same
    // alternative between two arbitrary strings.
    const completed = alternatives.map((terms) => {
      const first = terms[0] === "^" ? 1 : 0;
      const anchoredEnd = terms.length > first && terms.at(-1) === "$";
      const body = terms.slice(first, anchoredEnd ? -1 : undefined).join("");
      return `${first === 1 ? "" : ANY_STRING}${body}${anchoredEnd ? "" : ANY_STRING}`;
    });
    const pattern =
      completed.length === 1
        ? `^${completed[0]!}$`
        : `^(?:${completed.join("|")})$`;
    return { kind: this.#wider ? "wider" : "exact", pattern };
  }

  #peek(offset = 0): string {
    return this.source[this.#index + offset] ?? "";
  }

  #widen = (): void => {
    this.#wider = true;
  };

  #disjunction(): string[][] {
    const alternatives = [this.#alternative()];
    while (this.#peek() === "|") {
      this.#index++;
      alternatives.push(this.#alternative());
    }
    return alternatives;
  }

  #group(): string {
    return this.#disjunction()
      .map((terms) => terms.join(""))
      .join("|");
  }

  #alternative(): string[] {
    const terms: string[] = [];
    while (this.#index < this.source.length) {
      const character = this.#peek();
      if (character === "|" || character === ")") break;
      const atom = this.#term();
      if (atom === undefined) continue;
      const quantifier = this.#quantifier();
      if (atom.kind === "assertion") {
        // A quantified assertion matches the same positions or none.
        if (quantifier !== "") throw new Unexpressible();
        terms.push(atom.text);
      } else
        terms.push(
          atom.text === ANY_CHARACTER && quantifier === "*"
            ? ANY_STRING
            : atom.text + quantifier,
        );
    }
    return terms;
  }

  #term():
    | { readonly kind: "atom" | "assertion"; readonly text: string }
    | undefined {
    const character = this.#peek();
    if (character === "^" || character === "$") {
      this.#index++;
      return { kind: "assertion", text: character };
    }
    if (character === "(") return this.#parenthesized();
    if (character === "[") return { kind: "atom", text: this.#class() };
    if (character === ".") {
      this.#index++;
      // Without the `s` flag, `.` excludes four line terminators; two are ASCII.
      return {
        kind: "atom",
        text: emitClass(new Set([0x0a, 0x0d]), "some", true, this.#widen),
      };
    }
    if (character === "\\") return this.#atomEscape();
    const code = this.source.codePointAt(this.#index)!;
    this.#index += String.fromCodePoint(code).length;
    return { kind: "atom", text: this.#literal(code) };
  }

  #literal(code: number): string {
    if (code < 0x80) return emitOutside(code);
    this.#widen();
    return NON_ASCII;
  }

  #parenthesized():
    | { readonly kind: "atom" | "assertion"; readonly text: string }
    | undefined {
    const rest = this.source.slice(this.#index);
    const lookAround = /^\(\?<?[=!]/u.exec(rest);
    if (lookAround !== null) {
      // Removing a zero-width assertion admits a superset of strings.
      this.#index += lookAround[0].length;
      this.#group();
      this.#expect(")");
      this.#widen();
      // A quantifier on a removed assertion has nothing left to repeat.
      this.#quantifier();
      return undefined;
    }
    let open = "(";
    if (rest.startsWith("(?:")) {
      open = "(?:";
      this.#index += 3;
    } else {
      // Named groups capture like plain groups; only backreferences read names.
      const named = /^\(\?<[A-Za-z_$][\w$]*>/u.exec(rest);
      if (named !== null) this.#index += named[0].length;
      else if (rest.startsWith("(?")) throw new Unexpressible();
      else this.#index++;
    }
    const inner = this.#group();
    this.#expect(")");
    return { kind: "atom", text: `${open}${inner})` };
  }

  #expect(character: string): void {
    if (this.#peek() !== character) throw new Unexpressible();
    this.#index++;
  }

  #quantifier(): string {
    const character = this.#peek();
    let quantifier = "";
    if (character === "*" || character === "+" || character === "?") {
      this.#index++;
      quantifier = character;
    } else if (character === "{") {
      const repeat = /^\{(\d+)(?:(,)(\d*))?\}/u.exec(
        this.source.slice(this.#index),
      );
      if (repeat === null) throw new Unexpressible();
      this.#index += repeat[0].length;
      let lower = Number(repeat[1]);
      let upper =
        repeat[2] === undefined
          ? lower
          : repeat[3] === ""
            ? undefined
            : Number(repeat[3]);
      if (lower > MAX_REPEAT) {
        lower = MAX_REPEAT;
        upper = undefined;
        this.#widen();
      }
      if (upper !== undefined && upper > MAX_REPEAT) {
        upper = undefined;
        this.#widen();
      }
      quantifier =
        upper === lower
          ? `{${String(lower)}}`
          : `{${String(lower)},${upper === undefined ? "" : String(upper)}}`;
    } else return "";
    // Laziness changes which match is found, not whether one exists.
    if (this.#peek() === "?") this.#index++;
    return quantifier;
  }

  /** One escaped code point, or a shorthand class letter. */
  #escape(inClass: boolean): number | { readonly shorthand: string } {
    this.#index++; // backslash
    const character = this.#peek();
    this.#index++;
    if (character in SHORTHAND_NON_ASCII) return { shorthand: character };
    if (character === "p" || character === "P") {
      const property = /^\{[^}]*\}/u.exec(this.source.slice(this.#index));
      if (property === null) throw new Unexpressible();
      this.#index += property[0].length;
      return { shorthand: `${character}${property[0]}` };
    }
    const controls: Readonly<Record<string, number>> = {
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
    };
    if (Object.hasOwn(controls, character)) return controls[character]!;
    if (character === "0" && !/^[0-9]$/u.test(this.#peek())) return 0;
    if (character === "b" && inClass) return 0x08;
    if (character === "-" && inClass) return 0x2d;
    if (character === "c") {
      const letter = this.#peek();
      if (!/^[A-Za-z]$/u.test(letter)) throw new Unexpressible();
      this.#index++;
      return letter.charCodeAt(0) % 32;
    }
    if (character === "x") {
      const digits = /^[0-9A-Fa-f]{2}/u.exec(this.source.slice(this.#index));
      if (digits === null) throw new Unexpressible();
      this.#index += 2;
      return Number.parseInt(digits[0], 16);
    }
    if (character === "u") {
      const braced = /^\{([0-9A-Fa-f]+)\}/u.exec(
        this.source.slice(this.#index),
      );
      if (braced !== null) {
        this.#index += braced[0].length;
        return Number.parseInt(braced[1]!, 16);
      }
      const digits = /^[0-9A-Fa-f]{4}/u.exec(this.source.slice(this.#index));
      if (digits === null) throw new Unexpressible();
      this.#index += 4;
      const unit = Number.parseInt(digits[0], 16);
      const low = /^\\u([Dd][C-Fc-f][0-9A-Fa-f]{2})/u.exec(
        this.source.slice(this.#index),
      );
      if (unit >= 0xd800 && unit <= 0xdbff && low !== null) {
        this.#index += low[0].length;
        return (
          (unit - 0xd800) * 0x400 +
          (Number.parseInt(low[1]!, 16) - 0xdc00) +
          0x10000
        );
      }
      return unit;
    }
    // Identity escapes of syntax characters; `u` mode admits no others.
    if (ESCAPED_IN_CLASS.has(character) && character !== "-") {
      return character.charCodeAt(0);
    }
    // Backreferences and word boundaries are handled by the caller.
    throw new Unexpressible();
  }

  #atomEscape():
    | { readonly kind: "atom" | "assertion"; readonly text: string }
    | undefined {
    const next = this.#peek(1);
    if (next === "b" || next === "B") {
      // Removing a zero-width assertion admits a superset of strings.
      this.#index += 2;
      this.#widen();
      this.#quantifier();
      return undefined;
    }
    // Backreferences have no portable form.
    if (/^[1-9k]$/u.test(next)) throw new Unexpressible();
    const escaped = this.#escape(false);
    if (typeof escaped === "number")
      return { kind: "atom", text: this.#literal(escaped) };
    const { ascii, nonAscii } = this.#membership(`[\\${escaped.shorthand}]`, [
      escaped,
    ]);
    return {
      kind: "atom",
      text: emitClass(ascii, nonAscii, false, this.#widen),
    };
  }

  /** Parse a class at the cursor and re-emit it. */
  #class(): string {
    const start = this.#index;
    this.#index++;
    const negated = this.#peek() === "^";
    if (negated) this.#index++;
    const members: (number | { shorthand: string } | [number, number])[] = [];
    while (this.#peek() !== "]") {
      if (this.#index >= this.source.length) throw new Unexpressible();
      const low = this.#classAtom();
      if (
        typeof low === "number" &&
        this.#peek() === "-" &&
        this.#peek(1) !== "]" &&
        this.#peek(1) !== ""
      ) {
        this.#index++;
        const high = this.#classAtom();
        if (typeof high !== "number") throw new Unexpressible();
        members.push([low, high]);
      } else members.push(low);
    }
    this.#index++;
    const inner = this.source.slice(start + (negated ? 2 : 1), this.#index - 1);
    const { ascii, nonAscii } = this.#membership(`[${inner}]`, members);
    return emitClass(ascii, nonAscii, negated, this.#widen);
  }

  #classAtom(): number | { shorthand: string } {
    if (this.#peek() === "\\") return this.#escape(true);
    const code = this.source.codePointAt(this.#index)!;
    this.#index += String.fromCodePoint(code).length;
    return code;
  }

  #membership(
    classSource: string,
    members: readonly (number | { shorthand: string } | [number, number])[],
  ): { readonly ascii: ReadonlySet<number>; readonly nonAscii: NonAscii } {
    // V8 decides ASCII membership exactly, including property escapes.
    const expression = new RegExp(`^${classSource}$`, "u");
    const ascii = new Set(
      ASCII_CODES.filter((code) => expression.test(String.fromCharCode(code))),
    );
    let nonAscii: NonAscii = "none";
    for (const member of members) {
      if (typeof member === "number")
        nonAscii = unionNonAscii(nonAscii, member >= 0x80 ? "some" : "none");
      else if (Array.isArray(member))
        nonAscii = unionNonAscii(
          nonAscii,
          member[1] < 0x80
            ? "none"
            : member[0] <= 0x80 && member[1] >= 0x10ffff
              ? "all"
              : "some",
        );
      else
        nonAscii = unionNonAscii(
          nonAscii,
          SHORTHAND_NON_ASCII[member.shorthand] ?? "some",
        );
    }
    return { ascii, nonAscii };
  }
}

const projections = new Map<string, PortablePatternProjection>();

/**
 * Re-emit an advertised ECMAScript pattern in the portable grammar. Results
 * are memoized: advertised patterns come from a fixed set of contracts.
 */
export const projectPortablePattern = (
  pattern: string,
): PortablePatternProjection => {
  const cached = projections.get(pattern);
  if (cached !== undefined) return cached;
  let projection: PortablePatternProjection;
  try {
    // JSON Schema validators read `pattern` with Unicode semantics.
    new RegExp(pattern, "u");
    const projected = new Projector(pattern).project();
    // The emitter's own output must stay inside the grammar it targets.
    projection =
      portablePatternViolations(projected.pattern).length > 0
        ? { kind: "unexpressible" }
        : projected;
  } catch (cause: unknown) {
    if (!(cause instanceof Unexpressible || cause instanceof SyntaxError))
      throw cause;
    projection = { kind: "unexpressible" };
  }
  projections.set(pattern, projection);
  return projection;
};
