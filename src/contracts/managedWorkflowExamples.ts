import { createEvidence } from "../domain/evidence.js";
import type { ManagedMemberInspection } from "../domain/managedArtifact.js";

const MANAGED_STATIC_EXAMPLE_PROVIDER = {
  id: "rea-dotnet-static",
  name: "REA managed static analysis provider",
  version: "1",
} as const;

const emptyManagedMembers = (
  sha256: string,
  mvid: string,
): ManagedMemberInspection => ({
  schema_version: 1,
  artifact: {
    path: `/examples/${sha256.slice(0, 8)}.dll`,
    sha256,
    byte_length: 4096,
    format: "pe",
  },
  module: {
    name: "Example.dll",
    generation: 0,
    mvid,
    enc_id: null,
    enc_base_id: null,
    token: "0x00000001",
    row_offset: 0,
  },
  metadata: {
    status: "complete",
    version: "v4.0.30319",
    table_row_counts: {},
  },
  identity_scope: {
    token_identity: "build-local",
    requires_artifact_sha256: sha256,
    requires_mvid: mvid,
  },
  types: emptyPage(100),
  fields: emptyPage(100),
  methods: emptyPage(100),
  member_refs: emptyPage(100),
  call_edges: emptyPage(250),
  field_accesses: emptyPage(250),
  coverage: { state: "complete", issues: [] },
  limitations: [],
});

const emptyPage = <Item>(limit: number) => ({
  items: [] as Item[],
  offset: 0,
  limit,
  total: 0,
  returned: 0,
  dropped: 0,
  complete: true,
});

const evidence = (result: ManagedMemberInspection) =>
  createEvidence(undefined, MANAGED_STATIC_EXAMPLE_PROVIDER, {
    operation: "inspect_managed_members",
    parameters: {},
    result,
    rawResult: null,
    limitations: result.limitations,
  });

/** Minimal valid managed member comparison request for public contracts. */
export const MANAGED_MEMBER_COMPARISON_EXAMPLE = {
  left: evidence(
    emptyManagedMembers("0".repeat(64), "00112233-4455-6677-8899-aabbccddeeff"),
  ),
  right: evidence(
    emptyManagedMembers("1".repeat(64), "ffeeddcc-bbaa-9988-7766-554433221100"),
  ),
  limits: {
    max_method_matches: 100,
    max_field_matches: 50,
    max_candidates: 25,
  },
};
