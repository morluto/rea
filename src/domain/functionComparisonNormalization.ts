import canonicalize from "canonicalize";

import type {
  FunctionCollection,
  FunctionSnapshot,
} from "./functionDossierEvidence.js";
import type { FunctionComparisonResult } from "./functionComparisonSchemas.js";

export const identityProjection = (snapshot: FunctionSnapshot) => ({
  name: snapshot.procedure.name,
  signature: snapshot.procedure.signature,
  locals: snapshot.procedure.locals
    .map(({ description }) => description)
    .sort(),
});

export const functionMatch = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
): FunctionComparisonResult["function_match"] => {
  if (
    !isAutoName(left.procedure.name) &&
    left.procedure.name === right.procedure.name
  )
    return {
      status: "matched",
      method: "symbol",
      left_name: left.procedure.name,
      right_name: right.procedure.name,
    };
  return {
    status:
      left.procedure.name === right.procedure.name ? "ambiguous" : "mismatched",
    method: "explicit",
    left_name: left.procedure.name,
    right_name: right.procedure.name,
  };
};

export const normalizeCfg = (
  blocks: FunctionSnapshot["collections"]["basic_blocks"]["items"],
): readonly unknown[] | null => {
  const parsed = blocks.map((block) => ({
    block,
    start: parseAddress(block.start),
    end: parseAddress(block.end),
  }));
  if (parsed.some(({ start, end }) => start === null || end === null))
    return null;
  const ordered = parsed.sort((left, right) =>
    (left.start ?? 0n) < (right.start ?? 0n) ? -1 : 1,
  );
  if (new Set(ordered.map(({ block }) => block.start)).size !== ordered.length)
    return null;
  if (ordered.some(({ start, end }) => (end ?? 0n) <= (start ?? 0n)))
    return null;
  const indices = new Map(
    ordered.map(({ block }, index) => [block.start, index]),
  );
  const graph = [];
  for (const { block, start, end } of ordered) {
    const successors = block.successors.map((address) => indices.get(address));
    if (successors.some((index) => index === undefined)) return null;
    graph.push({
      size: String((end ?? 0n) - (start ?? 0n)),
      successors: successors.sort((left, right) => (left ?? 0) - (right ?? 0)),
    });
  }
  return graph;
};

export const referenceProjection = (snapshot: FunctionSnapshot) =>
  sorted([
    ...snapshot.collections.incoming_references.items.map((item) => ({
      direction: "in",
      source: item.source_procedure?.name ?? null,
      target: item.target_procedure?.name ?? null,
    })),
    ...snapshot.collections.outgoing_references.items.map((item) => ({
      direction: "out",
      source: item.source_procedure?.name ?? null,
      target: item.target_procedure?.name ?? null,
    })),
  ]);

export const commentProjection = (
  snapshot: FunctionSnapshot,
): readonly unknown[] | null => {
  const values = snapshot.collections.comments.items.map(
    ({ address, kind, text }) => ({
      offset: relativeAddress(address, snapshot.procedure.address),
      kind,
      text,
    }),
  );
  return values.some(({ offset }) => offset === null) ? null : sorted(values);
};

export const stringAndNameProjection = (
  snapshot: FunctionSnapshot,
): readonly unknown[] | null => {
  const values = [
    ...snapshot.collections.referenced_strings.items.map(
      ({ source_address: sourceAddress, value }) => ({
        kind: "string",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.procedure.address,
        ),
        value,
      }),
    ),
    ...snapshot.collections.referenced_names.items.map(
      ({ source_address: sourceAddress, value }) => ({
        kind: "name",
        source_offset: relativeAddress(
          sourceAddress,
          snapshot.procedure.address,
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
  [...values].sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );

export const combineCoverage = <Item>(
  left: FunctionCollection<Item>,
  right: FunctionCollection<Item>,
): FunctionCollection<Item> => ({
  items: [...left.items, ...right.items],
  total:
    left.total === null || right.total === null
      ? null
      : left.total + right.total,
  complete: left.complete && right.complete,
  truncated: left.truncated || right.truncated,
});

export const project = <Input, Output>(
  collection: FunctionCollection<Input>,
  mapper: (item: Input) => Output,
): Output[] => collection.items.map(mapper);

export const isAutoName = (name: string): boolean =>
  /^(?:sub_[0-9a-f]+|fcn\.)/iu.test(name);

const parseAddress = (value: string): bigint | null =>
  /^0x[0-9a-f]+$/iu.test(value) ? BigInt(value) : null;

const relativeAddress = (value: string, base: string): string | null => {
  const parsed = parseAddress(value);
  const parsedBase = parseAddress(base);
  return parsed === null || parsedBase === null || parsed < parsedBase
    ? null
    : String(parsed - parsedBase);
};

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Function normalization could not canonicalize data");
  return encoded;
};
