import { describe, expect, it } from "vitest";

import { providerCatalog } from "../../scripts/lib/catalog-builders.mjs";
import { CAPABILITY_DECLARATIONS } from "../../src/composition/capabilityDeclarations.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
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
    capabilityDeclarations: { CAPABILITY_DECLARATIONS: declarations },
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
});
