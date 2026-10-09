import { lookup as lookupDns } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";

export interface SourceMapResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type SourceMapResolver = (
  hostname: string,
) => Promise<readonly SourceMapResolvedAddress[]>;

export interface SourceMapSafeFetchOptions {
  readonly resolve?: SourceMapResolver;
  readonly explicitAllowedOrigins: readonly string[];
}

export class SourceMapAddressPolicyError extends Error {
  constructor(
    message = "Source-map hostname resolved to a private or special-use address.",
  ) {
    super(message);
    this.name = "SourceMapAddressPolicyError";
  }
}

const systemResolver: SourceMapResolver = async (hostname) =>
  (await lookupDns(hostname, { all: true, verbatim: true })).map(
    ({ address, family }) => ({ address, family: family === 4 ? 4 : 6 }),
  );

const normalizedAddress = (value: string): string =>
  value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

const classifyAddress = (value: string): string => {
  try {
    return ipaddr.process(normalizedAddress(value)).range();
  } catch {
    return "invalid";
  }
};

const isPublicUnicast = (address: SourceMapResolvedAddress): boolean =>
  classifyAddress(address.address) === "unicast";

const permittedSpecialAddress = (
  hostname: string,
  origin: string,
  addresses: readonly SourceMapResolvedAddress[],
  explicitAllowedOrigins: readonly string[],
): boolean => {
  if (hostname.toLowerCase() === "localhost")
    return addresses.every(
      ({ address }) => classifyAddress(address) === "loopback",
    );
  return (
    explicitAllowedOrigins.includes(origin) &&
    addresses.every(({ address }) => classifyAddress(address) !== "invalid")
  );
};

/** Fetch one source-map URL with DNS pinned to the checked socket address. */
export const resolveSourceMapAddresses = async (
  url: string,
  options: SourceMapSafeFetchOptions,
): Promise<readonly SourceMapResolvedAddress[]> => {
  const parsed = new URL(url);
  const hostname = normalizedAddress(parsed.hostname);
  const literal = ipaddr.isValid(hostname);
  const addresses = literal
    ? [
        {
          address: hostname,
          family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6,
        } as const,
      ]
    : await (options.resolve ?? systemResolver)(hostname);
  if (addresses.length === 0)
    throw new SourceMapAddressPolicyError(
      "Source-map hostname did not resolve to an address.",
    );

  const normalizedHostname = hostname.toLowerCase();
  const localHostname =
    normalizedHostname === "localhost" ||
    normalizedHostname === "localhost." ||
    normalizedHostname.endsWith(".localhost");
  if (
    !literal &&
    !localHostname &&
    addresses.some((address) => !isPublicUnicast(address)) &&
    !permittedSpecialAddress(
      hostname,
      parsed.origin,
      addresses,
      options.explicitAllowedOrigins,
    )
  )
    throw new SourceMapAddressPolicyError(
      `Source-map hostname resolved to a private or special-use address; explicitly approve the exact origin (${parsed.origin}) to permit it.`,
    );
  if (
    localHostname &&
    !addresses.every(({ address }) => classifyAddress(address) === "loopback")
  )
    throw new SourceMapAddressPolicyError(
      "The localhost source-map name resolved outside loopback.",
    );
  return addresses;
};

/** Fetch one source-map URL with DNS pinned to the checked socket address. */
export const fetchSourceMapSafely = async (
  url: string,
  init: RequestInit,
  options: SourceMapSafeFetchOptions,
): Promise<{
  readonly response: Response;
  readonly close: () => Promise<void>;
}> => {
  const addresses = await resolveSourceMapAddresses(url, options);

  const pinned = addresses[0];
  if (pinned === undefined) throw new SourceMapAddressPolicyError();
  const dispatcher = new Agent({
    connect: {
      lookup: (_name, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
    },
  });
  try {
    const response = await undiciFetch(url, {
      ...init,
      dispatcher,
      redirect: "manual",
    });
    return { response, close: () => dispatcher.close() };
  } catch (cause: unknown) {
    await dispatcher.close();
    throw cause;
  }
};
