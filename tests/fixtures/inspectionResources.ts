import { ArtifactResourceScope } from "../../src/resources/ArtifactResourceScope.js";

/** Test-scoped real inspection leases; every retained owner is closed by the fixture. */
export const createInspectionResources = () => {
  const scope = new ArtifactResourceScope();
  return { owner: scope.forCloseOwners(), close: () => scope.close() };
};
