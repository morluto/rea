/** ASCII golden of a rea-agents-6.5.0 Evidence record, which predates format
 * revisions: readers refuse it with the recreate guidance instead of checking
 * its ID. This is a schema fixture, not a claim of a released-provider run.
 */
export const PRE_66_NULL_COVERAGE_EVIDENCE = {
  evidence_id:
    "ev_4efa1f7816d7017ce464ad524ccdb987d37b163b248d1ffbb14e8f0179a8f4d3",
  subject: null,
  provider: {
    id: "historical-fixture",
    name: "Historical fixture",
    version: "1",
  },
  analysis_profile: null,
  predicate_type: "rea.analysis",
  operation: "inspect",
  parameters: {},
  raw_result: null,
  normalized_result: {
    observed: true,
  },
  confidence: "observed",
  authority: "shipped-artifact",
  environment: null,
  limitations: [],
  relationship_coverage: null,
  locations: [],
  evidence_links: [],
} as const;
