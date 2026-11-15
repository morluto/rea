import type { BigIntStats } from "node:fs";

import type { ArtifactResourceScope } from "../resources/index.js";
import type {
  ReferenceSourceEntry,
  ReferenceSourceExclusionKind,
  ReferenceSourceResult,
  ReferenceSourceRootFailure,
} from "./ReferenceSourceReaderTypes.js";

/** Traversal state private to the reader; not part of its contract. */
export type PendingDirectory = {
  readonly path: string;
};

export type TraversalState = {
  readonly resources: ArtifactResourceScope;
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly signal?: AbortSignal;
  /** Prepare policy after identity admission and opening, before enumeration; refusal closes the owned handle. */
  readonly beforeDirectory?: (
    path: string,
  ) => Promise<ReferenceSourceResult<undefined>>;
  readonly shouldExclude?: (
    path: string,
    kind: ReferenceSourceExclusionKind,
  ) => boolean;
  readonly entries: ReferenceSourceEntry[];
  readonly exclusions: Array<{
    readonly path: string;
    readonly kind: ReferenceSourceExclusionKind;
  }>;
  readonly pending: PendingDirectory[];
  rootFailure?: ReferenceSourceRootFailure;
  rootFailureCause?: { readonly value: unknown };
  bytesRead: number;
};

export type StableFileRequest = {
  readonly resources: ArtifactResourceScope;
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly absolute: string;
  readonly path: string;
  readonly expected: BigIntStats;
  readonly signal?: AbortSignal;
};
