import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { zipWith } from "../../fixtures/apkSignature/v1SignatureBlock.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("advertises closed-session address and explicit-path APK tools according to their actual prerequisites", async () => {
  const root = await createTestTempDirectory(
    "rea-session-target-requirements-",
  );
  const path = join(root, "unsigned.zip");
  await writeFile(path, await zipWith([{ name: "sample.txt", data: "hello" }]));
  const { call } = await connectLocalToolsMcp();
  const status = async () => {
    const reply = await call("binary_session", {});
    expect(reply.isError).not.toBe(true);
    const result = toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
    expect(result).toMatchObject({ open: false, cleanup_pending: false });
    return expandToolAvailability(result.tool_availability);
  };
  const availability = (
    tools: Awaited<ReturnType<typeof status>>,
    name: string,
  ) => {
    const entry = tools.find((tool) => tool.name === name);
    expect(entry, `missing ${name} in binary_session`).toBeDefined();
    return entry;
  };

  const before = await status();
  expect(availability(before, "get_navigation_context")).toMatchObject({
    available: false,
    reason: "target_required",
  });
  expect.soft(availability(before, "inspect_address_context")).toMatchObject({
    available: false,
    reason: "target_required",
  });
  const owningAvailability = buildCapabilityInventory(
    { open: false, capabilities: [] },
    { processCaptureEnabled: false },
  );
  expect(availability(before, "inspect_address_context")?.remediation).toBe(
    owningAvailability.find((tool) => tool.name === "inspect_address_context")
      ?.remediation,
  );
  expect.soft(availability(before, "inspect_apk_signature")).toMatchObject({
    available: true,
    reason: "available",
    remediation: null,
  });

  const address = await call("inspect_address_context", { address: "0x1000" });
  expect(address.isError).toBe(true);
  expect(parseMcpToolError(address)).toMatchObject({
    error: { code: "target_unavailable" },
  });
  const apk = await call("inspect_apk_signature", { path });
  expect(apk.isError, JSON.stringify(apk)).not.toBe(true);
  expect(apk.structuredContent).toMatchObject({
    operation: "inspect_analysis_view",
  });

  const after = await status();
  expect(availability(after, "inspect_address_context")).toMatchObject({
    available: false,
    reason: "target_required",
  });
  expect(availability(after, "inspect_apk_signature")).toMatchObject({
    available: true,
    reason: "available",
  });
});

it("reports default address resolution unavailable for an artifact while retaining explicit-document results", async () => {
  const root = await createTestTempDirectory("rea-address-artifact-status-");
  const path = join(root, "sample.plist");
  await writeFile(
    path,
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Example</string></dict></plist>',
  );
  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  for (const detail of ["summary", "complete"] as const) {
    const reply = await call("binary_session", { detail });
    expect(reply.isError).not.toBe(true);
    const result = toolContract("binary_session").outputSchema.parse(
      reply.structuredContent,
    ).result;
    const entry = expandToolAvailability(result.tool_availability).find(
      (tool) => tool.name === "inspect_address_context",
    );
    expect(entry).toMatchObject({
      available: false,
      reason: "target_unsupported",
      remediation: expect.stringContaining("explicit document"),
    });
    const navigation = expandToolAvailability(result.tool_availability).find(
      (tool) => tool.name === "get_navigation_context",
    );
    expect(navigation).toMatchObject({
      available: false,
      reason: "target_unsupported",
      default_mode_available: false,
      modes: [
        { name: "current_selection", available: false },
        { name: "explicit_document", available: false },
      ],
    });
  }
  for (const input of [{}, { document: "sample.plist" }]) {
    const navigation = await call("get_navigation_context", input);
    expect(parseMcpToolError(navigation)).toMatchObject({
      error: {
        code: "capability_unavailable",
        details: { selection_reason: "target_unsupported" },
      },
    });
  }
  const implicit = await call("inspect_address_context", { address: "0x1000" });
  expect(parseMcpToolError(implicit)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: { selection_reason: "target_unsupported" },
    },
  });
  const explicit = await call("inspect_address_context", {
    address: "0x1000",
    document: "sample.plist",
  });
  expect(explicit.isError, JSON.stringify(explicit)).not.toBe(true);
  expect(explicit.structuredContent).toMatchObject({
    result: {
      name: { state: "unavailable" },
      procedure: { state: "unavailable" },
      comment: { state: "unavailable" },
      inline_comment: { state: "unavailable" },
      bookmarks: { state: "unavailable" },
    },
  });
});
