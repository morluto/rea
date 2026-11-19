import { kunaProjectDeadline } from "../../../../src/kuna/KunaConfiguration.js";
import type { KunaProjectRequest } from "../../../../src/kuna/KunaProjectCache.js";

/**
 * A project request carrying the deadline its installation's configuration
 * selects now, as the session accepts one before it starts an export.
 */
export const withKunaProjectDeadline = (
  request: Omit<KunaProjectRequest, "deadline">,
): KunaProjectRequest => ({
  ...request,
  deadline: kunaProjectDeadline(request.installation.configuration),
});
