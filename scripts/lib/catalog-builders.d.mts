interface ProviderBinding {
  readonly identity: {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
  };
  readonly operations: readonly string[];
}

interface ProviderCatalogSources {
  readonly toolContracts: {
    readonly TOOL_CONTRACTS: readonly { readonly name: string }[];
  };
  readonly capabilityDeclarations: {
    readonly CAPABILITY_DECLARATIONS: Readonly<
      Record<string, { readonly providers: readonly ProviderBinding[] }>
    >;
  };
}

export function providerCatalog(sources: ProviderCatalogSources): {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly capabilities: readonly string[];
}[];

export function toolFamilyCatalog(sources: {
  readonly toolFamilies: {
    readonly TOOL_FAMILY_DEFINITIONS: readonly {
      readonly id: string;
      readonly surface: string;
      readonly contracts: readonly { readonly name: string }[];
    }[];
  };
  readonly toolContracts: {
    readonly TOOL_CONTRACTS: readonly unknown[];
  };
  readonly catalogIdentity: {
    readonly FULL_CATALOG_IDENTITY: {
      readonly counts: { readonly mcp_tools: number };
    };
  };
}): {
  readonly total: number;
  readonly families: readonly {
    readonly id: string;
    readonly surface: string;
    readonly count: number;
    readonly tools: readonly string[];
  }[];
};
