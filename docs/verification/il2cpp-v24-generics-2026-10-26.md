# IL2CPP version-24 generic method verification

Executed on Windows x64 with Node 24.22.1 and npm 11.16.0. The change extends
the existing static linker; it does not load the target DLL or execute its code.

## Input and independent comparison

The input is Cpp2IL's public
[Simple_2019_4_34 test build](https://github.com/SamboyCoding/Cpp2IL/tree/b5ad444b82267cb1e4b88b8b373c008105bdea52/TestFiles/Simple_2019_4_34).
Its README identifies Unity 2019.4.34f1, Windows IL2CPP, .NET Standard,
release C++ compilation and low stripping. The files were read locally and
are not committed to REA.

| File                                                             |      Bytes | SHA-256                                                            |
| ---------------------------------------------------------------- | ---------: | ------------------------------------------------------------------ |
| `GameAssembly.dll`                                               | 10,529,280 | `9744feef3e12b108de12674a121e772a229928f77ceb13e7ebdaf5bd588d6f95` |
| `Simple_2019_4_34_Data/il2cpp_data/Metadata/global-metadata.dat` |  2,594,096 | `19ce9d1de2453f0bcdab35c939ae5b5054797a7ff717fd4ba37500ca72fcd1fd` |

[Il2CppDumper 6.7.46](https://github.com/Perfare/Il2CppDumper/releases/tag/v6.7.46)
(`Il2CppDumper-win-v6.7.46.zip`, SHA-256
`f5fc60dfc5c034c1ff3fc651514416ebd47658a63493207734537fd25fa2dea2`)
reported metadata layout 24.4 and binary layout 24.5. Its CodeRegistration was
`0x180874c40` and MetadataRegistration was `0x180878330`.

With `RequireAnyKey` and `GenerateDummyDll` disabled in its local configuration,
run the downloaded tool against those two files, writing to a separate output
directory. Keep `GenerateStruct` enabled to obtain `script.json`:

```text
Il2CppDumper.exe GameAssembly.dll global-metadata.dat oracle-output
```

## Observed results

Before the production change, the source reader at upstream `f6805e29c`
decoded 2,926 types and 17,406 methods, then refused `genericInstances: true`
with `generic-methods-unsupported`. The three new registration-layout cases
also failed against that unchanged producer with the same reason.

After the change, the source reader and built CLI returned 13,902 generic rows:
13,852 `code`, 50 `no-body`, zero `unknown`, and zero issues. REA selected
16-byte rows and `generic_method_pointers_field: 0x180874c50`.
Every `code` row matched an Il2CppDumper `ScriptMethod` entry by numeric RVA
and exact name. This is a comparison of REA's emitted rows, not a claim that
every possible runtime instance or every oracle entry was enumerated.

The real stdio MCP server returned the same counts and artifact identities in
its summary. Queries using `normalized_result.parent_evidence_id` retrieved
rows 0 and 13,901 with the same names, addresses and indices as the CLI.

To repeat CLI inspection after building REA:

```sh
node scripts/rea.mjs inspect-il2cpp-metadata /absolute/path/global-metadata.dat \
  --binary /absolute/path/GameAssembly.dll --generic-instances --json > rea.json
```

The exact comparison, after reading those JSON files, is:

```js
const pairs = new Set(
  oracle.ScriptMethod.map((row) => `${row.Address}:${row.Name}`),
);
const rows = rea.normalized_result.generic_method_instances;
const missing = rows.filter(
  (row) =>
    row.state === "code" &&
    !pairs.has(`${Number(BigInt(row.rva))}:${row.name}`),
);
// Observed: rows.length === 13902; missing.length === 0.
```

## Regression scope and limitations

Authored fixtures cover the 96/12, 112/12 and 120/16 module-offset/row-stride
layouts, the version-24 definition index with nonzero alignment padding,
generic class and method arguments, a mismatched version-27 registration,
ambiguous layouts, and empty tables. CLI/MCP tests cover version 24 alongside
31, including unchanged names, shared-address Ghidra seeds and refusal when
the required binary is omitted. Existing malformed-input, ownership and
unknown-row tests remain in place.

Real-build verification covers this Windows x64 24.5 input only. The 24.2 and
24.3/24.4 registration candidates have fixture coverage, not real-build
verification. Earlier version-24 metadata layouts and version 39 generic
linking remain unsupported. No Ghidra import, live Unity execution, runtime
dispatch, or performance improvement is claimed.
