import noBufferDeepEquality from "./no-buffer-deep-equality.mjs";
import cancellationCause from "./cancellation-cause.mjs";

import noEvidenceJsonPreadmission from "./rules/no-evidence-json-preadmission.mjs";
import noFixtureRootCleanup from "./rules/no-fixture-root-cleanup.mjs";
import noPositionalToolContract from "./rules/no-positional-tool-contract.mjs";
import noSharedModuleMock from "./rules/no-shared-module-mock.mjs";
import noLocaleCompare from "./rules/no-locale-compare.mjs";
import noRawCdpSession from "./rules/no-raw-cdp-session.mjs";
import noBabelVisitorKeys from "./rules/no-babel-visitor-keys.mjs";
import projectWaitDeadline from "./rules/project-wait-deadline.mjs";
import noRawFileHandleClose from "./rules/no-raw-file-handle-close.mjs";
import providerFailureClassifier from "./rules/provider-failure-classifier.mjs";
import typedResourceRefusal from "./rules/typed-resource-refusal.mjs";

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
    "no-raw-cdp-session": noRawCdpSession,
    "no-babel-visitor-keys": noBabelVisitorKeys,
    "project-wait-deadline": projectWaitDeadline,
    "no-raw-file-handle-close": noRawFileHandleClose,
    "provider-failure-classifier": providerFailureClassifier,
    "typed-resource-refusal": typedResourceRefusal,
  },
};
