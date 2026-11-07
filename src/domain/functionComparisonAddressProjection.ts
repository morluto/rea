import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import {
  parseAddress,
  type TextAddressLocation,
} from "./functionComparisonTextParsing.js";
import { nativeSymbolOrigin } from "./native/nativeSymbol.js";

export interface AddressMask {
  readonly kind: "relative" | "external";
  /** Exact relative offset or a side-local key for an external ordinal. */
  readonly value: string;
}

/** One matched address-derived identifier and the code segment it was found in. */
export interface IdentifierOccurrence {
  readonly code: string;
  readonly index: number;
  readonly match: string;
}

export interface AddressProjection {
  readonly maskIdentifier: (
    address: bigint,
    occurrence: IdentifierOccurrence,
  ) => AddressMask | null;
  readonly maskTextAddress: (
    address: bigint,
    location: TextAddressLocation,
  ) => AddressMask | null;
  readonly isCalleeAddress: (address: bigint) => boolean;
  /** Whether the exact calls dimension compares this callee endpoint. */
  readonly isComparedCalleeAddress: (address: bigint) => boolean;
}

interface BodyExtent {
  readonly base: bigint;
  readonly ranges: readonly (readonly [bigint, bigint])[];
}

/** Whether this dossier provides ranges for its function body. */
export const hasFunctionBodyExtent = (snapshot: FunctionSnapshot): boolean =>
  bodyExtent(snapshot) !== null;

/** Build the evidence-backed address projection for one dossier. */
export const createFunctionAddressProjection = (
  snapshot: FunctionSnapshot,
  relativeOffsets: boolean,
): AddressProjection => {
  const addresses = corroboratedAddresses(snapshot);
  const parsed = (values: readonly (string | null | undefined)[]) =>
    values
      .map((value) => parseAddress((value ?? "").toLowerCase()))
      .filter((value): value is bigint => value !== null);
  // The exact calls dimension compares only callee endpoints; it never reads
  // a callee's classification, so its thunk target stays uncompared.
  const comparedCallees = new Set(
    parsed(snapshot.dossier.callees.map((callee) => callee.address)),
  );
  const calleeAddresses = new Set([
    ...comparedCallees,
    ...parsed([
      ...snapshot.dossier.callees.map(
        (callee) => callee.classification?.thunk_target,
      ),
      ...outgoingCallTargets(snapshot),
      snapshot.dossier.procedure.classification?.thunk_target,
    ]),
  ]);
  const extent = relativeOffsets ? bodyExtent(snapshot) : null;
  const targetsBySite = referenceTargetsBySite(snapshot);
  const instructionSites = observedInstructionSites(snapshot);
  const namedSymbols = indexNamedSymbols(namedSymbolNames(snapshot));
  const observedAddress = (address: bigint): AddressMask | null => {
    if (extent !== null && contains(extent.ranges, address))
      return {
        kind: "relative",
        value: `+0x${(address - extent.base).toString(16)}`,
      };
    return addresses.has(address)
      ? { kind: "external", value: `address:${address.toString(16)}` }
      : null;
  };
  return {
    isCalleeAddress: (address) => calleeAddresses.has(address),
    isComparedCalleeAddress: (address) => comparedCallees.has(address),
    maskIdentifier: (address, occurrence) =>
      isNamedOccurrence(namedSymbols, occurrence)
        ? null
        : observedAddress(address),
    maskTextAddress: (address, location) => {
      if (location.isAddressSpaceQualified) return null;
      if (
        location.isInstructionAddress &&
        location.instructionAddress === address
      ) {
        const relative = observedAddress(address);
        if (relative?.kind === "relative") return relative;
        return instructionSites.has(address) ? relative : null;
      }
      if (
        location.isControlFlowTarget &&
        extent !== null &&
        contains(extent.ranges, address)
      )
        return observedAddress(address);
      const siteTargets =
        location.instructionAddress === null
          ? undefined
          : targetsBySite.get(location.instructionAddress);
      if (
        location.operandIndex !== null &&
        location.operandAddressOccurrences === 1 &&
        siteTargets?.some(
          (reference) =>
            reference.target === address &&
            reference.operandIndex === location.operandIndex,
        ) === true
      )
        return observedAddress(address);
      if (
        location.operandIndex !== null &&
        location.operandAddressOccurrences === 1 &&
        location.instructionAddressOccurrences === 1 &&
        siteTargets?.some(
          (reference) =>
            reference.target === address && reference.operandIndex === null,
        ) === true
      )
        return observedAddress(address);
      if (location.isControlFlowTarget && calleeAddresses.has(address))
        return observedAddress(address);
      return null;
    },
  };
};

