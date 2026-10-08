import { expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  isOwnedClientRegistrationCommand,
  npxRegistrationCommand,
} from "./ClientRegistrationIdentity.js";
import { setupRegistrationCommand } from "./SetupHost.js";

it("uses a Windows executable for npm-run setup and preserves POSIX launchers", () => {
  expect(setupRegistrationCommand("win32", true)).toEqual([
    "cmd.exe",
    "/d",
    "/c",
    "npx",
    "-y",
    PRODUCT_IDENTITY.registrationPackageSpecifier,
    "mcp",
  ]);
  for (const platform of ["linux", "darwin"] as const)
    expect(setupRegistrationCommand(platform, true)).toEqual([
      "npx",
      "-y",
      PRODUCT_IDENTITY.registrationPackageSpecifier,
      "mcp",
    ]);
});

it.each(
  [
    npxRegistrationCommand("win32"),
    ["cmd", "/c", "npx", "-y", "rea-agents@5.0.0", "mcp"],
    ["npx", "-y", "rea-agents@5.0.0", "mcp"],
  ].map((command) => ({ command })),
)("recognizes owned current and legacy launchers: $command", ({ command }) => {
  expect(isOwnedClientRegistrationCommand(command)).toBe(true);
});

it.each(
  [
    ["cmd.exe", "/d", "/c", "node", "custom.js", "mcp"],
    ["cmd.exe", "/k", "npx", "-y", "rea-agents@5.0.0", "mcp"],
    ["cmd.exe", "/c", "npx -y rea-agents@5.0.0 mcp"],
    ["cmd.exe", "/c", "npx", "-y", "another-package", "mcp"],
    ["cmd.exe", "/c", "npx", "-y", "rea-agents@5.0.0", "mcp", "&", "other"],
    ["cmd.exe", "/c", "npx", "-y", "rea-agents@5.0.0 & other", "mcp"],
  ].map((command) => ({ command })),
)(
  "does not claim custom shell commands as REA-owned: $command",
  ({ command }) => {
    expect(isOwnedClientRegistrationCommand(command)).toBe(false);
  },
);
