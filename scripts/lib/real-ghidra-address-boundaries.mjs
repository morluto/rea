import assert from "node:assert/strict";

/** Exercise segmented-address truncation through real CLI/MCP reads and edits. */
export async function verifyGhidraAddressBoundaries(client, entry, cli) {
  const query = async (name, args) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 240000 },
    );
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return reply.structuredContent.normalized_result;
  };
  const before = await query("analyze_function", { procedure: entry });
  // The segmented parser used to discard the high 32 bits and alias this entry.
  const overflow = (0x100000000n + BigInt(entry)).toString(16);
  const representations = [
    `0x${overflow}`,
    `0X${overflow}`,
    overflow,
    `ram:0x${overflow}`,
    `%72am:0x${overflow}`,
  ];
  for (const address of representations) {
    for (const [name, args] of [
      ["read_bytes", { address, length: 1 }],
      ["inspect_native_instruction", { address }],
      ["resolve_containing_procedure", { address }],
      ["procedure_info", { procedure: address }],
      [
        "annotate_native_function",
        {
          procedure: address,
          name: "MUST_NOT_ALIAS",
          comment: "MUST NOT WRITE",
        },
      ],
    ]) {
      const reply = await client.callTool(
        { name, arguments: args },
        { timeout: 240000 },
      );
      assert.equal(reply.isError, true, `${name} accepted ${address}`);
      const error = reply.structuredContent?.error;
      assert.equal(error?.code, "invalid_request", JSON.stringify(reply));
      assert.equal(error.details.operation, name);
      const issues = JSON.stringify(error.details.issues);
      assert.match(issues, /cannot be represented without truncation/u);
      assert.ok(issues.includes(address), issues);
      assert.equal(reply.structuredContent.evidence, undefined);
    }
  }
  assert.deepEqual(
    await query("analyze_function", { procedure: entry }),
    before,
    "Rejected oversized annotations changed the aliased function",
  );
  // Leading zeros and an encoded explicit space preserve the requested offset.
  const padded = `%72am:0x0000${BigInt(entry).toString(16)}`;
  assert.deepEqual(
    await query("read_bytes", { address: padded, length: 1 }),
    await query("read_bytes", { address: entry, length: 1 }),
  );
  for (const [command, flags, operation] of [
    ["read-bytes", ["--length", "1"], "read_bytes"],
    [
      "annotate-native-function",
      ["--name", "MUST_NOT_ALIAS"],
      "annotate_native_function",
    ],
  ]) {
    let failure;
    try {
      await cli(command, representations[0], flags);
    } catch (error) {
      assert.equal(error.code, 1);
      failure = JSON.parse(error.stdout);
    }
    assert.equal(failure?.code, "invalid_request");
    assert.equal(failure.details.operation, operation);
    assert.match(
      JSON.stringify(failure.details.issues),
      /cannot be represented without truncation/u,
    );
  }
}
