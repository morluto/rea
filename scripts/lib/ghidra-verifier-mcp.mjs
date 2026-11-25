/** Bind verifier calls to the SDK client and the selected request budget. */
export function createGhidraVerifierMcpOperations(client, requestOptions) {
  const callTool = (request) => client.callTool(request, requestOptions);
  return {
    connect: (transport) => client.connect(transport, requestOptions),
    callTool,
    decodedCall:
      (decode) =>
      async (name, args = {}) =>
        decode(await callTool({ name, arguments: args }), name),
  };
}
