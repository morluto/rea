/** Generated from the two-request apiSurfaceHar fixture through the HAR decoder and view service. */
export const API_SURFACE_EXAMPLE = {
  input: {
    source: {
      kind: "retained-evidence",
      evidence_id:
        "ev_fe685b2acd1668cdea7b576a829ff13b9b62c363b7e3477434b8671a6a80a22c",
    },
    view: {
      kind: "api-surface",
      offset: 0,
      limit: 50,
    },
  },
  output: {
    parent_evidence_id:
      "ev_fe685b2acd1668cdea7b576a829ff13b9b62c363b7e3477434b8671a6a80a22c",
    parent_operation: "inspect_web_network_capture",
    parent_digest:
      "fe685b2acd1668cdea7b576a829ff13b9b62c363b7e3477434b8671a6a80a22c",
    view_digest:
      "3e520ba71863fba686ca10a78389e16de0bb9bd59eb6b4eb08f9ba9a91e9c349",
    artifact: {
      path: "/fixtures/api-surface.har",
      sha256:
        "bf58e2c06e55bfe7e0628157c4ad027ce0aeb81a10e8edef8a7f95b8e5f14225",
    },
    coverage: {
      status: "page",
      examined: 1,
      total: 1,
      next_offset: null,
      exhausted: true,
    },
    limitations: [
      "Grouping does not establish handler identity, URL-space schemas or causality.",
      "HAR text without an encoding declaration is producer-decoded Unicode. Unsupported declared body encodings remain opaque; original body bytes remain unknown unless content explicitly uses valid base64. Declared sizes are preserved independently of retained bytes. mitmproxy 12.2.3/12.3.1 SaveHar may report null optional postData.text; that null is retained and omitted only from the upstream validation copy.",
    ],
    unknowns: [],
    records: {
      examined: 2,
      total: 2,
      excluded: 0,
    },
    templated_groups: 1,
    groups: [
      {
        method: "GET",
        origin: "https://api.example.test",
        path_template: "/users/{numeric}",
        templated_segments: [
          {
            segment_index: 1,
            rule: "numeric",
            basis: "inferred",
            observed_values: ["8812", "9031"],
          },
        ],
        record_ordinals: [0, 1],
        statuses: [200, 404],
        content_types: ["application/json", "text/plain"],
        flags: ["mixed-statuses", "mixed-content-types"],
      },
    ],
    excluded_records: [],
    kind: "api-surface",
    view: {
      kind: "api-surface",
      offset: 0,
      limit: 50,
    },
  },
} as const;
