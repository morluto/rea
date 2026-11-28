import type { OutputCallPath } from "./callPathSchemas.js";
import type { FunctionSnapshot } from "./functionDossierEvidence.js";

type CitedNode = OutputCallPath["nodes"][number];
type CitedEdge = OutputCallPath["edges"][number];

/** The one shape of a cited path; size accounting measures its skeleton too. */
const citedPathRecord = (
  nodes: CitedNode[],
  edges: CitedEdge[],
  evidenceLinks: string[],
): OutputCallPath => ({
  hops: edges.length,
  nodes,
  edges,
  evidence_links: evidenceLinks,
});

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

interface Measured<T> {
  readonly value: T;
  readonly bytes: number;
}

/**
 * Owner of cited path parts. Each node and edge record is built once per graph
 * position and keeps its exact serialized size, so a candidate path is
 * measured from cached parts before any path is assembled, and every returned
 * path shares those records.
 */
export class CitedPathParts {
  readonly #nodes = new Map<string, Measured<CitedNode>>();
  readonly #edges = new Map<string, Measured<CitedEdge>>();
  readonly #links = new Map<string, number>();

  constructor(
    private readonly snapshots: ReadonlyMap<string, FunctionSnapshot>,
  ) {}

  /** Exact serialized size of the path that {@link assemble} would return. */
  measure(addresses: readonly string[]): number {
    const parts = this.#parts(addresses);
    const skeleton = jsonBytes(citedPathRecord([], [], []));
    const listBytes = (sizes: readonly number[]): number =>
      sizes.reduce((sum, size) => sum + size, 0) +
      Math.max(0, sizes.length - 1);
    return (
      skeleton +
      String(parts.edges.length).length -
      1 +
      listBytes(parts.nodes.map(({ bytes }) => bytes)) +
      listBytes(parts.edges.map(({ bytes }) => bytes)) +
      listBytes(parts.links.map((link) => this.#linkBytes(link)))
    );
  }

  assemble(addresses: readonly string[]): OutputCallPath {
    const parts = this.#parts(addresses);
    return citedPathRecord(
      parts.nodes.map(({ value }) => value),
      parts.edges.map(({ value }) => value),
      parts.links,
    );
  }

  #parts(addresses: readonly string[]): {
    readonly nodes: readonly Measured<CitedNode>[];
    readonly edges: readonly Measured<CitedEdge>[];
    readonly links: string[];
  } {
    const nodes = addresses.map((address, index) =>
      this.#node(address, index > 0 ? addresses[index - 1] : undefined),
    );
    const edges = addresses.slice(0, -1).map((source, index) => {
      const target = addresses[index + 1];
      if (target === undefined)
        throw new TypeError("Call path has an invalid edge");
      return this.#edge(source, target);
    });
    const links = [
      ...new Set(
        edges
          .flatMap(({ value }) => value.evidence_links)
          .concat(nodes.flatMap(({ value }) => value.evidence_links)),
      ),
    ];
    return { nodes, edges, links };
  }

  #node(address: string, previous: string | undefined): Measured<CitedNode> {
    const snapshot = this.snapshots.get(address);
    // A node without its own dossier is cited by its caller's Evidence.
    const key =
      snapshot === undefined ? `${previous ?? ""}>${address}` : address;
    let node = this.#nodes.get(key);
    if (node === undefined) {
      const value: CitedNode = {
        address,
        name: snapshot?.dossier.procedure.name ?? null,
        evidence_links: snapshotLinks(
          snapshot ??
            (previous === undefined ? undefined : this.snapshots.get(previous)),
        ),
      };
      node = { value, bytes: jsonBytes(value) };
      this.#nodes.set(key, node);
    }
    return node;
  }

  #edge(source: string, target: string): Measured<CitedEdge> {
    const key = `${source}>${target}`;
    let edge = this.#edges.get(key);
    if (edge === undefined) {
      const value: CitedEdge = {
        source,
        target,
        evidence_links: snapshotLinks(this.snapshots.get(source)),
      };
      edge = { value, bytes: jsonBytes(value) };
      this.#edges.set(key, edge);
    }
    return edge;
  }

  #linkBytes(link: string): number {
    let bytes = this.#links.get(link);
    if (bytes === undefined) {
      bytes = jsonBytes(link);
      this.#links.set(link, bytes);
    }
    return bytes;
  }
}

export const snapshotLinks = (
  snapshot: FunctionSnapshot | undefined,
): string[] => {
  if (snapshot === undefined)
    throw new TypeError("Every call-path claim requires supporting Evidence");
  return [snapshot.evidence.evidence_id];
};
