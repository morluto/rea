import type { UnityAddressables } from "./unityAddressables.js";

/** Fresh catalog facts for domain and application boundary tests: two bundles and two assets. */
export const createUnityAddressablesFixture = (): UnityAddressables => ({
  artifact: {
    path: "/artifacts/aa/catalog.bin",
    sha256: "c".repeat(64),
    bytes: 2048,
  },
  format: "binary",
  format_version: 2,
  locator_id: "AddressablesMainContentCatalog",
  build_result_hash: "f110008288902f8d7ed71b2fbab521df",
  dependency_basis: "location-records",
  providers: [
    {
      role: "resource",
      id: "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider",
      type_name:
        "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider",
      assembly: "Unity.ResourceManager",
    },
  ],
  keys: [
    { kind: "string", value: "core.bundle", type_name: null, locations: [0] },
    { kind: "string", value: "ui.bundle", type_name: null, locations: [1] },
    { kind: "string", value: "Prefabs/Crate", type_name: null, locations: [2] },
    { kind: "string", value: "hd", type_name: null, locations: [2, 3] },
    { kind: "int32", value: "-1025798400", type_name: null, locations: [0, 1] },
    {
      kind: "string",
      value: "Textures/Checker",
      type_name: null,
      locations: [3],
    },
  ],
  locations: [
    {
      primary_key: "core.bundle",
      internal_id:
        "{UnityEngine.AddressableAssets.Addressables.RuntimePath}/OSX/core.bundle",
      provider_id:
        "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider",
      resource_type:
        "UnityEngine.ResourceManagement.ResourceProviders.IAssetBundleResource",
      dependencies: [],
      dependency_key: null,
      dependency_hash: 0,
      data: {
        kind: "asset-bundle",
        hash: "b142f8090dfb864b2b99bae457383048",
        crc: 250064457,
        bundle_name: "core",
        bundle_size: 3508,
      },
      offset: 1508,
    },
    {
      primary_key: "ui.bundle",
      internal_id:
        "{UnityEngine.AddressableAssets.Addressables.RuntimePath}/OSX/ui.bundle",
      provider_id:
        "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider",
      resource_type:
        "UnityEngine.ResourceManagement.ResourceProviders.IAssetBundleResource",
      dependencies: [],
      dependency_key: null,
      dependency_hash: 0,
      data: {
        kind: "asset-bundle",
        hash: "43a9778bec900a22f1edaadfbfa7be07",
        crc: 438856362,
        bundle_name: "ui",
        bundle_size: 1224,
      },
      offset: 1943,
    },
    {
      primary_key: "Prefabs/Crate",
      internal_id: "Assets/Samples/Crate.prefab",
      provider_id:
        "UnityEngine.ResourceManagement.ResourceProviders.BundledAssetProvider",
      resource_type: "UnityEngine.GameObject",
      dependencies: [0, 1],
      dependency_key: null,
      dependency_hash: 17,
      data: null,
      offset: 2446,
    },
    {
      primary_key: "Textures/Checker",
      internal_id: "Assets/Samples/Checker.png",
      provider_id:
        "UnityEngine.ResourceManagement.ResourceProviders.BundledAssetProvider",
      resource_type: "UnityEngine.Texture2D",
      dependencies: [0],
      dependency_key: null,
      dependency_hash: 0,
      data: { kind: "other", type_name: "Game.LoadOptions" },
      offset: 2323,
    },
  ],
  hash_file: null,
  limitations: ["Fixture catalog."],
});