interface ReferenceTarget {
  readonly target: bigint;
  readonly operandIndex: number | null;
}

/** Read the observed body extent without expanding an address into a lookup table. */
const bodyExtent = (snapshot: FunctionSnapshot): BodyExtent | null => {
  const body = snapshot.dossier.procedure.body;
  const base = parseAddress(snapshot.dossier.procedure.address.toLowerCase());
  if (base === null || !body.available || body.ranges.length === 0) return null;
  const ranges: [bigint, bigint][] = [];
  for (const range of body.ranges) {
    const start = parseAddress(range.start.toLowerCase());
    const end = parseAddress(range.end.toLowerCase());
    if (start === null || end === null || end < start) return null;
    ranges.push([start, end]);
  }
  ranges.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  return { base, ranges };
};

/** Address facts used for identifier matching, kept separate from numeric uses. */
const corroboratedAddresses = (snapshot: FunctionSnapshot): Set<bigint> => {
  const addresses = new Set<bigint>();
  const add = (value: string | null | undefined) => {
    const parsed = parseAddress((value ?? "").toLowerCase());
    if (parsed !== null) addresses.add(parsed);
  };
  const { dossier } = snapshot;
  add(dossier.procedure.address);
  add(dossier.procedure.classification?.thunk_target);
  if (dossier.procedure.body.available)
    for (const range of dossier.procedure.body.ranges) {
      add(range.start);
      add(range.end);
    }
  for (const block of dossier.basic_blocks) {
    add(block.start);
    add(block.end);
    for (const successor of block.successors) add(successor);
  }
  for (const comment of dossier.comments) add(comment.address);
  for (const edge of [
    ...dossier.incoming_references,
    ...dossier.outgoing_references,
  ]) {
    add(edge.source_address);
    add(edge.target_address);
    for (const identity of [edge.source_procedure, edge.target_procedure]) {
      add(identity?.address);
      add(identity?.classification?.thunk_target);
    }
  }
  for (const identity of [...dossier.callers, ...dossier.callees]) {
    add(identity.address);
    add(identity.classification?.thunk_target);
  }
  for (const item of [
    ...dossier.referenced_strings,
    ...dossier.referenced_names,
  ]) {
    add(item.address);
    add(item.source_address);
  }
  return addresses;
};

/**
 * Typed calls and jumps into another procedure name callees the callees facet
 * may omit. A call classification counts even without reference flags.
 */
const outgoingCallTargets = (
  snapshot: FunctionSnapshot,
): (string | null | undefined)[] => {
  const entry = parseAddress(snapshot.dossier.procedure.address.toLowerCase());
  return snapshot.dossier.outgoing_references.flatMap((edge) => {
    const target = edge.target_procedure;
    const intoOtherProcedure =
      target !== null && parseAddress(target.address.toLowerCase()) !== entry;
    // Producers attach call classifications only to call references, so any
    // classification other than none names a call target.
    const classifiedCall =
      edge.call !== undefined && edge.call.classification !== "none";
    const typedCall =
      edge.kind.available &&
      (edge.kind.call || (edge.kind.jump && intoOtherProcedure));
    // An interior target also names the entry of the procedure that contains it.
    return classifiedCall || typedCall
      ? [
          edge.target_address,
          ...(intoOtherProcedure ? [target?.address] : []),
          target?.classification?.thunk_target,
        ]
      : [];
  });
};

interface NamedSymbolIndex {
  readonly names: ReadonlySet<string>;
  /** Named symbols keyed by their final run of word characters. */
  readonly namesByLastRun: ReadonlyMap<string, readonly string[]>;
}

const lastWordRun = (value: string): string | undefined =>
  /[0-9A-Za-z_]+$/u.exec(value)?.[0];

