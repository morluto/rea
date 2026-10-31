import { expect, it } from "vitest";
import { createUnityAddressablesFixture } from "../unity/unityAddressables.fixture.js";
import { unityAddressablesSchema } from "../unity/unityAddressables.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import {
  projectUnityAddressablesView,
  unityAddressablesViewRequestSchema,
} from "./unityAddressablesView.js";

const report = createUnityAddressablesFixture();
const parent = (normalizedResult: unknown = report, sealedResult = false) => ({
  evidenceId: `ev_${"d".repeat(64)}`,
  operation: "inspect_unity_addressables",
  normalizedResult,
  sealedResult,
  limitations: [],
});
const page = (view: Record<string, unknown>) => {
  const request = unityAddressablesViewRequestSchema.parse({
    kind: "unity-addressables",
    ...view,
  });
  const result = projectUnityAddressablesView(parent(), request);
  if (!result.ok) throw result.error;
  return result.value as unknown as {
    items: Record<string, unknown>[];
    counts: Record<string, number>;
    coverage: unknown;
  };
};

it("summarizes identity and derived counts without rows", () => {
  const result = projectUnityAddressablesView(parent(), { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_unity_addressables",
    summary: {
      format: "binary",
      format_version: 2,
      locator_id: "AddressablesMainContentCatalog",
      counts: {
        providers: 1,
        keys: 6,
        locations: 4,
        bundles: 2,
        dependency_edges: 3,
      },
    },
  });
  expect(JSON.stringify(result.value)).not.toContain("Crate.prefab");
});

it("pages locations selected by key index and keeps source indices", () => {
  const view = page({
    collection: "locations",
    key_indices: [3],
    fields: ["internal_id"],
  });
  expect(view.items).toEqual([
    { index: 2, internal_id: "Assets/Samples/Crate.prefab" },
    { index: 3, internal_id: "Assets/Samples/Checker.png" },
  ]);
});

it.each([
  [{ data_kinds: ["asset-bundle"] }, [0, 1]],
  [{ data_kinds: ["none"] }, [2]],
  [{ data_kinds: ["other"] }, [3]],
  [{ primary_keys: ["Prefabs/Crate"] }, [2]],
  [
    {
      provider_ids: [
        "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider",
      ],
    },
    [0, 1],
  ],
  [{ internal_ids: ["Assets/Samples/Checker.png"] }, [3]],
  [{ key_indices: [3], data_kinds: ["other"] }, [3]],
  [{ indices: [3, 0, 3], data_kinds: ["asset-bundle"] }, [0]],
  [{ key_indices: [] }, []],
])("intersects location filters %j", (filters, indices) => {
  const view = page({ collection: "locations", fields: [], ...filters });
  expect(view.items.map((item) => item.index)).toEqual(indices);
});

it("treats repeated key indices like one selection of that key", () => {
  const once = page({ collection: "locations", fields: [], key_indices: [3] });
  const repeated = page({
    collection: "locations",
    fields: [],
    key_indices: Array<number>(1024).fill(3),
  });
  expect(repeated.items).toEqual(once.items);
});

it("refuses a key index past the key table instead of returning no locations", () => {
  const request = unityAddressablesViewRequestSchema.parse({
    kind: "unity-addressables",
    collection: "locations",
    key_indices: [0, report.keys.length],
  });
  const result = projectUnityAddressablesView(parent(), request);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(JSON.stringify(result.error)).toContain("key_indices");
});

it("filters keys by value and kind and pages with offset and limit", () => {
  expect(
    page({ collection: "keys", kinds: ["int32"] }).items.map(
      (item) => item.value,
    ),
  ).toEqual(["-1025798400"]);
  expect(page({ collection: "keys", values: ["hd", "missing"] }).items).toEqual(
    [
      {
        index: 3,
        kind: "string",
        value: "hd",
        type_name: null,
        locations: [2, 3],
      },
    ],
  );
  const second = page({ collection: "keys", offset: 1, limit: 2, fields: [] });
  expect(second.items).toEqual([{ index: 1 }, { index: 2 }]);
  expect(second.coverage).toMatchObject({
    exhausted: false,
    next_offset: 3,
    total: 6,
  });
});

it("pages providers and reuses a sealed snapshot", () => {
  const frozen = freezeJsonSnapshot(unityAddressablesSchema.parse(report));
  const providersPage = {
    kind: "unity-addressables",
    collection: "providers",
    offset: 0,
    limit: 8,
  } as const;
  const first = projectUnityAddressablesView(
    parent(frozen, true),
    providersPage,
  );
  const second = projectUnityAddressablesView(
    parent(frozen, true),
    providersPage,
  );
  if (!first.ok || !second.ok) throw new Error("projection failed");
  expect(second.value).toEqual(first.value);
});

it("refuses foreign view kinds, mismatched subjects and invalid parents", () => {
  expect(
    projectUnityAddressablesView(parent(), {
      kind: "il2cpp-metadata",
      collection: "types",
      offset: 0,
      limit: 1,
    } as never).ok,
  ).toBe(false);
  expect(
    projectUnityAddressablesView(
      {
        ...parent(),
        subject: {
          format: "file",
          local_path: "/artifacts/other.bin",
          digest: { sha256: report.artifact.sha256 },
        },
      } as never,
      { kind: "summary" },
    ).ok,
  ).toBe(false);
  expect(
    projectUnityAddressablesView(
      parent({
        ...report,
        keys: [{ ...report.keys[0]!, locations: [99] }],
      }),
      { kind: "summary" },
    ).ok,
  ).toBe(false);
});

it("rejects reports whose JSON dependencies disagree with the dependency key or whose keys lose text", () => {
  const json = {
    ...report,
    format: "json" as const,
    format_version: null,
    dependency_basis: "key-locations" as const,
    locations: report.locations.map((row) => ({
      ...row,
      offset: null,
      dependency_key: row.dependencies.length > 0 ? 4 : null,
    })),
  };
  // Location 2 depends on key 4 ([0, 1]); location 3 claims [0] from the same key.
  expect(unityAddressablesSchema.safeParse(json).success).toBe(false);
  json.locations[3]!.dependencies = [0, 1];
  expect(unityAddressablesSchema.safeParse(json).success).toBe(true);
  expect(
    unityAddressablesSchema.safeParse({
      ...report,
      keys: [{ ...report.keys[4]!, value: null, locations: [] }],
      locations: [],
    }).success,
  ).toBe(false);
  expect(
    unityAddressablesSchema.safeParse({
      ...report,
      keys: [{ ...report.keys[0]!, value: null, locations: [] }],
      locations: [],
    }).success,
  ).toBe(true);
});
