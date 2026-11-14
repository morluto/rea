# ARM M-profile raw loads

## Status

Proposed. This is decision D1 of the embedded-target work, raised in
[#4246](https://github.com/morluto/rea/issues/4246) and implemented by
[#7951](https://github.com/morluto/rea/pull/7951). It remains provisional
until a maintainer accepts it.

## Context

A Cortex-M firmware dump is a raw image whose first words are a vector table:
the initial stack pointer, then the Reset handler as an odd Thumb address. Before
this decision, a raw load had one address, `entry_point`, which was also where
file offset 0 mapped. That cannot describe an image whose Reset handler is not
at its base, and it gives no way to select an M-profile decoder.
The [raw binary guide](../../providers/raw-binary.md#arm-m-profile-images)
describes the resulting inputs, refusals, identity and Evidence.

Rejected alternatives:

- A single `processor_variant: "cortex-m"` value
  ([#4927](https://github.com/morluto/rea/pull/4927)) cannot select the v8-M
  decoder.
- Folding ARMv8.1-M into `armv8-m.main` would use the same decoder but drop the
  profile from identity, and splitting it out later would change identity
  again.
- A language passthrough with a base (#4246, option C) exposes provider
  language ids in a provider-neutral contract.
- Masking odd entries hides the caller's value; refusing first keeps accepting
  them a later, additive change.
- A `role` that records how the entry was chosen mixes provenance with what the
  entry is.
- Naming the seeded function after its role, as CMSIS `Reset_Handler`, would
  claim a symbol the image does not carry.
- Leaving the basis and the vector-table address out of session identity would
  let a reused session report provenance or vector words that the current
  request did not produce. Putting them or the entry address in coordinate
  identity would make functions found from two entries of one image
  incomparable.
- Ghidra's default Cortex labels name every slot, reserved ones included, and at
  base `0x0` the code after the table; the vector table is admission's to read.
- A separate base for every raw family is a later, additive widening; it needs
  base-separated cases in the 6502 and m68k lanes and on Windows Ghidra P0,
  which admits raw 6502.

## Decision

- `architecture_variant` names the M profile, mapped to a Ghidra decoder as in
  the guide's table.
- With a variant, `base_address` is required and separate from the entry, and
  `vector_table_address` is optional.
- When a variant and a base are given without an entry, Reset is read from the
  vector table. Explicit odd entries are refused.
- The `segments` load image and versioned `raw_load` identity apply only to
  loads that are not legacy-equivalent.
- An entry `role` names its function; its `basis` is recorded separately.
- Coordinate identity comes from resolved values only, while session and
  snapshot identity also cover the provenance that results report.
- Ghidra's processor-defined labels are not applied to variant loads.

## Consequences

### Owner and consumers

`src/domain/architectureVariant.ts` owns the vocabulary.
`GHIDRA_VARIANT_LANGUAGES` owns the Ghidra mapping, which follows the GNU
architecture names in Ghidra 12.1.4's `ARM.ldefs`, and
`GHIDRA_VARIANT_LIMITATIONS` the decoder limitations that every lane reports for
a variant. Raw admission owns the load, its legacy equivalence, the entry's role
and basis, and its `raw_load` identity. The Ghidra profile owns the coordinate
context and the label policy. Consumers are the CLI and MCP inputs, target
summaries, the Ghidra profile, launcher, bridge and load-image attestation, and
snapshots.

### Costs of change

- Code: renaming an input is an alias with a deprecation period; remapping a
  variant or adding an M profile is one table row. Every row is an ARM M
  profile, and the base requirement, Reset derivation and label policy hold for
  all of them; a variant of another family would first make those per-row
  properties of the table.
- Compatibility: the `segments` shape and `raw_load` are permanent once
  released, so changes ship as `version: 2`. Their variant and instruction-set
  values are closed sets, so a version that predates a new value refuses the
  Evidence or snapshot instead of misreading it. The `segments` and `entries`
  arrays hold one element today and leave room for more; `vector_table` holds
  only the table address and the two words read, under the `segments` version.
- Migration: sessions and snapshots of loads that use these inputs are
  invalidated by any change to `raw_load`; legacy loads are not affected.
- Verification: rerun `npm run verify:ghidra:cortex-m`, which needs Ghidra
  12.1.4, JDK 21 and LLVM with Thumb targets.

### Known gap

Results report the canonical `entry_point`, `base_address` and
`vector_table_address`; none retains the spelling the caller passed, as legacy
`entry_point` did not before these inputs. Direct CLI requests keep the caller's
path as Evidence `caller_input_path`, outside semantic identity. Recording a load
selection's spellings the same way would be a later change, but not one older
readers accept: the Evidence envelope is strict, so REA versions without the new
field refuse records that carry it. A caller that needs its spelling keeps its
own request: an MCP client already holds its arguments, and a CLI caller can
save its command beside the Evidence it writes, together with its
`evidence_id`.