/** Index named symbols once, in linear space, so each token is a direct lookup. */
const indexNamedSymbols = (names: ReadonlySet<string>): NamedSymbolIndex => {
  const namesByLastRun = new Map<string, string[]>();
  for (const name of names) {
    const run = lastWordRun(name);
    if (run === undefined) continue;
    const bucket = namesByLastRun.get(run) ?? [];
    bucket.push(name);
    namesByLastRun.set(run, bucket);
  }
  return { names, namesByLastRun };
};

/**
 * Whether the matched identifier spells a named symbol, alone or as the tail of
 * a qualified name whose exact qualifier precedes it in the same code segment.
 */
const isNamedOccurrence = (
  { names, namesByLastRun }: NamedSymbolIndex,
  { code, index, match }: IdentifierOccurrence,
): boolean => {
  if (names.has(match)) return true;
  const run = lastWordRun(match);
  return (
    run !== undefined &&
    (namesByLastRun.get(run) ?? []).some(
      (name) =>
        name.length > match.length &&
        name.endsWith(match) &&
        code.endsWith(name.slice(0, -match.length), index),
    )
  );
};

/** A producer-reported named symbol is an identity even when it looks address-derived. */
const namedSymbolNames = (snapshot: FunctionSnapshot): Set<string> => {
  const { dossier } = snapshot;
  return new Set(
    [
      dossier.procedure,
      ...dossier.callers,
      ...dossier.callees,
      ...[
        ...dossier.incoming_references,
        ...dossier.outgoing_references,
      ].flatMap((edge) => [edge.source_procedure, edge.target_procedure]),
    ].flatMap((identity) =>
      identity !== null && nativeSymbolOrigin(identity.symbol) === "named"
        ? [identity.name]
        : [],
    ),
  );
};

/** Reference facts are matched by source site and operand, never by value alone. */
const referenceTargetsBySite = (
  snapshot: FunctionSnapshot,
): Map<bigint, ReferenceTarget[]> => {
  const targets = new Map<bigint, ReferenceTarget[]>();
  const add = (source: string, target: string, operandIndex: number | null) => {
    const sourceAddress = parseAddress(source.toLowerCase());
    const targetAddress = parseAddress(target.toLowerCase());
    if (sourceAddress === null || targetAddress === null) return;
    const siteTargets = targets.get(sourceAddress) ?? [];
    siteTargets.push({ target: targetAddress, operandIndex });
    targets.set(sourceAddress, siteTargets);
  };
  const { dossier } = snapshot;
  for (const edge of dossier.outgoing_references)
    if (
      edge.kind.available &&
      (edge.kind.call ||
        edge.kind.jump ||
        edge.kind.data ||
        edge.kind.read ||
        edge.kind.write)
    )
      add(edge.source_address, edge.target_address, edge.kind.operand_index);
  for (const item of [
    ...dossier.referenced_strings,
    ...dossier.referenced_names,
  ])
    add(item.source_address, item.address, null);
  return targets;
};

const observedInstructionSites = (snapshot: FunctionSnapshot): Set<bigint> => {
  const addresses = new Set<bigint>();
  const add = (value: string | null | undefined) => {
    const parsed = parseAddress((value ?? "").toLowerCase());
    if (parsed !== null) addresses.add(parsed);
  };
  add(snapshot.dossier.procedure.address);
  for (const block of snapshot.dossier.basic_blocks) {
    add(block.start);
    add(block.end);
  }
  for (const edge of snapshot.dossier.outgoing_references)
    add(edge.source_address);
  for (const comment of snapshot.dossier.comments) add(comment.address);
  for (const item of [
    ...snapshot.dossier.referenced_strings,
    ...snapshot.dossier.referenced_names,
  ])
    add(item.source_address);
  return addresses;
};

/** Binary search over sorted inclusive ranges; bodies are never expanded. */
const contains = (
  ranges: readonly (readonly [bigint, bigint])[],
  address: bigint,
): boolean => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (range === undefined) return false;
    if (address < range[0]) high = middle - 1;
    else if (address > range[1]) low = middle + 1;
    else return true;
  }
  return false;
};
