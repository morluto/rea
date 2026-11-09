import { ENTRY_BYTES, textBytes } from "./webNetworkRouteTemplates.js";
import {
  decodedSegment,
  isParam,
  segmentsOf,
} from "./environmentStateRules.js";

/** Ordered starts and the two latest completions from distinct writes through each start, allowing one exclusion. */
class CompletionHistory {
  readonly #starts: number[] = [];
  readonly #ends: {
    readonly id: number;
    readonly end: number | undefined;
  }[][] = [];

  constructor(private readonly retain: (bytes: number) => void) {}

  reserve(start: number): void {
    // Reserve the prefix summary array and up to two distinct write entries.
    if (this.#starts.at(-1) !== start) this.retain(ENTRY_BYTES * 3);
  }

  append(start: number, end: number | undefined, id: number): void {
    const entries = [...(this.#ends.at(-1) ?? []), { id, end }].sort(
      (a, b) => (b.end ?? Infinity) - (a.end ?? Infinity),
    );
    const best = entries
      .filter(
        (entry, index) =>
          entries.findIndex((item) => item.id === entry.id) === index,
      )
      .slice(0, 2);
    if (this.#starts.at(-1) === start) this.#ends[this.#ends.length - 1] = best;
    else {
      this.#starts.push(start);
      this.#ends.push(best);
    }
  }

  overlaps(
    start: number | undefined,
    end: number | undefined,
    exclude?: number,
  ): boolean {
    // Admit same-start writes for a point observation; a known zero-length write
    // is still excluded by its completion below. Otherwise starts at read end are disjoint.
    // Find writes begun before the read completed. Unknown read completion
    // admits every captured write; all histories are built in chronology order.
    let low = 0;
    let high = this.#starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (
        end === undefined ||
        this.#starts[middle]! < end ||
        (start === end && this.#starts[middle] === end)
      )
        low = middle + 1;
      else high = middle;
    }
    if (low === 0) return false;
    const completion = this.#ends[low - 1]?.find(
      (entry) => entry.id !== exclude,
    );
    return (
      completion !== undefined &&
      (completion.end === undefined ||
        start === undefined ||
        completion.end > start)
    );
  }
}

class CompletionPrefix {
  terminal: CompletionHistory | undefined;
  subtree: CompletionHistory | undefined;
  readonly children: Map<string, CompletionPrefix>;
  readonly decoded: Map<string, Set<CompletionPrefix>>;
  parameter: CompletionPrefix | undefined;

  constructor(private readonly retain: (bytes: number) => void) {
    // Node, child maps, parameter link and both history owners with their arrays.
    retain(ENTRY_BYTES * 10);
    this.children = new Map();
    this.decoded = new Map();
  }

  child(segment: string): CompletionPrefix {
    if (isParam(segment))
      return (this.parameter ??= new CompletionPrefix(this.retain));
    const held = this.children.get(segment);
    if (held !== undefined) return held;
    // Reserve edge entries, inverse-match membership and both retained spellings
    // before decoding or allocating. A once-decoded segment cannot grow in length.
    this.retain(ENTRY_BYTES * 4 + textBytes(segment.length) * 2);
    const child = new CompletionPrefix(this.retain);
    const decoded = decodedSegment(segment);
    this.children.set(segment, child);
    this.decoded.set(
      decoded,
      (this.decoded.get(decoded) ?? new Set()).add(child),
    );
    return child;
  }

  /** Keep verbatim, once-decoded and inverse-decoded matches distinct: decoding is not transitive. */
  matching(segment: string): Set<CompletionPrefix> {
    if (isParam(segment))
      return new Set([
        ...this.children.values(),
        ...(this.parameter === undefined ? [] : [this.parameter]),
      ]);
    const matches = new Set(this.decoded.get(segment));
    for (const spelling of [segment, decodedSegment(segment)]) {
      const child = this.children.get(spelling);
      if (child !== undefined) matches.add(child);
    }
    if (this.parameter !== undefined) matches.add(this.parameter);
    return matches;
  }
}

/** Index captured write intervals by the same segment-prefix relation as write attribution. */
export class CapturedWriteCompletion {
  readonly #root: CompletionPrefix;

  constructor(private readonly retain: (bytes: number) => void) {
    this.#root = new CompletionPrefix(retain);
  }

  /** Admit writes in nondecreasing chronology start order. */
  write(
    path: string,
    end: number | undefined,
    start: number | undefined,
    id: number,
  ): void {
    start ??= -Infinity;
    let node = this.#root;
    const ancestors = [node];
    // Finish budgeted path admission before publishing any completion summary.
    // A refused edge may leave reserved empty prefixes, but no write facts.
    for (const segment of segmentsOf(path)) {
      node = node.child(segment);
      ancestors.push(node);
    }
    const histories = ancestors.map(
      (ancestor) => (ancestor.subtree ??= new CompletionHistory(this.retain)),
    );
    histories.push((node.terminal ??= new CompletionHistory(this.retain)));
    for (const history of histories) history.reserve(start);
    for (const history of histories) history.append(start, end, id);
  }

  /** Unknown completion or read start cannot prove that a related write finished. */
  runningAt(
    path: string,
    start: number | undefined,
    end = Infinity,
    exclude?: number,
  ): boolean {
    const running = (history: CompletionHistory | undefined): boolean =>
      history?.overlaps(start, end, exclude) === true;
    let nodes = new Set([this.#root]);
    for (const segment of segmentsOf(path)) {
      const next = new Set<CompletionPrefix>();
      for (const node of nodes) {
        if (running(node.terminal)) return true;
        for (const child of node.matching(segment)) next.add(child);
      }
      if (next.size === 0) return false;
      nodes = next;
    }
    return [...nodes].some((node) => running(node.subtree));
  }
}
