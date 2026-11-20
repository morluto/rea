import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const sourceUnit = "fixtures/~unicode-λ/compiler-artifacts.sol";
export const compilerVersion = "0.8.30+commit.73712a01.Emscripten.clang";

/** Generate owned linked, unlinked and error-only outputs without source import resolution. */
export async function createSolcFixtureOutputs(modulePath) {
  const solc = (await import(pathToFileURL(modulePath).href)).default;
  assert.equal(solc.version(), compilerVersion);
  const source = await readFile(
    new URL("./compiler-artifacts.sol", import.meta.url),
    "utf8",
  );
  const compile = (linked) =>
    JSON.parse(
      solc.compile(
        JSON.stringify({
          language: "Solidity",
          sources: {
            [sourceUnit]: { content: source },
            "warning.sol": {
              content: "pragma solidity 0.8.30; contract WarningFixture {}",
            },
            "a/Same.sol": {
              content:
                "pragma solidity 0.8.30; contract Same { function alpha() external pure returns(uint) { return 1; } }",
            },
            "b/Same.sol": {
              content:
                "pragma solidity 0.8.30; contract Same { function beta() external pure returns(uint) { return 2; } }",
            },
          },
          settings: {
            evmVersion: "cancun",
            ...(linked
              ? {
                  libraries: {
                    [sourceUnit]: {
                      ExternalLibrary:
                        "0x1111111111111111111111111111111111111111",
                    },
                  },
                }
              : {}),
            outputSelection: {
              "*": {
                "*": [
                  "metadata",
                  "evm.bytecode",
                  "evm.deployedBytecode",
                  "evm.methodIdentifiers",
                ],
              },
            },
          },
        }),
      ),
    );
  const linked = compile(true);
  const unlinked = compile(false);
  for (const output of [linked, unlinked]) {
    assert.ok(
      !output.errors?.some(({ severity }) => severity === "error"),
      JSON.stringify(output.errors),
    );
    assert.ok(output.errors?.some(({ severity }) => severity === "warning"));
  }
  const failedCompile = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: {
          "broken.sol": {
            content: "pragma solidity 0.8.30; contract Broken { invalid }",
          },
        },
      }),
    ),
  );
  assert.ok(failedCompile.errors.some(({ severity }) => severity === "error"));
  return { linked, unlinked, failedCompile };
}
