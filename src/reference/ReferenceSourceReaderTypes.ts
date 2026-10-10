import { type BigIntStats } from "node:fs";

import { type Result } from "../domain/result.js";

export interface ReferenceSourceReaderOptions {
  readonly signal?: AbortSignal;
  readonly shouldExclude?: (path: string) => boolean;
}

export type ReferenceSourceFailureCode =
  | "cancelled"
  | "changed"
  | "io"
  | "symlink"
  | "unsupported";

export type ReferenceSourceEntry =
  | {
      readonly status: "read";
      readonly kind: "file";
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly size: number;
    }
  | {
      readonly status: "read";
      readonly kind: "directory";
      readonly path: string;
    }
  | {
      readonly status: "read";
      readonly kind: "symlink";
      readonly path: string;
      /** Internal and relative missing targets are resolved from the inventory root. */
      readonly target: string;
      readonly targetState: "internal" | "external" | "missing";
    }
  | {
      readonly status: "failed";
      readonly kind: "file" | "directory" | "symlink" | "other" | "unknown";
      readonly path: string;
      readonly code: ReferenceSourceFailureCode;
      readonly message: string;
      readonly size?: number;
    };

export interface ReferenceSourceRead {
  readonly root: string;
  readonly entries: readonly ReferenceSourceEntry[];
  readonly bytesRead: number;
  /** Node exposes no portable openat traversal; pathname identity is checked around each operation. */
  readonly limitations: readonly string[];
}

export interface ReferenceSourceReaderError {
  readonly tag: "reference-source-reader";
  readonly code: "cancelled" | "invalid-root" | "io" | "unsupported";
  readonly message: string;
}

export type PendingDirectory = {
  readonly path: string;
};

export type TraversalState = {
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly signal?: AbortSignal;
  readonly shouldExclude?: (path: string) => boolean;
  readonly entries: ReferenceSourceEntry[];
  readonly pending: PendingDirectory[];
  bytesRead: number;
};

export type StableFileRequest = {
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly absolute: string;
  readonly path: string;
  readonly expected: BigIntStats;
  readonly signal?: AbortSignal;
};

export type ReferenceSourceResult<T> = Result<T, ReferenceSourceReaderError>;
