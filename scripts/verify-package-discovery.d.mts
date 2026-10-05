/** Derive agent and Hopper setup support from the corresponding doctor checks. */
export function packageSetupSupport(
  checks:
    | readonly { readonly name: string; readonly ok: boolean }[]
    | undefined,
  platform: NodeJS.Platform,
): {
  supportedSetupHost: boolean;
  hopperSetupSupported: boolean;
};

/** Validate --help, --llms, and doctor output and determine host setup support. */
export function verifyPackageDiscovery(input: {
  readonly cli: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<{
  supportedSetupHost: boolean;
  hopperSetupSupported: boolean;
}>;
