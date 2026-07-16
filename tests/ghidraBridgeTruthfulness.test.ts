import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

let bridgeSource = "";
let queueSource = "";

beforeAll(async () => {
  [bridgeSource, queueSource] = await Promise.all([
    readFile(
      fileURLToPath(
        new URL("../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
      ),
      "utf8",
    ),
    readFile(
      fileURLToPath(
        new URL("../src/ghidra/GhidraRequestQueue.ts", import.meta.url),
      ),
      "utf8",
    ),
  ]);
});

describe("Ghidra bridge truthfulness", () => {
  it("owns one persistent decompiler interface for the Program lifetime", () => {
    expect(bridgeSource).toContain("private DecompInterface decompiler;");
    expect(bridgeSource.match(/new DecompInterface\(\)/gu)).toHaveLength(1);
    expect(
      bridgeSource.match(/decompiler\.openProgram\(currentProgram\)/gu),
    ).toHaveLength(1);
    expect(bridgeSource).toContain("decompiler.dispose()");
    expect(bridgeSource).toContain("DECOMPILE_TIMEOUT_SECONDS = 30");
    expect(bridgeSource).toContain(
      "decompileFunction(\n            function,\n            DECOMPILE_TIMEOUT_SECONDS",
    );
  });

  it("projects references and CFG from public Ghidra models", () => {
    expect(bridgeSource).toContain("getReferenceManager().getReferencesTo");
    expect(bridgeSource).toContain(
      "getReferencesFrom(instruction.getAddress())",
    );
    expect(bridgeSource).toContain(
      "new BasicBlockModel(currentProgram, false)",
    );
    expect(bridgeSource).toContain("block.getDestinations(monitor)");
    expect(bridgeSource).toContain(
      'result.addProperty("computed", type.isComputed())',
    );
    expect(bridgeSource).toContain(
      'result.addProperty("indirect", type.isIndirect())',
    );
    expect(bridgeSource).toContain(
      'result.addProperty("external", reference.isExternalReference())',
    );
    expect(bridgeSource).toContain("reference.isEntryPointReference()");
  });

  it("keeps function classification and targetless-flow uncertainty explicit", () => {
    expect(bridgeSource).toContain("function.isThunk()");
    expect(bridgeSource).toContain("function.isExternal()");
    expect(bridgeSource).toContain('"ghidra-function-manager"');
    expect(bridgeSource).toContain(
      "Unresolved computed or indirect flows without target addresses",
    );
    expect(bridgeSource).toContain(
      "not original source or Hopper-equivalent text",
    );
  });

  it("serializes a bounded request queue before crossing the socket", () => {
    expect(queueSource).toContain("class GhidraRequestQueue");
    expect(queueSource).toContain("if (this.#size >= this.maximum)");
    expect(queueSource).toContain("if (this.#active) return");
    expect(queueSource).toContain(
      "remaining = entry.deadline - performance.now()",
    );
  });

  it("binds the Windows fallback to authenticated IPv4 loopback", () => {
    expect(bridgeSource).toContain(
      'descriptor.transport.equals("unix-socket")',
    );
    expect(bridgeSource).toContain(
      'descriptor.transport.equals("authenticated-loopback-tcp")',
    );
    expect(bridgeSource).toContain('InetAddress.getByName("127.0.0.1")');
    expect(bridgeSource).toContain('endpoint.addProperty("host", "127.0.0.1")');
    expect(bridgeSource).toContain("StandardCopyOption.ATOMIC_MOVE");
  });

  it("does not admit mutation methods into the Java dispatch", () => {
    for (const method of [
      'case "set_comment"',
      'case "set_address_name"',
      'case "set_inline_comment"',
      'case "set_bookmark"',
    ])
      expect(bridgeSource).not.toContain(method);
  });
});
