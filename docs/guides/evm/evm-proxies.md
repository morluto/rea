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

## Following a chain

With a root `snapshot`, pass `related`: a list of other accounts, each with
`path`, `encoding` and its own `snapshot`. REA follows edges from the root
through entries recorded on the same `chain_id` and `block`. An account may be
supplied once per chain and block.

| Step `status`       | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| `supplied`          | You provided that account at the same chain and block |
| `not_supplied`      | No entry names that account                           |
| `snapshot_mismatch` | Entries name it only for another chain or block       |
| `cycle`             | The edge returns to an account already on the path    |

## Result

| Field      | Meaning                                                              |
| ---------- | -------------------------------------------------------------------- |
| `artifact` | Carrier path, SHA-256, size and selected encoding                    |
| `bytecode` | SHA-256 and size of the decoded bytes                                |
| `pattern`  | `erc1167` with `implementation` and byte range, or `none_recognized` |
| `snapshot` | Supplied chain, block and account, or null                           |
| `slots`    | The three ERC-1967 positions, their status and supplied word         |
| `edges`    | Inferred implementation or beacon targets and the evidence used      |
| `related`  | The same facts for each related account, and whether it was reached  |
| `chain`    | Followed edges in depth-first order with their status                |

An edge from bytecode has a null `from`: the selected bytes are not proven to
belong to any account. The admin slot creates no edge. A beacon's
implementation is not resolved.

Only the exact 45-byte runtime matches. `none_recognized` does not show that the
code is not a proxy: shortened-address clones and other proxy patterns are not
inspected. Supplied words are not verified against any chain, and no match shows
that a call was delegated.

`max_file_bytes` limits each carrier (default 4 MiB) and applies to the next
call.
