import { z } from "zod";

/**
 * Parse `REA_GHIDRA_BRIDGE_TRANSPORT`, the local transport between REA and its
 * packaged Ghidra bridge. Unset selects the host default: the current-user
 * Unix socket on Linux and macOS, authenticated IPv4 loopback on Windows.
 * Selecting `authenticated-loopback-tcp` on a POSIX host serves hosts whose
 * sandbox refuses `socket(AF_UNIX)`; that transport carries no database
 * mutation authority.
 */
export const ghidraBridgeTransportSchema = z.enum(
  ["unix-socket", "authenticated-loopback-tcp"],
  { message: "must be unix-socket or authenticated-loopback-tcp" },
);

export type GhidraBridgeTransport = z.infer<typeof ghidraBridgeTransportSchema>;
