import { decodeAppleDispatchMetadataSteps } from "./AppleDispatchMetadata.js";

export const decodeAppleDispatchMetadata = (
  ...args: Parameters<typeof decodeAppleDispatchMetadataSteps>
) => {
  const steps = decodeAppleDispatchMetadataSteps(...args);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};
