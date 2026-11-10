import { describe, expect, it } from "vitest";

import { providerCatalog } from "../../scripts/lib/catalog-builders.mjs";
import { ADB_PROVIDER_IDENTITY } from "../../src/adb/AdbProviderIdentity.js";
import {
  CAPABILITY_DECLARATIONS,
  type CapabilityDeclaration,
} from "../../src/composition/capabilityDeclarations.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import { TOOL_CONTRACT_GROUPS } from "../../src/contracts/toolFamilies.js";
import { QLOG_CAPTURE_PROVIDER_IDENTITY } from "../../src/browser/history/CaptureProviderIdentities.js";
import { HARMONY_APPLICATION_PROVIDER } from "../../src/domain/investigationProviders.js";
import {
  WEB_MODULE_TRACE_PROVIDER,
  WEB_SOURCE_LOCATION_PROVIDER,
} from "../../src/domain/webTraceProviders.js";

const fixtureIdentity = {
  id: "authored-fixture",
  name: "Authored provider identity",
  version: null,
};
const catalog = (
  declarations: Parameters<
    typeof providerCatalog
  >[0]["capabilityDeclarations"]["CAPABILITY_DECLARATIONS"],
) =>
  providerCatalog({
    toolContracts: { TOOL_CONTRACTS },
    toolFamilies: { TOOL_CONTRACT_GROUPS },
    capabilityDeclarations: { CAPABILITY_DECLARATIONS: declarations },
  });

describe("whole canonical contract groups", () => {
  it("includes a new canonical ADB operation without editing actual provider metadata", () => {
    const before = catalog(CAPABILITY_DECLARATIONS);
    const adb = before.find(({ id }) => id === ADB_PROVIDER_IDENTITY.id);
    expect(adb).toBeDefined();
    if (adb === undefined) throw new Error("Missing actual ADB provider");
    // Simulate the next real contract being added to its existing source group.
    // The production declaration is deliberately unchanged, so a copied list
    // would miss this valid operation even if every other provider used groups.
    const added = { name: "new_valid_adb_operation" };
    const after = providerCatalog({
      capabilityDeclarations: { CAPABILITY_DECLARATIONS },
      toolContracts: { TOOL_CONTRACTS: [...TOOL_CONTRACTS, added] },
      toolFamilies: {
        TOOL_CONTRACT_GROUPS: {
          ...TOOL_CONTRACT_GROUPS,
          ADB_TOOL_CONTRACTS: [
            ...TOOL_CONTRACT_GROUPS.ADB_TOOL_CONTRACTS,
            added,
          ],
        },
      },
    });
    expect(after.find(({ id }) => id === adb.id)).toEqual({
      ...adb,
      capabilities: [...adb.capabilities, added.name].sort(),
    });
    expect(after.filter(({ id }) => id !== adb.id)).toEqual(
      before.filter(({ id }) => id !== adb.id),
    );
  });

  it("includes every canonical operation selected by real whole-group bindings", () => {
    const providers = new Map(
      catalog(CAPABILITY_DECLARATIONS).map((provider) => [
        provider.id,
        provider,
      ]),
    );
    const declarations: readonly CapabilityDeclaration[] = Object.values(
      CAPABILITY_DECLARATIONS,
    );
    let examined = 0;
    for (const declaration of declarations)
      for (const { identity, operations } of declaration.providers) {
        if (!("group" in operations)) continue;
        const expected = TOOL_CONTRACT_GROUPS[operations.group].map(
          ({ name }) => name,
        );
        expect(providers.get(identity.id)?.capabilities).toEqual(
          expect.arrayContaining(expected),
        );
        examined += 1;
      }
    expect(examined).toBeGreaterThan(0);
  });
});

describe("static capability provider declarations", () => {
  it("reports the actual trace, Harmony and qlog provenance without changing their public operations", () => {
    const providers = catalog(CAPABILITY_DECLARATIONS);
    for (const [identity, operation] of [
      [WEB_SOURCE_LOCATION_PROVIDER, "trace_web_source_location"],
      [WEB_MODULE_TRACE_PROVIDER, "trace_web_module_imports"],
      [HARMONY_APPLICATION_PROVIDER, "project_harmony_application_graph"],
      [QLOG_CAPTURE_PROVIDER_IDENTITY, "inspect_web_network_capture"],
    ] as const)
      expect(providers.find(({ id }) => id === identity.id)).toEqual({
        ...identity,
        capabilities: [operation],
      });
    expect(
      providers.find(({ id }) => id === "rea-web-script-export")?.capabilities,
    ).toEqual(["export_web_scripts"]);
    expect(
      providers.find(({ id }) => id === "rea-javascript-application-workflows")
        ?.capabilities,
    ).not.toContain("project_harmony_application_graph");
  });

  it("merges shared provider identities and operation unions independently of declaration order", () => {
    const first = {
      providers: [
        {
          identity: fixtureIdentity,
          operations: ["inspect_wasm_artifact", "inspect_apk_signature"],
        },
      ],
    };
    const second = {
      providers: [
        {
          identity: { ...fixtureIdentity },
          operations: ["inspect_apk_signature", "inspect_evm_interface"],
        },
      ],
    };
    const expected = [
      {
        ...fixtureIdentity,
        capabilities: [
          "inspect_apk_signature",
          "inspect_evm_interface",
          "inspect_wasm_artifact",
        ],
      },
    ];
    expect(catalog({ first, second, files: { providers: [] } })).toEqual(
      expected,
    );
    expect(catalog({ second, first })).toEqual(expected);
  });

  it.each([
    { name: "A different provider name" },
    { version: "a different release" },
  ])(
    "refuses conflicting identities sharing the same provider ID: %j",
    (change) => {
      expect(() =>
        catalog({
          first: {
            providers: [{ identity: fixtureIdentity, operations: [] }],
          },
          second: {
            providers: [
              { identity: { ...fixtureIdentity, ...change }, operations: [] },
            ],
          },
        }),
      ).toThrow("Provider authored-fixture has conflicting source identities");
    },
  );

  it("refuses an unknown analyst operation instead of silently dropping the provider binding", () => {
    expect(() =>
      catalog({
        fixture: {
          providers: [
            {
              identity: fixtureIdentity,
              operations: ["not_an_advertised_operation"],
            },
          ],
        },
      }),
    ).toThrow(
      "Provider authored-fixture declares an unknown analyst operation: not_an_advertised_operation",
    );
  });

  it("refuses an unknown canonical contract group", () => {
    expect(() =>
      catalog({
        fixture: {
          providers: [
            {
              identity: fixtureIdentity,
              operations: { group: "not_a_contract_group" },
            },
          ],
        },
      }),
    ).toThrow(
      "Provider authored-fixture declares an unknown contract group: not_a_contract_group",
    );
  });
});
