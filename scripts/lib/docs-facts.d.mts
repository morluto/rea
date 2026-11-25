import type { ProductCatalog } from "./product-catalog.mjs";

export function skillReferenceIssues(
  skillRoot: string,
): Promise<readonly string[]>;

/** Repository-relative roots that the literal tool count check scans. */
export const LIVING_PROSE_ROOTS: readonly string[];

/** Whether the literal tool count check scans this repository-relative path. */
export function isLivingProsePath(path: string): boolean;

/** Literal tool counts in living prose, which the catalog owns. */
export function literalToolCountIssues(
  root: string,
): Promise<readonly string[]>;

export function readmeFactIssues(root: string): Promise<readonly string[]>;

export function documentationFactIssues(
  root: string,
  catalog: ProductCatalog,
): Promise<readonly string[]>;
export function assertDocumentationFacts(
  root: string,
  catalog: ProductCatalog,
): Promise<void>;
