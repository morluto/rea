import { canonicalJson } from "./comparisonSemantics.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import type { FunctionComparisonResult } from "./functionComparisonSchemas.js";

export const identityProjection = (snapshot: FunctionSnapshot) => ({
  name: snapshot.dossier.procedure.name,
  signature: snapshot.dossier.procedure.signature,
  locals: snapshot.dossier.procedure.locals
    .map(({ description }) => description)
    .sort(),
});

export const functionMatch = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): FunctionComparisonResult["function_match"] => {
  if (
    !isAutoName(left.dossier.procedure.name) &&
    left.dossier.procedure.name === right.dossier.procedure.name
  )
    return {
      status: "matched",
      method: "symbol",
      left_name: left.dossier.procedure.name,
      right_name: right.dossier.procedure.name,
    };
  return {
    status:
      left.dossier.procedure.name === right.dossier.procedure.name
        ? "ambiguous"
        : "mismatched",
    method: "explicit",
    left_name: left.dossier.procedure.name,
    right_name: right.dossier.procedure.name,
  };
};

export const normalizeCfg = (
  blocks: FunctionSnapshot["dossier"]["basic_blocks"],
): readonly unknown[] | null => {
  const parsed: {
    block: (typeof blocks)[number];
    start: bigint;
    end: bigint;
  }[] = [];
  for (const block of blocks) {
    const start = parseAddress(block.start);
    const end = parseAddress(block.end);
    if (start === null || end === null || end <= start) return null;
    parsed.push({ block, start, end });
  }
  const ordered = parsed.sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  );
  if (new Set(ordered.map(({ start }) => start)).size !== ordered.length)
    return null;
  const indices = new Map(ordered.map(({ start }, index) => [start, index]));
  const graph = [];
  for (const { block, start, end } of ordered) {
    const successors: number[] = [];
    for (const address of block.successors) {
      const parsedAddress = parseAddress(address);
      if (parsedAddress === null) return null;
      const index = indices.get(parsedAddress);
      if (index === undefined) return null;
      successors.push(index);
    }
    graph.push({
      size: String(end - start),
      successors: successors.sort((left, right) => left - right),
    });
  }
  return graph;
};

export const referenceProjection = (snapshot: FunctionSnapshot) =>
  sorted([
    ...snapshot.dossier.incoming_references.map((item) => ({
      direction: "in",
      source: item.source_procedure?.name ?? null,
      target: item.target_procedure?.name ?? null,
    })),
    ...snapshot.dossier.outgoing_references.map((item) => ({
      direction: "out",
      source: item.source_procedure?.name ?? null,
      target: item.target_procedure?.name ?? null,
    })),
  ]);

export const referenceKindProjection = (
  snapshot: FunctionSnapshot,
): readonly unknown[] | null => {
  const edges = [
    ...snapshot.dossier.incoming_references.map((edge) => ({
      direction: "in",
      edge,
    })),
    ...snapshot.dossier.outgoing_references.map((edge) => ({
      direction: "out",
      edge,
    })),
  ];
  if (edges.some(({ edge }) => !edge.kind.available)) return null;
  return sorted(
    edges.map(({ direction, edge }) => {
      if (!edge.kind.available)
        throw new TypeError(
          "Reference-kind availability changed during projection",
        );
      return {
        direction,
        source: edge.source_procedure?.name ?? null,
        target: edge.target_procedure?.name ?? null,
        type: edge.kind.type,
        flow: edge.kind.flow,
        call: edge.kind.call,
        jump: edge.kind.jump,
        data: edge.kind.data,
        read: edge.kind.read,
        write: edge.kind.write,
        indirect: edge.kind.indirect,
        computed: edge.kind.computed,
        conditional: edge.kind.conditional,
        terminal: edge.kind.terminal,
        primary: edge.kind.primary,
        operand_index: edge.kind.operand_index,
        external: edge.kind.external,
      };
    }),
  );
};

export const commentProjection = (
  snapshot: FunctionSnapshot,
): readonly unknown[] | null => {
  const values = snapshot.dossier.comments.map(({ address, kind, text }) => ({
    offset: relativeAddress(address, snapshot.dossier.procedure.address),
    kind,
    text,
  }));
  return values.some(({ offset }) => offset === null) ? null : sorted(values);
};

export const stringAndNameProjection = (
  snapshot: FunctionSnapshot,
): readonly unknown[] | null => {
  const values = [
    ...snapshot.dossier.referenced_strings.map(
      ({ source_address: sourceAddress, value }) => ({
        kind: "string",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.dossier.procedure.address,
        ),
        value,
      }),
    ),
    ...snapshot.dossier.referenced_names.map(
      ({ source_address: sourceAddress, value }) => ({
        kind: "name",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.dossier.procedure.address,
        ),
        value,
      }),
    ),
  ];
  return values.some(({ source_offset: offset }) => offset === null)
    ? null
    : sorted(values);
};

export const sorted = (values: readonly unknown[]): readonly unknown[] =>
  values
    .map((value) => ({
      value,
      json: canonicalJson(value, "Function normalization"),
    }))
    .sort((left, right) => compareUnicodeCodePoints(left.json, right.json))
    .map(({ value }) => value);

/** Recognize address-derived procedure names without excluding named FUN_ symbols. */
export const isAutoName = (name: string): boolean =>
  /^(?:sub_[0-9a-f]+|fcn\.[0-9a-f]+|FUN_[0-9a-f]+)$/iu.test(name);

const parseAddress = (value: string): bigint | null =>
  /^0x[0-9a-f]+$/iu.test(value) ? BigInt(value) : null;

const relativeAddress = (value: string, base: string): string | null => {
  const parsed = parseAddress(value);
  const parsedBase = parseAddress(base);
  return parsed === null || parsedBase === null || parsed < parsedBase
    ? null
    : String(parsed - parsedBase);
};
