import noBufferDeepEquality from "./no-buffer-deep-equality.mjs";
import cancellationCause from "./cancellation-cause.mjs";

import noEvidenceJsonPreadmission from "./rules/no-evidence-json-preadmission.mjs";
import noFixtureRootCleanup from "./rules/no-fixture-root-cleanup.mjs";
import noPositionalToolContract from "./rules/no-positional-tool-contract.mjs";
import noSharedModuleMock from "./rules/no-shared-module-mock.mjs";
import noLocaleCompare from "./rules/no-locale-compare.mjs";
import noBabelVisitorKeys from "./rules/no-babel-visitor-keys.mjs";

export default {
  meta: { name: "rea" },
  rules: {
    "no-buffer-deep-equality": noBufferDeepEquality,
    "cancellation-cause": cancellationCause,
    "no-evidence-json-preadmission": noEvidenceJsonPreadmission,
    "no-fixture-root-cleanup": noFixtureRootCleanup,
    "no-positional-tool-contract": noPositionalToolContract,
    "no-shared-module-mock": noSharedModuleMock,
    "no-locale-compare": noLocaleCompare,
    "no-babel-visitor-keys": noBabelVisitorKeys,
  },
};
