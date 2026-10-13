import { expect, it } from "vitest";
import { parseCapinfosOutput, parseTsharkJsonOutput } from "./PcapOutput.js";

const capture = (layers: ReadonlyArray<Record<string, string[]>>) =>
  JSON.stringify(
    layers.map((fields, index) => ({
      _source: {
        layers: {
          "frame.number": [String(index + 1)],
          "frame.protocols": ["ip:udp:dns"],
          ...fields,
        },
      },
    })),
  );

it("binds interleaved DNS answers to the question in their response packet", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      { "dns.qry.name": ["alpha.example"], "dns.flags.response": ["False"] },
      { "dns.qry.name": ["beta.example"], "dns.flags.response": ["False"] },
      {
        "dns.qry.name": ["alpha.example"],
        "dns.flags.response": ["True"],
        "dns.a": ["192.0.2.10"],
      },
      {
        "dns.qry.name": ["beta.example"],
        "dns.flags.response": ["True"],
        "dns.a": ["192.0.2.20"],
      },
    ]),
  );
  expect(result.dnsQueries).toEqual([
    {
      query: "alpha.example",
      response_addresses: ["192.0.2.10"],
      response_address_count: 1,
    },
    {
      query: "beta.example",
      response_addresses: ["192.0.2.20"],
      response_address_count: 1,
    },
  ]);
  expect(result.partial).toBe(false);
});

it("retains unassignable DNS addresses without inventing a query relationship", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "dns.qry.name": ["alpha.example", "beta.example"],
        "dns.flags.response": ["True"],
        "dns.a": ["192.0.2.9"],
      },
      { "dns.flags.response": ["True"], "dns.aaaa": ["2001:db8::9"] },
    ]),
  );
  expect(
    result.dnsQueries.every((query) => query.response_addresses.length === 0),
  ).toBe(true);
  expect(result.unattributedDnsAddresses).toEqual(["192.0.2.9", "2001:db8::9"]);
  expect(result.unattributedDnsPackets).toBe(2);
  expect(result.partial).toBe(true);
});

it("counts IPv6 endpoints once per packet and preserves every examined fact", async () => {
  const packets = Array.from({ length: 51 }, (_, index) => ({
    "ipv6.src": ["2001:db8::1"],
    "ipv6.dst": ["2001:db8::1"],
    "tls.handshake.extensions_server_name": [`host${String(index)}.example`],
    "frame.protocols": [`ipv6:protocol${String(index)}`],
  }));
  const result = await parseTsharkJsonOutput(capture(packets));
  expect(result.endpoints).toEqual([
    { address: "2001:db8::1", port: null, packet_count: 51 },
  ]);
  expect(result.tlsSniCount).toBe(51);
  expect(result.tlsSniValues).toHaveLength(51);
  expect(result.protocolCount).toBe(51);
  expect(result.protocolDistribution).toHaveLength(51);
  expect(result.partial).toBe(false);
});

it("orders equal-count endpoints and protocols by code point, not host locale", async () => {
  // Locale collation puts "fe80::1" first and, under da-DK, "aarp" after "zz".
  const result = await parseTsharkJsonOutput(
    capture([
      { "ipv6.src": ["fe80::1"], "frame.protocols": ["eth:llc:zz"] },
      { "ipv6.src": ["fe80:1::1"], "frame.protocols": ["eth:llc:aarp"] },
    ]),
  );
  expect(result.endpoints.map(({ address }) => address)).toEqual([
    "fe80:1::1",
    "fe80::1",
  ]);
  expect(result.protocolDistribution.map(({ protocol }) => protocol)).toEqual([
    "eth:llc:aarp",
    "eth:llc:zz",
  ]);
});

it("preserves all DNS addresses and their exact examined count", async () => {
  const result = await parseTsharkJsonOutput(
    capture(
      Array.from({ length: 101 }, (_, index) => ({
        "dns.qry.name": ["rotating.example"],
        "dns.flags.response": ["True"],
        "dns.a": [`192.0.2.${String(index)}`],
      })),
    ),
  );
  expect(result.dnsQueries[0]?.response_addresses).toHaveLength(101);
  expect(result.dnsQueries[0]?.response_address_count).toBe(101);
  expect(result.partial).toBe(false);
});

it("accepts exact machine packet counts and rejects scaled human counts", () => {
  const prefix =
    "File type: pcap\nFile encapsulation: Ethernet\nNumber of packets: ";
  expect(parseCapinfosOutput(`${prefix}20010`).packetCount).toBe(20010);
  expect(() => parseCapinfosOutput(`${prefix}20 k`)).toThrow(
    /machine-readable/u,
  );
});

it("excludes transport credentials without normalizing observed URL bytes", async () => {
  const result = await parseTsharkJsonOutput(
    capture([
      {
        "http.request.full_uri": [
          "http://user:password@Example.com/a/../b?token=local-evidence#keep",
        ],
      },
      {
        "http.request.full_uri": [
          "http://other:secret@Example.com/a/../b?token=local-evidence#keep",
        ],
      },
    ]),
  );
  expect(result.httpRequestUris).toEqual([
    "http://Example.com/a/../b?token=local-evidence#keep",
  ]);
  expect(result.httpRequestUriCount).toBe(2);
  expect(result.httpUriRedactionCount).toBe(2);
  expect(result.partial).toBe(true);
});

it("refuses dense JSON before its expanded graph exceeds the decoding budget", async () => {
  await expect(
    parseTsharkJsonOutput(`[${"{},".repeat(600_000)}{}]`),
  ).rejects.toMatchObject({
    _tag: "AnalysisResourceConstraintError",
  });
});

it("permits cancellation while validating and aggregating producer output", async () => {
  const controller = new AbortController();
  const result = parseTsharkJsonOutput(
    capture([{ "ip.src": ["192.0.2.1"] }]),
    controller.signal,
  );
  controller.abort(new Error("stopped"));
  await expect(result).rejects.toThrow("stopped");
});
