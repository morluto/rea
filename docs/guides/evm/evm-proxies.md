# EVM proxy recognition

`inspect_evm_proxy` (CLI `inspect-evm-proxy`) checks whether explicit local
runtime bytecode is the standard [ERC-1167](https://eips.ethereum.org/EIPS/eip-1167)
minimal proxy clone, and reads the address embedded in it. It runs offline on any
supported host: no engine, execution, RPC or address lookup.

```bash
rea inspect-evm-proxy /absolute/path/runtime.hex hex --json
```

Select `raw` for bytes or `hex` for UTF-8 hex with an optional `0x` prefix.

## Result

| Field      | Meaning                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `artifact` | Carrier path, SHA-256, size and selected encoding                                |
| `bytecode` | SHA-256 and size of the decoded bytes                                            |
| `pattern`  | `erc1167` with `implementation` and its decoded-byte range, or `none_recognized` |

Only the exact 45-byte runtime matches. `none_recognized` does not show that the
code is not a proxy: shortened-address clones, ERC-1967 storage slots and other
proxy patterns are not inspected. A match does not establish deployment, what code
exists at the embedded address, or that any call was delegated.

`max_file_bytes` limits the carrier size (default 4 MiB) and applies to the next
call.
