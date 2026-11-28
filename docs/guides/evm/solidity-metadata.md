# Solidity metadata verification

`verify_solidity_metadata` (CLI `verify-solidity-metadata`) checks whether a
local metadata JSON file is the one committed to by the CBOR trailer at the end
of selected EVM bytecode. It runs offline: no engine, execution, IPFS or Swarm
access, and no source retrieval.

```bash
rea verify-solidity-metadata /absolute/path/runtime.hex hex /absolute/path/metadata.json --json
```

Supply the metadata exactly as the compiler emitted it (the `metadata` string of
Standard JSON output). Reformatting it or adding a final newline makes a
different file.

## Verdict

`binding.status` is `match`, `mismatch` or `unverified`. `recorded` is the
commitment found in the bytecode and `computed` the supplied file's hash.

| `binding.reason`                 | Meaning                                          |
| -------------------------------- | ------------------------------------------------ |
| `no_decoded_trailer`             | No metadata trailer could be decoded             |
| `no_commitment`                  | The trailer records no content hash              |
| `multiple_commitments`           | More than one content hash is recorded           |
| `unsupported_scheme`             | A Swarm commitment (`bzzr0`, `bzzr1`)            |
| `unrecognized_commitment`        | The IPFS value is not a SHA-256 multihash        |
| `metadata_exceeds_admitted_size` | Over 45,613,056 bytes, which needs a deeper tree |

The result also carries the decoded trailer, described in the
[EVM bytecode guide](evm-bytecode.md).

A match shows only that the file's bytes have the recorded hash. It does not
verify source code, compilation, deployment or who produced either file.

`max_file_bytes` (default 4 MiB) and `max_metadata_bytes` (default 16 MiB)
apply to the next call.
