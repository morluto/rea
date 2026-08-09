import type { ClientFeatureAvailability } from "../contracts/toolOutputSchemaPrimitives.js";

type ClientFeatureName = keyof ClientFeatureAvailability;

/** Empty MCP client feature declaration used when the caller supplies none. */
export const NO_CLIENT_FEATURES: ClientFeatureAvailability = {
  elicitation_form: false,
  elicitation_url: false,
  roots: false,
  sampling: false,
};

const CLIENT_FEATURE_REQUIREMENTS: Readonly<
  Record<
    string,
    {
      readonly required: readonly ClientFeatureName[];
      readonly optional: readonly ClientFeatureName[];
    }
  >
> = {
  capture_process_scenario: {
    required: [],
    optional: ["elicitation_form"],
  },
};

/** Project a tool's client requirements against the negotiated feature set. */
export const clientRequirementsFor = (
  name: string,
  clientFeatures: ClientFeatureAvailability,
) => {
  const requirements = CLIENT_FEATURE_REQUIREMENTS[name] ?? {
    required: [],
    optional: [],
  };
  return {
    required: [...requirements.required],
    optional: [...requirements.optional],
    missing_required: requirements.required.filter(
      (feature) => !clientFeatures[feature],
    ),
    missing_optional: requirements.optional.filter(
      (feature) => !clientFeatures[feature],
    ),
  };
};
