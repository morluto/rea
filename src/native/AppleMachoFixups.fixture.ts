import { parsePointerFixupsSteps } from "./AppleMachoFixups.js";

export const parsePointerFixups = (
  ...args: Parameters<typeof parsePointerFixupsSteps>
) => {
  const steps = parsePointerFixupsSteps(...args);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};
