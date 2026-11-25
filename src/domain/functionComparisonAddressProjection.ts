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
  /** Whether a masked address is a call endpoint or the target of one. */
  readonly isCallEndpointAddress: (address: bigint) => boolean;
  /** Whether the exact calls dimension compares this caller or callee. */
  readonly isComparedCallEndpointAddress: (address: bigint) => boolean;
  /** Whether named-symbol matching spent its code-unit allowance. */
  readonly namedSymbolWalkExhausted: () => boolean;
}

interface BodyExtent {
  readonly base: bigint;
  readonly ranges: readonly (readonly [bigint, bigint])[];
}

/** Whether this dossier provides ranges for its function body. */
export const hasFunctionBodyExtent = (snapshot: FunctionSnapshot): boolean =>
  bodyExtent(snapshot) !== null;

const parsedAddresses = (
  values: readonly (string | null | undefined)[],
): bigint[] =>
  values
    .map((value) => parseAddress((value ?? "").toLowerCase()))
    .filter((value): value is bigint => value !== null);

/**
 * Callee targets that control-flow operands may mask, every call endpoint the
 * views track, and the endpoints the exact calls dimension compares.
 */
const callEndpointAddresses = (snapshot: FunctionSnapshot) => {
  const callees = parsedAddresses(
    snapshot.dossier.callees.map((callee) => callee.address),
  );
  const calleeAddresses = new Set([
    ...callees,
    ...parsedAddresses([
      ...snapshot.dossier.callees.map(
        (callee) => callee.classification?.thunk_target,
      ),
      ...outgoingCallTargets(snapshot),
      snapshot.dossier.procedure.classification?.thunk_target,
    ]),
  ]);
  // The exact calls dimension compares caller and callee endpoints; it never
  // reads their classifications, so the thunk target of a listed endpoint or a
  // referenced procedure stays uncompared even when its address is also listed.
  // The function's own thunk target is its listed callee edge, which is compared.
  const callers = snapshot.dossier.callers;
  const thunkTargets = new Set(
    parsedAddresses(
      [
        ...snapshot.dossier.callees,
        ...callers,
        ...snapshot.dossier.outgoing_references.map(
          (edge) => edge.target_procedure,
        ),
        ...snapshot.dossier.incoming_references.map(
          (edge) => edge.source_procedure,
        ),
      ].map((procedure) => procedure?.classification?.thunk_target),
    ),
  );
  const listedEndpoints = [
    ...callees,
    ...parsedAddresses(callers.map((caller) => caller.address)),
  ];
  const comparedCallEndpoints = new Set(
    listedEndpoints.filter((address) => !thunkTargets.has(address)),
  );
  const callEndpoints = new Set([
    ...calleeAddresses,
    ...listedEndpoints,
    ...parsedAddresses([
      ...callers.map((caller) => caller.classification?.thunk_target),
      ...incomingCallSources(snapshot),
    ]),
  ]);
  return { calleeAddresses, callEndpoints, comparedCallEndpoints };
};

