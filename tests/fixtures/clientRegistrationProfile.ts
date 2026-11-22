import {
  supportedClientDefinition,
  type SupportedClientName,
} from "../../src/application/SupportedClients.js";

/** Select the native profile for a test with an authored configuration path. */
export const supportedClientRegistrationProfile = (name: SupportedClientName) =>
  supportedClientDefinition(name).registrationProfile;
