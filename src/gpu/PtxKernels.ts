import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import type { GpuKernel } from "../domain/gpu/gpuCodeObjects.js";
import {
  DEFAULT_GPU_PARSER_ENTRIES,
  DEFAULT_GPU_REPORT_BYTES,
  DEFAULT_GPU_TOKEN_BYTES,
  GPU_PARSER_ENTRIES_LIMIT,
  GPU_TOKEN_BYTES_LIMIT,
  type GpuCodeObjectsBudgets,
} from "../domain/gpu/gpuCodeObjectsBudgets.js";
import { rejectGpu } from "./GpuSource.js";
interface Token {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}
const isPtxWordChar = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f ||
  code === 0x2e ||
  code === 0x24 ||
  code === 0x25 ||
  code === 0x40;

const isWhitespaceAt = (text: string, at: number, code: number): boolean =>
  code < 0x80
    ? code === 0x20 || (code >= 0x09 && code <= 0x0d)
    : /\s/u.test(text[at]!);

/** Byte coordinates are accumulated once, including non-ASCII comments and quoted strings. */
function* tokens(
  text: string,
  maxTokenBytes: number | (() => number) = DEFAULT_GPU_TOKEN_BYTES,
): Generator<Token> {
  const limit =
    typeof maxTokenBytes === "function" ? maxTokenBytes : () => maxTokenBytes;
  const len = text.length;
  let at = 0,
    byte = 0;
  const advance = (): void => {
    const first = text.charCodeAt(at);
    if (first < 0x80) {
      at += 1;
      byte += 1;
      return;
    }
    const code = text.codePointAt(at)!;
    at += code > 0xffff ? 2 : 1;
    byte += code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  };
  while (at < len) {
    const code = text.charCodeAt(at);
    if (isWhitespaceAt(text, at, code)) {
      advance();
      continue;
    }
    if (code === 0x2f && at + 1 < len) {
      const next = text.charCodeAt(at + 1);
      if (next === 0x2f) {
        while (at < len && text.charCodeAt(at) !== 0x0a) advance();
        continue;
      }
      if (next === 0x2a) {
        at += 2;
        byte += 2;
        while (
          at < len &&
          !(text.charCodeAt(at) === 0x2a && text.charCodeAt(at + 1) === 0x2f)
        )
          advance();
        if (at === len) rejectGpu("Unterminated PTX comment");
        at += 2;
        byte += 2;
        continue;
      }
    }
    const start = byte,
      position = at;
    if (code === 0x22) {
      at += 1;
      byte += 1;
      let closed = false;
      while (at < len) {
        const ch = text.charCodeAt(at);
        if (ch === 0x22) {
          at += 1;
          byte += 1;
          closed = true;
          break;
        }
        if (ch === 0x5c) {
          at += 1;
          byte += 1;
          if (at < len) advance();
        } else advance();
      }
      if (!closed) rejectGpu("Unterminated PTX string");
      yield { value: '""', start, end: byte };
      continue;
    }
    if (isPtxWordChar(code)) {
      // Dot-prefixed keywords remain separate when their whitespace is omitted.
      // Internal dots in names, instruction mnemonics and version literals stay intact.
      const keyword = code === 0x2e;
      at += 1;
      byte += 1;
      while (at < len) {
        const ch = text.charCodeAt(at);
        if (!isPtxWordChar(ch) || (keyword && ch === 0x2e)) break;
        at += 1;
        byte += 1;
      }
    } else advance();
    const currentLimit = limit();
    if (byte - start > currentLimit)
      throw new BinaryResourceFailure(
        "structure",
        currentLimit,
        "PTX token exceeds the string budget",
        GPU_TOKEN_BYTES_LIMIT,
        "bytes",
      );
    yield { value: text.slice(position, at), start, end: byte };
  }
}
const integer = (token: string | undefined): number | null => {
  if (token === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
};
/** Read a single nonnegative PTX integer literal used as an array extent. */
const arrayExtent = (token: string | undefined): number | null => {
  if (token === undefined) return null;
  const digits = token.endsWith("U") ? token.slice(0, -1) : token;
  if (/^0[0-7]+$/u.test(digits)) {
    const value = Number(`0o${digits.slice(1)}`);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (!/^0(?:[xX][0-9a-fA-F]+|[bB][01]+)$/u.test(digits))
    return integer(digits);
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
};
const alignmentValue = (token: string | undefined): number | null => {
  const value = integer(token);
  // A logarithm can round a neighboring large integer to a whole exponent.
  return value !== null &&
    value > 0 &&
    2 ** Math.round(Math.log2(value)) === value
    ? value
    : null;
};
type PtxVersion = { major: number; minor: number };
const ptxVersion = (token: string | undefined): PtxVersion | null => {
  const match = /^(\d+)\.(\d+)$/u.exec(token ?? "");
  if (match === null) return null;
  const major = Number(match[1]),
    minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
    ? { major, minor }
    : null;
};
const sizeOf = (type: string | undefined): number | null => {
  const match = /^\.(?:b|u|s|f)(8|16|32|64|128)$/u.exec(type ?? "");
  return match === null ? null : Number(match[1]) / 8;
};
const identifier = /^(?:%?[A-Za-z_$][\w$@.]*|%[0-9][A-Za-z0-9_$]*)$/u;
/** Stream register names/ranges without retaining the declaration token list. */
const registerDeclaration = (
  next: () => Token,
): { type: string; count: number | null } => {
  let type = "";
  let t = next();
  while (!identifier.test(t.value)) {
    if (t.value === ";" || t.value === "}")
      rejectGpu("PTX register declaration has no type or name");
    type += `${type.length === 0 ? "" : " "}${t.value}`;
    t = next();
  }
  if (type.length === 0)
    rejectGpu("PTX register declaration has no type or name");
  const supported = /^\.(?:pred|[busf](?:8|16|32|64|128))$/u.test(type);
  let count = 0;
  const discard = (token: Token): { type: string; count: null } => {
    while (token.value !== ";") {
      if (token.value === "}") rejectGpu("Malformed PTX resource declaration");
      token = next();
    }
    return { type, count: null };
  };
  while (true) {
    let declared = 1;
    let separator = next();
    if (separator.value === "<") {
      const range = next();
      if (range.value === ";" || range.value === "}") return discard(range);
      const close = next();
      if (close.value !== ">") return discard(close);
      const value = integer(range.value);
      if (value === null || value === 0) return discard(next());
      declared = value;
      separator = next();
    }
    if (separator.value === ";") {
      const total = count + declared;
      return {
        type,
        count: supported && Number.isSafeInteger(total) ? total : null,
      };
    }
    if (separator.value !== ",") return discard(separator);
    count += declared;
    if (!Number.isSafeInteger(count) || !supported) return discard(separator);
    const name = next();
    if (name.value === ";" || !identifier.test(name.value))
      return discard(name);
  }
};
const declaration = (
  source: string[],
): {
  name: string | null;
  type: string | null;
  size: number | null;
  align: number | null;
} => {
  const values = source[0] === ".param" ? source.slice(1) : source;
  let at = 0;
  let explicit = values[at] === ".align";
  let alignment = explicit ? alignmentValue(values[++at]) : null;
  if (explicit) at++;
  const vector = values[at] === ".v2" ? 2 : values[at] === ".v4" ? 4 : 1;
  if (vector !== 1) at++;
  const scalar = values[at++],
    unit = sizeOf(scalar);
  let pointer = false,
    layoutKnown = unit !== null && (!explicit || alignment !== null);
  while (values[at]?.startsWith(".")) {
    const qualifier = values[at++]!;
    if (qualifier === ".ptr") {
      if (pointer) layoutKnown = false;
      pointer = true;
    } else if (
      pointer &&
      [".const", ".global", ".local", ".shared"].includes(qualifier)
    ) {
      // Address-space qualifiers describe the pointed-to object.
    } else if (qualifier === ".align") {
      const alignmentToken = values[at];
      if (alignmentToken !== undefined && /^[0-9]+$/u.test(alignmentToken))
        at++;
      const declaredAlignment = alignmentValue(alignmentToken);
      if (declaredAlignment === null) layoutKnown = false;
      if (!pointer) {
        if (explicit) layoutKnown = false;
        explicit = true;
        alignment = declaredAlignment;
      }
    } else layoutKnown = false;
  }
  const name = identifier.test(values[at] ?? "") ? values[at]! : null;
  if (name === null) layoutKnown = false;
  let cursor = at + (name === null ? 0 : 1);
  const dimensions: string[][] = [];
  while (values[cursor] === "[") {
    const start = ++cursor;
    let parentheses = 0;
    while (cursor < values.length) {
      const value = values[cursor]!;
      if (value === "(") parentheses++;
      else if (value === ")") {
        if (parentheses === 0) break;
        parentheses--;
      } else if (value === "]" && parentheses === 0) break;
      cursor++;
    }
    if (values[cursor] !== "]" || parentheses !== 0) {
      layoutKnown = false;
      break;
    }
    dimensions.push(values.slice(start, cursor));
    cursor++;
  }
  if (cursor !== values.length || dimensions.length > 1) layoutKnown = false;
  let size = unit === null ? null : unit * vector;
  const type =
    scalar === undefined
      ? null
      : vector === 1
        ? scalar
        : `.v${vector} ${scalar}`;
  const align = explicit ? alignment : size;
  if (dimensions.length === 1) {
    const dimension = dimensions[0]!,
      count = dimension.length === 1 ? arrayExtent(dimension[0]) : null;
    if (count === null || size === null || !Number.isSafeInteger(count * size))
      layoutKnown = false;
    else size *= count;
  }
  // Explicit alignment was checked at admission. Natural alignment comes
  // from the supported power-of-two scalar and vector sizes.
  if (align === null || !layoutKnown)
    return { name, type, size: null, align: null };
  return { name, type, size, align };
};

/** Entry declarations and virtual resources; no instruction semantics or physical register claims. */
export function* readPtxKernels(
  text: string,
  objectId: string,
  targetTracker?: PtxTargetTracker,
  budgets?: Pick<
    GpuCodeObjectsBudgets,
    "maxReportBytes" | "maxParserEntries" | "maxTokenBytes"
  >,
): Generator<{ kernel: GpuKernel; coverage: "complete" | "partial" }> {
  const maxReportBytes = budgets?.maxReportBytes ?? DEFAULT_GPU_REPORT_BYTES;
  const maxParserEntries =
    budgets?.maxParserEntries ?? DEFAULT_GPU_PARSER_ENTRIES;
  const maxTokenBytes = budgets?.maxTokenBytes ?? DEFAULT_GPU_TOKEN_BYTES;
  if (Buffer.byteLength(text) > maxReportBytes)
    throw new BinaryResourceFailure(
      "structure",
      maxReportBytes,
      `PTX text exceeds the ${String(maxReportBytes)}-byte retained report budget`,
      "gpu-retained-report-bytes",
      "bytes",
    );
  const iterator = tokens(text, maxTokenBytes);
  const next = (): Token => {
    const value = iterator.next();
    if (value.done) return rejectGpu("Truncated PTX entry declaration");
    return value.value;
  };
  let kernelCount = 0;
  let outerDepth = 0;
  let version: PtxVersion | null = null;
  let firstToken = true;
  let targetTrackingEnabled = false;
  for (let step = iterator.next(); !step.done; step = iterator.next()) {
    const token = step.value;
    const isFirst = firstToken;
    firstToken = false;
    if (token.value === "{") {
      outerDepth++;
      continue;
    }
    if (token.value === "}") {
      if (outerDepth === 0) rejectGpu("Unbalanced PTX body");
      outerDepth--;
      continue;
    }
    if (outerDepth !== 0) continue;
    if (token.value === ".version") {
      const value = iterator.next();
      version = value.done ? null : ptxVersion(value.value.value);
      if (isFirst) targetTrackingEnabled = version !== null;
      continue;
    }
    if (
      targetTracker !== undefined &&
      targetTrackingEnabled &&
      token.value === ".target"
    ) {
      const value = iterator.next();
      targetTracker.observe(value.done ? undefined : value.value.value);
      continue;
    }
    if (token.value !== ".entry") continue;
    const name = next();
    if (!identifier.test(name.value))
      rejectGpu("Malformed PTX entry name or parameters");
    const parameters: GpuKernel["parameters"] = [];
    let part: string[] = [],
      parameterBytes: number | null = 0;
    const flush = (): void => {
      if (part.length === 0) return;
      if (part[0] !== ".param") rejectGpu("Unknown PTX parameter declaration");
      if (parameters.length >= maxParserEntries)
        throw new BinaryResourceFailure(
          "structure",
          maxParserEntries,
          "PTX parameter declarations exceed the facts budget",
          GPU_PARSER_ENTRIES_LIMIT,
          "entries",
        );
      const value = declaration(part);
      let offset: number | null = null;
      if (
        parameterBytes !== null &&
        value.size !== null &&
        value.align !== null
      ) {
        const aligned = Math.ceil(parameterBytes / value.align) * value.align;
        const end = aligned + value.size;
        offset = Number.isSafeInteger(aligned) ? aligned : null;
        parameterBytes = Number.isSafeInteger(end) ? end : null;
      } else parameterBytes = null;
      parameters.push({
        ordinal: parameters.length,
        name: value.name,
        offset,
        size: value.size,
        type: value.type,
        hidden: null,
      });
      part = [];
    };
    let t = next();
    if (t.value === "(") {
      let parentheses = 0,
        brackets = 0;
      while (true) {
        t = next();
        if (t.value === "(") parentheses++;
        else if (t.value === ")") {
          if (parentheses > 0) parentheses--;
          else if (brackets === 0) break;
          else rejectGpu("Malformed PTX parameter dimension");
        } else if (t.value === "[") brackets++;
        else if (t.value === "]") {
          if (brackets === 0) rejectGpu("Malformed PTX parameter dimension");
          brackets--;
        }
        if (t.value === "," && parentheses === 0 && brackets === 0) flush();
        else part.push(t.value);
        if (part.length > 128)
          throw new BinaryResourceFailure(
            "structure",
            128,
            "PTX parameter declaration exceeds the fixed 128-token syntax limit",
          );
      }
      flush();
      t = next();
    } else if (t.value !== "{" && t.value !== ";" && !t.value.startsWith(".")) {
      rejectGpu("Malformed PTX entry name or parameters");
    }
    // Entry directives can occur between the parameter list and body.
    let headerTokens = 0;
    while (t.value !== "{" && t.value !== ";") {
      if (++headerTokens > 65536) rejectGpu("PTX entry header is too large");
      if (t.value === ".pragma") {
        t = next();
        if (t.value !== '""') rejectGpu("Malformed PTX entry pragma");
        while (true) {
          if (++headerTokens > 65536)
            rejectGpu("PTX entry header is too large");
          t = next();
          if (t.value === ";") break;
          if (t.value !== ",") rejectGpu("Malformed PTX entry pragma");
          t = next();
          if (t.value !== '""') rejectGpu("Malformed PTX entry pragma");
        }
        t = next();
        continue;
      }
      t = next();
    }
    let end = t.end,
      shared: number | null = t.value === "{" ? 0 : null;
    const virtual = new Map<string, number | null>();
    if (t.value === "{") {
      let depth = 1;
      while (depth > 0) {
        t = next();
        end = t.end;
        if (t.value === "{") {
          depth++;
          continue;
        }
        if (t.value === "}") {
          depth--;
          continue;
        }
        if (
          t.value === ".param" &&
          version !== null &&
          version.major === 1 &&
          version.minor <= 3
        ) {
          const bodyParameter = [t.value];
          for (t = next(); t.value !== ";"; t = next()) {
            if (t.value === "}")
              rejectGpu("Malformed PTX parameter declaration");
            if (bodyParameter.length >= 128)
              throw new BinaryResourceFailure(
                "structure",
                128,
                "PTX parameter declaration exceeds the fixed 128-token syntax limit",
              );
            bodyParameter.push(t.value);
          }
          part = bodyParameter;
          flush();
          end = t.end;
          continue;
        }
        // Call prototypes contain formal .reg/.param declarations, not entry resources.
        if (t.value === ".callprototype") {
          for (t = next(); t.value !== ";"; t = next()) {
            if (t.value === "}") rejectGpu("Malformed PTX call prototype");
          }
          end = t.end;
          continue;
        }
        if (t.value !== ".reg" && t.value !== ".shared") continue;
        if (t.value === ".reg") {
          const { type, count } = registerDeclaration(next);
          const previous = virtual.get(type);
          const total =
            previous === null || count === null
              ? null
              : (previous ?? 0) + count;
          virtual.set(
            type,
            total === null || !Number.isSafeInteger(total) ? null : total,
          );
          continue;
        }
        const declarationTokens: string[] = [];
        for (t = next(); t.value !== ";"; t = next()) {
          if (t.value === "}" || declarationTokens.length > 128)
            rejectGpu("Malformed PTX resource declaration");
          declarationTokens.push(t.value);
        }
        const value = declaration(declarationTokens);
        if (shared === null || value.size === null || value.align === null)
          shared = null;
        else {
          const total =
            Math.ceil(shared / value.align) * value.align + value.size;
          shared = Number.isSafeInteger(total) ? total : null;
        }
      }
    }
    const kernel: GpuKernel = {
      id: `${objectId}/entry@${token.start.toString(16)}`,
      object_id: objectId,
      representation: "ptx-declarations",
      name: name.value,
      symbol: null,
      parameter_count: parameters.length,
      parameter_bytes: parameterBytes,
      parameters,
      registers: {
        physical: null,
        sgpr: null,
        vgpr: null,
        agpr: null,
        virtual: [...virtual].map(([type, count]) => ({ type, count })),
      },
      shared_bytes: shared,
      private_bytes: null,
      location: {
        container_id: objectId,
        offset: token.start,
        size: end - token.start,
        section_index: null,
        section_name: null,
      },
      sources: {
        parameters: {
          container_id: objectId,
          offset: token.start,
          size: end - token.start,
          section_index: null,
          section_name: null,
        },
        registers: null,
        shared: null,
        private: null,
      },
      limitations: [
        "PTX registers are virtual declarations, not physical allocations. Parameter offsets/sizes and entry-local static shared bytes are derived from supported declarations; module shared bytes, dynamic allocation, device ABI and runtime allocation were not verified.",
      ],
    };
    let coverage: "complete" | "partial" = "complete";
    if (parameterBytes === null) {
      coverage = "partial";
      kernel.limitations.push(
        "Unsupported PTX parameter declarations or overflowing layouts leave parameter sizes/offsets and the total byte count unknown.",
      );
    }
    if (shared === null) {
      coverage = "partial";
      kernel.limitations.push(
        "Unsupported, dynamic or overflowing PTX shared declarations, or an absent entry body, leave entry-local static shared bytes unknown.",
      );
    }
    if (kernel.registers.virtual.some((row) => row.count === null)) {
      coverage = "partial";
      kernel.limitations.push(
        "Unsupported PTX register declarations or overflowing totals leave the affected virtual register count unknown.",
      );
    }
    if (++kernelCount > maxParserEntries)
      throw new BinaryResourceFailure(
        "structure",
        maxParserEntries,
        "PTX kernel count exceeds the facts budget",
        GPU_PARSER_ENTRIES_LIMIT,
        "entries",
      );
    yield { kernel, coverage };
  }
  if (outerDepth !== 0) rejectGpu("Unbalanced PTX body");
}

export interface PtxTargetFacts {
  readonly recognized: boolean;
  readonly target: string | null;
  readonly limitation: string | null;
}

/** Single-pass `.target` directive accumulator shared by target discovery and module parsing. */
export interface PtxTargetTracker {
  observe(spelling: string | undefined): void;
  markMalformed(): void;
  facts(): PtxTargetFacts;
}

export const createPtxTargetTracker = (): PtxTargetTracker => {
  let target: string | null = null,
    targetIdentity: string | null = null,
    targetArchitecture = -1,
    ambiguous = false,
    unsupported = false,
    malformed = false;
  return {
    observe(spelling) {
      if (spelling === undefined) {
        unsupported = true;
        return;
      }
      const match = /^(?:sm_|compute_)([0-9]+)(?:a|f)?$/u.exec(spelling);
      if (match === null) {
        unsupported = true;
        return;
      }
      const architecture = Number(match[1]);
      if (!Number.isSafeInteger(architecture)) {
        unsupported = true;
        return;
      }
      const identity = ptxTargetIdentity(spelling);
      if (architecture > targetArchitecture) {
        target = spelling;
        targetIdentity = identity;
        targetArchitecture = architecture;
        ambiguous = false;
      } else if (
        architecture === targetArchitecture &&
        targetIdentity !== identity
      ) {
        ambiguous = true;
      }
    },
    markMalformed() {
      malformed = true;
    },
    facts() {
      const recognized = target !== null;
      const limitation = !recognized
        ? null
        : unsupported
          ? "Unsupported PTX target directives leave the effective target unknown."
          : ambiguous
            ? "Same-generation PTX target profiles cannot be represented by one effective target."
            : malformed
              ? "Malformed PTX text prevents complete target discovery."
              : null;
      return {
        recognized,
        target: limitation === null ? target : null,
        limitation,
      };
    },
  };
};

/** PTX's compute spelling is an alias for the corresponding baseline SM target. */
export const ptxTargetIdentity = (target: string): string =>
  target.replace(/^compute_(\d+[a-z]?)$/u, "sm_$1");

/**
 * Incremental standalone PTX candidate recognizer. Skips leading whitespace
 * (including UTF-8 BOM and Unicode whitespace) and `//` or `/* ... *\/` comments
 * across chunks to verify the first module token is `.version <major>.<minor>`
 * without applying caller object or token budgets to non-PTX inputs.
 */
export const createPtxVersionScanner = (): {
  feed(chunk: Uint8Array): "yes" | "no" | "incomplete";
  finish(): "yes" | "no";
} => {
  type State =
    | "leading"
    | "slash"
    | "line-comment"
    | "block-comment"
    | "block-star"
    | "version-word"
    | "after-version"
    | "after-slash"
    | "after-line-comment"
    | "after-block-comment"
    | "after-block-star"
    | "version-major"
    | "version-minor";
  const VERSION_DIRECTIVE = ".version";
  let state: State = "leading";
  let wordIndex = 0;
  let majorValue = 0;
  let hasMajorDigit = false;
  let minorValue = 0;
  let hasMinorDigit = false;
  let utf8Pending: number[] = [];
  let utf8Expected = 0;

  const isAsciiWhitespace = (byte: number): boolean =>
    byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

  const isUnicodeWhitespace = (bytes: readonly number[]): boolean => {
    const text = Buffer.from(bytes).toString("utf8");
    return text.length > 0 && /^\s+$/u.test(text);
  };

  const stepByte = (byte: number): "yes" | "no" | "incomplete" => {
    if (utf8Expected > 0) {
      if ((byte & 0xc0) === 0x80) {
        utf8Pending.push(byte);
        if (utf8Pending.length < utf8Expected) return "incomplete";
        const ws = isUnicodeWhitespace(utf8Pending);
        utf8Pending = [];
        utf8Expected = 0;
        return ws ? "incomplete" : "no";
      }
      // Invalid UTF-8 continuation sequence cannot be whitespace.
      utf8Pending = [];
      utf8Expected = 0;
      return "no";
    }
    while (true) {
      if (state === "leading" || state === "after-version") {
        if (isAsciiWhitespace(byte)) return "incomplete";
        if (byte >= 0x80) {
          if (byte >= 0xc2 && byte <= 0xdf) utf8Expected = 2;
          else if (byte >= 0xe0 && byte <= 0xef) utf8Expected = 3;
          else if (byte >= 0xf0 && byte <= 0xf4) utf8Expected = 4;
          else return "no";
          utf8Pending = [byte];
          return "incomplete";
        }
        if (byte === 0x2f) {
          state = state === "leading" ? "slash" : "after-slash";
          return "incomplete";
        }
        if (state === "leading") {
          if (byte !== 0x2e) return "no";
          state = "version-word";
          wordIndex = 1;
          return "incomplete";
        }
        if (byte < 0x30 || byte > 0x39) return "no";
        state = "version-major";
        majorValue = byte - 0x30;
        hasMajorDigit = true;
        return "incomplete";
      }
      if (state === "slash" || state === "after-slash") {
        if (byte === 0x2f) {
          state = state === "slash" ? "line-comment" : "after-line-comment";
          return "incomplete";
        }
        if (byte === 0x2a) {
          state = state === "slash" ? "block-comment" : "after-block-comment";
          return "incomplete";
        }
        return "no";
      }
      if (state === "line-comment" || state === "after-line-comment") {
        if (byte === 0x0a)
          state = state === "line-comment" ? "leading" : "after-version";
        return "incomplete";
      }
      if (state === "block-comment" || state === "after-block-comment") {
        if (byte === 0x2a)
          state = state === "block-comment" ? "block-star" : "after-block-star";
        return "incomplete";
      }
      if (state === "block-star" || state === "after-block-star") {
        if (byte === 0x2f) {
          state = state === "block-star" ? "leading" : "after-version";
          return "incomplete";
        }
        if (byte !== 0x2a)
          state =
            state === "block-star" ? "block-comment" : "after-block-comment";
        return "incomplete";
      }
      if (state === "version-word") {
        if (isPtxWordChar(byte) && byte !== 0x2e) {
          if (
            wordIndex >= VERSION_DIRECTIVE.length ||
            byte !== VERSION_DIRECTIVE.charCodeAt(wordIndex)
          )
            return "no";
          wordIndex++;
          return "incomplete";
        }
        if (wordIndex !== VERSION_DIRECTIVE.length) return "no";
        state = "after-version";
        continue;
      }
      if (state === "version-major") {
        if (byte >= 0x30 && byte <= 0x39) {
          majorValue = majorValue * 10 + (byte - 0x30);
          if (!Number.isSafeInteger(majorValue)) return "no";
          return "incomplete";
        }
        if (byte === 0x2e && hasMajorDigit) {
          state = "version-minor";
          minorValue = 0;
          hasMinorDigit = false;
          return "incomplete";
        }
        return "no";
      }
      // state === "version-minor"
      if (byte >= 0x30 && byte <= 0x39) {
        minorValue = minorValue * 10 + (byte - 0x30);
        if (!Number.isSafeInteger(minorValue)) return "no";
        hasMinorDigit = true;
        return "incomplete";
      }
      if (isPtxWordChar(byte)) return "no";
      return hasMinorDigit ? "yes" : "no";
    }
  };

  return {
    feed(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const verdict = stepByte(chunk[i]!);
        if (verdict !== "incomplete") return verdict;
      }
      return "incomplete";
    },
    finish() {
      return state === "version-minor" && hasMinorDigit && utf8Expected === 0
        ? "yes"
        : "no";
    },
  };
};

/** Resolve all module-scope targets through the highest numbered architecture. */
export const readPtxTarget = (
  text: string,
  maxTokenBytes: number = DEFAULT_GPU_TOKEN_BYTES,
): PtxTargetFacts => {
  // Format recognition (.version <major>.<minor>) must not be preempted by a
  // caller-lowered max_token_bytes on non-PTX text; enforce it after recognition.
  let enforceTokenBudget = false;
  const stream = tokens(text, () =>
    enforceTokenBudget ? maxTokenBytes : Number.POSITIVE_INFINITY,
  );
  const tracker = createPtxTargetTracker();
  let depth = 0;
  try {
    const first = stream.next();
    if (first.done || first.value.value !== ".version")
      return { recognized: false, target: null, limitation: null };
    const declaredVersion = stream.next();
    if (
      declaredVersion.done ||
      ptxVersion(declaredVersion.value.value) === null
    )
      return { recognized: false, target: null, limitation: null };
    if (
      first.value.end - first.value.start > maxTokenBytes ||
      declaredVersion.value.end - declaredVersion.value.start > maxTokenBytes
    )
      throw new BinaryResourceFailure(
        "structure",
        maxTokenBytes,
        "PTX token exceeds the string budget",
        GPU_TOKEN_BYTES_LIMIT,
        "bytes",
      );
    enforceTokenBudget = true;
    for (const token of stream) {
      if (token.value === "{") {
        depth++;
        continue;
      }
      if (token.value === "}") {
        // The kernel reader rejects an unmatched close as an unbalanced body.
        // Keep scanning so the object stays recognized, but the target is not
        // established from structure that inspection cannot accept.
        if (depth === 0) tracker.markMalformed();
        else depth--;
        continue;
      }
      if (depth !== 0) continue;
      if (token.value !== ".target") continue;
      const value = stream.next();
      tracker.observe(value.done ? undefined : value.value.value);
    }
    // A body still open at end of text is truncated, as kernel inspection reports.
    if (depth !== 0) tracker.markMalformed();
  } catch (cause) {
    if (!(cause instanceof BinaryFormatFailure)) throw cause;
    tracker.markMalformed();
  }
  return tracker.facts();
};
