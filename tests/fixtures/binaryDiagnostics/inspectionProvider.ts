import type { ArtifactInspectionPort } from "../../../src/application/ArtifactInspectionExecution.js";
import type { ProviderIdentity } from "../../../src/ports/AnalysisProvider.js";

/** Both entry points use the same inspection callback for these stateless test providers. */
export const inspectionTestProvider = <Input, Report>(
  identity: ProviderIdentity,
  inspect: ArtifactInspectionPort<Input, Report>["inspect"],
) => ({ identity, inspect, inspectAndClose: inspect });
