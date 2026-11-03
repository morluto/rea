import { expect, it } from "vitest";
import { ok } from "../../../src/domain/result.js";
import { compactInstruction } from "../../../src/domain/native/nativeInstruction.fixture.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it.each(["compact", "full"] as const)(
  "keeps the selected interior address and containing instruction separate (%s)",
  async (profile) => {
    const observed = {
      ...compactInstruction(),
      address: "overlay:0x1001",
      status: "not-instruction-boundary",
      procedure: null,
      bytes: null,
      length: null,
      mnemonic: null,
      raw_disassembly: null,
      operands: [],
      containing_instruction: {
        address: "overlay:0x1000",
        length: 4,
        mnemonic: "sub",
        raw_disassembly: "sub sp,sp,#0x10",
        provenance: "ghidra-listing",
      },
    };
    const harness = await connectGhidraMcp(
      "ghidra-containing-instruction",
      () => Promise.resolve(ok(observed)),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      const result = await harness.mcp.callTool({
        name: "inspect_native_instruction",
        arguments: { address: observed.address },
      });
      expect(result.isError).not.toBe(true);
      expect(
        sessionEvidence(harness.session, result.structuredContent)
          .normalized_result,
      ).toMatchObject({
        address: observed.address,
        status: observed.status,
        procedure: null,
        bytes: null,
        containing_instruction: observed.containing_instruction,
      });
    } finally {
      await harness.close();
    }
  },
);

it.each(["missing", "unexpected"] as const)(
  "rejects a %s containing instruction at the Ghidra boundary",
  async (condition) => {
    const observed = {
      ...compactInstruction(),
      address: "0x1001",
      status: condition === "missing" ? "not-instruction-boundary" : "decoded",
      ...(condition === "unexpected"
        ? {
            containing_instruction: {
              address: "0x1000",
              length: 4,
              mnemonic: "sub",
              raw_disassembly: "sub sp,sp,#0x10",
              provenance: "ghidra-listing",
            },
          }
        : {}),
    };
    const harness = await connectGhidraMcp("ghidra-invalid-containment", () =>
      Promise.resolve(ok(observed)),
    );
    try {
      const result = await harness.mcp.callTool({
        name: "inspect_native_instruction",
        arguments: { address: "0x1001" },
      });
      expect(parseMcpToolError(result).error).toMatchObject({
        code: "unreadable_output",
        details: { operation: "inspect_native_instruction" },
      });
    } finally {
      await harness.close();
    }
  },
);

it.each([
  ["different space", "other:0x1000"],
  ["instruction start", "overlay:0x1001"],
  ["past instruction", "overlay:0xff0"],
  ["invalid coordinate", "not-an-address"],
] as const)(
  "rejects a containing instruction with %s",
  async (_description, address) => {
    const observed = {
      ...compactInstruction(),
      address: "overlay:0x1001",
      status: "not-instruction-boundary",
      containing_instruction: {
        address,
        length: 4,
        mnemonic: "sub",
        raw_disassembly: "sub sp,sp,#0x10",
        provenance: "ghidra-listing",
      },
    };
    const harness = await connectGhidraMcp("ghidra-invalid-coordinate", () =>
      Promise.resolve(ok(observed)),
    );
    try {
      const result = await harness.mcp.callTool({
        name: "inspect_native_instruction",
        arguments: { address: observed.address },
      });
      expect(parseMcpToolError(result).error).toMatchObject({
        code: "unreadable_output",
        details: { operation: "inspect_native_instruction" },
      });
    } finally {
      await harness.close();
    }
  },
);

it.each(["compact", "full"] as const)(
  "retains a containing data identity without selecting a field (%s)",
  async (profile) => {
    const observed = {
      ...compactInstruction(),
      address: "overlay:0x1002",
      status: "data",
      procedure: null,
      bytes: null,
      length: null,
      mnemonic: null,
      raw_disassembly: null,
      containing_data: {
        address: "overlay:0x1000",
        length: 5,
        type_id: "/Record",
        provenance: "ghidra-listing",
      },
    };
    const harness = await connectGhidraMcp(
      "ghidra-containing-data",
      () => Promise.resolve(ok(observed)),
      { environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile } },
    );
    try {
      const result = await harness.mcp.callTool({
        name: "inspect_native_instruction",
        arguments: { address: observed.address },
      });
      expect(result.isError).not.toBe(true);
      expect(
        sessionEvidence(harness.session, result.structuredContent)
          .normalized_result,
      ).toMatchObject({
        address: observed.address,
        status: "data",
        containing_data: observed.containing_data,
      });
    } finally {
      await harness.close();
    }
  },
);

it.each([
  ["missing", undefined],
  [
    "wrong space",
    {
      address: "other:0x1000",
      length: 5,
      type_id: "/Record",
      provenance: "ghidra-listing",
    },
  ],
  [
    "outside extent",
    {
      address: "overlay:0x1000",
      length: 2,
      type_id: "/Record",
      provenance: "ghidra-listing",
    },
  ],
] as const)("rejects %s data containment", async (_name, containing_data) => {
  const observed = {
    ...compactInstruction(),
    address: "overlay:0x1002",
    status: "data",
    ...(containing_data === undefined ? {} : { containing_data }),
  };
  const harness = await connectGhidraMcp("ghidra-invalid-data", () =>
    Promise.resolve(ok(observed)),
  );
  try {
    const result = await harness.mcp.callTool({
      name: "inspect_native_instruction",
      arguments: { address: observed.address },
    });
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "unreadable_output",
      details: { operation: "inspect_native_instruction" },
    });
  } finally {
    await harness.close();
  }
});

it("rejects data containment on a decoded instruction", async () => {
  const observed = {
    ...compactInstruction(),
    address: "0x1001",
    containing_data: {
      address: "0x1000",
      length: 4,
      type_id: "/Record",
      provenance: "ghidra-listing",
    },
  };
  const harness = await connectGhidraMcp("ghidra-unexpected-data", () =>
    Promise.resolve(ok(observed)),
  );
  try {
    const result = await harness.mcp.callTool({
      name: "inspect_native_instruction",
      arguments: { address: observed.address },
    });
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "unreadable_output",
      details: { operation: "inspect_native_instruction" },
    });
  } finally {
    await harness.close();
  }
});
