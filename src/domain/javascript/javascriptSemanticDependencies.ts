/** An immutable persistent binary trie over one state's binding identities. */
export type SemanticDependencyProof =
  | true
  | {
      readonly zero: SemanticDependencyProof;
      readonly one: SemanticDependencyProof;
    }
  | undefined;

/**
 * Identity layout belongs to the indexed state, not to a query or its effects.
 * Every proof has the same height. Union shares unchanged branches, so aliases
 * add a path rather than copying their dependency's transitive membership set.
 */
export class SemanticDependencyProofs {
  private readonly indices = new Map<string, number>();
  private readonly singletons = new Map<string, SemanticDependencyProof>();
  private readonly height: number;

  constructor(bindings: Iterable<string>) {
    for (const binding of bindings)
      this.indices.set(binding, this.indices.size);
    this.height = Math.ceil(Math.log2(Math.max(1, this.indices.size)));
  }

  binding(binding: string): SemanticDependencyProof {
    const prior = this.singletons.get(binding);
    if (prior !== undefined) return prior;
    const index = this.index(binding);
    let proof: SemanticDependencyProof = true;
    for (let bit = 0; bit < this.height; bit++) {
      const one = Math.floor(index / 2 ** bit) % 2 === 1;
      proof = Object.freeze({
        zero: one ? undefined : proof,
        one: one ? proof : undefined,
      });
    }
    this.singletons.set(binding, proof);
    return proof;
  }

  union(
    first: SemanticDependencyProof,
    second: SemanticDependencyProof,
  ): SemanticDependencyProof {
    if (first === second || second === undefined) return first;
    if (first === undefined) return second;
    if (first === true || second === true) return true;
    const zero = this.union(first.zero, second.zero);
    const one = this.union(first.one, second.one);
    if (zero === first.zero && one === first.one) return first;
    if (zero === second.zero && one === second.one) return second;
    return Object.freeze({ zero, one });
  }

  intersects(
    proof: SemanticDependencyProof,
    active: ReadonlyMap<string, number>,
  ): boolean {
    for (const binding of active.keys())
      if (this.has(proof, binding)) return true;
    return false;
  }

  has(proof: SemanticDependencyProof, binding: string): boolean {
    const index = this.index(binding);
    for (let bit = this.height - 1; bit >= 0; bit--) {
      if (proof === undefined) return false;
      if (proof === true) return true;
      proof = Math.floor(index / 2 ** bit) % 2 === 1 ? proof.one : proof.zero;
    }
    return proof === true;
  }

  private index(binding: string): number {
    const index = this.indices.get(binding);
    if (index === undefined)
      throw new TypeError(`Unindexed semantic dependency: ${binding}`);
    return index;
  }
}
