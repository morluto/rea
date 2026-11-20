import type { TestContext } from "vitest";

import { importReferenceSource as importOwned } from "../../src/application/ReferenceSourceImport.js";
import type { ReferenceSourceImportOptions } from "../../src/application/ReferenceSourceImportTypes.js";
import { readReferenceSource as readOwned } from "../../src/reference/ReferenceSourceReader.js";
import type { ReferenceSourceReaderOptions } from "../../src/reference/ReferenceSourceReaderTypes.js";
import { noFollowOpenSupported } from "../../src/reference/ReferenceSourceReaderValidate.js";
import { withArtifactResourceScope } from "../fixtures/artifactInventory.js";

/** The reader refuses every tree as `unsupported` without no-follow opens. */
export const referenceSourceReadsSupported = noFollowOpenSupported();

/** Skip a test that needs a reference-source read on hosts that refuse them. */
export const requireReferenceSourceReads = (
  context: Pick<TestContext, "skip">,
): void => {
  if (!referenceSourceReadsSupported)
    context.skip("Safe no-follow file opens are unavailable on this host");
};

/** Run one reference-source test operation with an awaited resource owner. */
export const importReferenceSource = (options: ReferenceSourceImportOptions) =>
  withArtifactResourceScope((resources) => importOwned(options, resources));

/** Read one reference-source test tree with an awaited resource owner. */
export const readReferenceSource = (
  root: string,
  options: ReferenceSourceReaderOptions = {},
) =>
  withArtifactResourceScope((resources) => readOwned(root, resources, options));
