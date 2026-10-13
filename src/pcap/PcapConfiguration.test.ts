import { describe, expect, it } from "vitest";

import {
  CAPINFOS_COMMAND_ENV,
  TSHARK_COMMAND_ENV,
  resolvePcapTools,
} from "./PcapConfiguration.js";
import { parseCapinfosOutput, parseTsharkJsonOutput } from "./PcapOutput.js";

describe("resolvePcapTools", () => {
  it("prefers absolute environment paths for both tools", () => {
    expect(
      resolvePcapTools({
        [TSHARK_COMMAND_ENV]: "/usr/bin/tshark",
        [CAPINFOS_COMMAND_ENV]: "/usr/bin/capinfos",
      }),
    ).toEqual({
      tshark: { command: "/usr/bin/tshark", source: "environment" },
      capinfos: { command: "/usr/bin/capinfos", source: "environment" },
    });
  });

  it("falls back to PATH resolution without the environment keys", () => {
    expect(resolvePcapTools({})).toEqual({
      tshark: { command: "tshark", source: "path" },
      capinfos: { command: "capinfos", source: "path" },
    });
  });

  it("rejects a relative tshark path explicitly", () => {
    expect(() =>
      resolvePcapTools({ [TSHARK_COMMAND_ENV]: "bin/tshark" }),
    ).toThrow(/must be an absolute path/u);
  });

  it("rejects a relative capinfos path explicitly", () => {
    expect(() =>
      resolvePcapTools({ [CAPINFOS_COMMAND_ENV]: "capinfos" }),
    ).toThrow(/must be an absolute path/u);
  });
});

const REAL_CAPINFOS = [
  "File name:           /work/rich-capture.pcap",
  "File type:           Wireshark/tcpdump/... - pcap",
  "File encapsulation:  Linux cooked-mode capture v2",
  "Packet size limit:   file hdr: 262144 bytes",
  "Number of packets:   50",
  "File size:           23279 bytes",
  "Capture duration:    0.373473 seconds",
  "Earliest packet time: 2026-10-11 14:13:40.608505",
  "Latest packet time:   2026-10-11 14:13:40.981978",
  "SHA256:              c94f94742b3288b9a979711509ed5eab3028576301f8938319de3c22a6f5c40b",
].join("\n");

describe("parseCapinfosOutput", () => {
  it("projects metadata from real capinfos output", () => {
    expect(parseCapinfosOutput(REAL_CAPINFOS)).toEqual({
      fileType: "Wireshark/tcpdump/... - pcap",
      encapsulation: "Linux cooked-mode capture v2",
      packetCount: 50,
      captureStart: "2026-10-11 14:13:40.608505",
      captureEnd: "2026-10-11 14:13:40.981978",
      captureDurationSeconds: 0.373473,
      snapshotLength: 262144,
      sha256:
        "c94f94742b3288b9a979711509ed5eab3028576301f8938319de3c22a6f5c40b",
    });
  });

  it("rejects empty metadata rather than reporting complete unknown facts", () => {
    expect(() => parseCapinfosOutput("")).toThrow(/machine-readable/u);
  });
});

const REAL_TSHARK_JSON = JSON.stringify([
  {
    _source: {
      layers: {
        "frame.number": ["1"],
        "frame.protocols": ["sll:ethertype:ip:udp:dns"],
        "ip.src": ["192.168.1.1"],
        "ip.dst": ["8.8.8.8"],
        "dns.qry.name": ["example.com"],
        "dns.flags.response": ["1"],
        "dns.a": ["93.184.216.34"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["2"],
        "frame.protocols": ["sll:ethertype:ip:tcp:tls"],
        "ip.src": ["192.168.1.1"],
        "ip.dst": ["93.184.216.34"],
        "tls.handshake.extensions_server_name": ["example.com"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["3"],
        "frame.protocols": ["sll:ethertype:ip:tcp:http"],
        "ip.src": ["192.168.1.1"],
        "ip.dst": ["93.184.216.34"],
        "http.request.full_uri": ["http://example.com/page"],
      },
    },
  },
]);

describe("parseTsharkJsonOutput", () => {
  it("projects endpoints, DNS, TLS SNI, protocols, and HTTP URIs", async () => {
    const result = await parseTsharkJsonOutput(REAL_TSHARK_JSON);
    expect(result.endpoints).toEqual(
      expect.arrayContaining([
        { address: "192.168.1.1", port: null, packet_count: 3 },
        { address: "8.8.8.8", port: null, packet_count: 1 },
        { address: "93.184.216.34", port: null, packet_count: 2 },
      ]),
    );
    expect(result.dnsQueries).toEqual([
      {
        query: "example.com",
        response_addresses: ["93.184.216.34"],
        response_address_count: 1,
      },
    ]);
    expect(result.tlsSniValues).toEqual(["example.com"]);
    expect(result.httpRequestUris).toEqual(["http://example.com/page"]);
    expect(result.protocolDistribution).toEqual(
      expect.arrayContaining([
        { protocol: "sll:ethertype:ip:udp:dns", packet_count: 1 },
        { protocol: "sll:ethertype:ip:tcp:tls", packet_count: 1 },
        { protocol: "sll:ethertype:ip:tcp:http", packet_count: 1 },
      ]),
    );
  });

  it("retains every endpoint within the aggregate resource budget", async () => {
    const packets = Array.from({ length: 10 }, (_, index) => ({
      _source: {
        layers: {
          "frame.number": [String(index + 1)],
          "frame.protocols": ["ip:tcp"],
          "ip.src": [`10.0.0.${index}`],
          "ip.dst": ["10.0.1.1"],
        },
      },
    }));
    const result = await parseTsharkJsonOutput(JSON.stringify(packets));
    expect(result.endpoints).toHaveLength(11);
    expect(result.endpointCount).toBe(11); // 10 src + 1 dst
  });

  it.each([
    "",
    "not json",
    "{}",
    "null",
    "[null]",
    '[{"_source":{"layers":{"ip.src":[3]}}}]',
  ])("rejects malformed producer output %s", async (text) => {
    await expect(parseTsharkJsonOutput(text)).rejects.toMatchObject({
      _tag: "AnalysisProtocolError",
    });
  });
});
