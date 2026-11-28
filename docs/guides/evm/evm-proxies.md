# EVM proxy recognition

`inspect_evm_proxy` (CLI `inspect-evm-proxy`) checks whether explicit local
runtime bytecode is the standard [ERC-1167](https://eips.ethereum.org/EIPS/eip-1167)
minimal proxy clone, reads the address embedded in it, and interprets recorded
[ERC-1967](https://eips.ethereum.org/EIPS/eip-1967) storage words you supply. It runs offline on any
supported host: no engine, execution, RPC or address lookup.

```bash
rea inspect-evm-proxy /absolute/path/runtime.hex hex --json
```

Select `raw` for bytes or `hex` for UTF-8 hex with an optional `0x` prefix.

## Recorded storage slots

Pass `snapshot` with `chain_id`, `block`, `account` and `slots`. Each of
`implementation`, `admin` and `beacon` is an optional 32-byte `0x` word.

```bash
rea inspect-evm-proxy /absolute/path/runtime.hex hex --json \
  --snapshot '{"chain_id":1,"block":100,"account":"0x1111111111111111111111111111111111111111","slots":{"implementation":"0x0000000000000000000000002222222222222222222222222222222222222222"}}'
```

Slot status is `unavailable` (not supplied), `zero`, `address`, or
`not_an_address` (any of the high 12 bytes set).

## Result

| Field      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `artifact` | Carrier path, SHA-256, size and selected encoding                    |
| `bytecode` | SHA-256 and size of the decoded bytes                                |
| `pattern`  | `erc1167` with `implementation` and byte range, or `none_recognized` |
| `snapshot` | Supplied chain, block and account, or null                           |
| `slots`    | The three ERC-1967 positions, their status and supplied word         |
| `edges`    | Inferred implementation or beacon targets and the evidence used      |

An edge from bytecode has a null `from`: the selected bytes are not proven to
belong to any account. The admin slot creates no edge. A beacon's
implementation is not resolved.

Only the exact 45-byte runtime matches. `none_recognized` does not show that the
code is not a proxy: shortened-address clones and other proxy patterns are not
inspected. Supplied words are not verified against any chain, and no match shows
that a call was delegated.

`max_file_bytes` limits the carrier size (default 4 MiB) and applies to the next
call.