/** Build the evidence-backed address projection for one dossier. */
export const createFunctionAddressProjection = (
  snapshot: FunctionSnapshot,
  relativeOffsets: boolean,
  namedSymbolCodeUnits: number,
): AddressProjection => {
  const addresses = corroboratedAddresses(snapshot);
  const { calleeAddresses, callEndpoints, comparedCallEndpoints } =
    callEndpointAddresses(snapshot);
  const extent = relativeOffsets ? bodyExtent(snapshot) : null;
  const targetsBySite = referenceTargetsBySite(snapshot);
  const instructionSites = observedInstructionSites(snapshot);
  const namedSymbols = indexNamedSymbols(
    namedSymbolNames(snapshot),
    namedSymbolCodeUnits,
  );
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
    namedSymbolWalkExhausted: () => namedSymbols.exhausted,
    isCallEndpointAddress: (address) => callEndpoints.has(address),
    isComparedCallEndpointAddress: (address) =>
      comparedCallEndpoints.has(address),
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
    // Producers attach a call reference only to calls they enumerated, so its
    // presence names a call whatever its sub-classification (Hopper reports
    // type 0 as none), as observedCallRoutes reads it when kind is unavailable.
    const classifiedCall = edge.call !== undefined;
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

/**
 * Typed incoming calls name callers the callers facet may omit: the call site,
 * the procedure that contains it and that procedure's thunk target.
 */
const incomingCallSources = (
  snapshot: FunctionSnapshot,
): (string | null | undefined)[] => {
  const entry = parseAddress(snapshot.dossier.procedure.address.toLowerCase());
  return snapshot.dossier.incoming_references.flatMap((edge) => {
    const source = edge.source_procedure;
    const fromOtherProcedure =
      source !== null && parseAddress(source.address.toLowerCase()) !== entry;
    const classifiedCall = edge.call !== undefined;
    const typedCall =
      edge.kind.available &&
      (edge.kind.call || (edge.kind.jump && fromOtherProcedure));
    return classifiedCall || typedCall
      ? [
          edge.source_address,
          ...(fromOtherProcedure ? [source?.address] : []),
          source?.classification?.thunk_target,
        ]
      : [];
  });
};

/**
 * Code units the named-symbol walks of one side may examine when the caller
 * omits `max_named_symbol_code_units`. A long chain of repeated qualifiers
 * would otherwise make every token walk back through all earlier ones before
 * the bounded diff starts; past this work the projection stops matching and its
 * views report unknown. It is an REA work allowance, not a format limit.
 */
export const DEFAULT_NAMED_SYMBOL_CODE_UNITS = 1_000_000;

interface NamedSymbolIndex {
  readonly names: ReadonlySet<string>;
  /** Named symbols spelled backwards, sorted by code unit. */
  readonly reversed: readonly string[];
  remainingSteps: number;
  /** Whether a walk stopped at the limit, so a match may have been missed. */
  exhausted: boolean;
}

/** Index named symbols once, spelled backwards, in space linear in their text. */
const indexNamedSymbols = (
  names: ReadonlySet<string>,
  codeUnits: number,
): NamedSymbolIndex => ({
  names,
  // Code units, as the walk reads them, so surrogate pairs reverse consistently.
  reversed: [...names].map((name) => name.split("").reverse().join("")).sort(),
  remainingSteps: codeUnits,
  exhausted: false,
});

/**
 * The range of reversed names, within one that shares a prefix of `depth` code
 * units, whose next code unit is `unit`. Names that end at `depth` sort first.
 */
const narrow = (
  reversed: readonly string[],
  range: readonly [number, number],
  depth: number,
  unit: number,
): [number, number] => {
  const at = (index: number) => {
    const name = reversed[index] ?? "";
    return name.length > depth ? name.charCodeAt(depth) : -1;
  };
  const bound = (inclusive: boolean) => {
    let [low, high] = range;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (inclusive ? at(middle) <= unit : at(middle) < unit) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return [bound(false), bound(true)];
};

/**
 * Whether the matched identifier spells a named symbol, alone or as the tail of
 * a qualified name whose exact qualifier precedes it in the same code segment.
 * The walk goes back from the token's end, narrowing the sorted reversed names,
 * and stops for good once the projection has spent its code-unit allowance.
 */
const isNamedOccurrence = (
  index: NamedSymbolIndex,
  { code, index: start, match }: IdentifierOccurrence,
): boolean => {
  if (index.names.has(match)) return true;
  let range: [number, number] = [0, index.reversed.length];
  for (let depth = 0; depth < start + match.length; depth += 1) {
    if (index.remainingSteps <= 0) {
      index.exhausted = true;
      return false;
    }
    index.remainingSteps -= 1;
    const unit =
      depth < match.length
        ? match.charCodeAt(match.length - 1 - depth)
        : code.charCodeAt(start - 1 - (depth - match.length));
    range = narrow(index.reversed, range, depth, unit);
    if (range[0] >= range[1]) return false;
    // A name that ends here covers the token and at least one qualifier unit.
    if (
      depth >= match.length &&
      (index.reversed[range[0]] ?? "").length === depth + 1
    )
      return true;
  }
  return false;
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
