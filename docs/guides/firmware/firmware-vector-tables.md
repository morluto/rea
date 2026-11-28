# Firmware interrupt and trap vector tables

`inspect_firmware_vector_table` (`rea inspect-firmware-vector-table`) decodes
ARM M-profile exception/IRQ vector tables (`armv6-m`, `armv7-m`, `armv7e-m`,
`armv8-m.base`, `armv8-m.main`, `armv8.1-m.main`, the same variant names
`open_binary` accepts for raw images) and
RISC-V `mtvec` trap tables directly from a local firmware image without opening
an analysis session or executing target code.

## When to use it

Bare-metal and RTOS microcontroller firmware enters execution through hardware
reset, fault, timer, and peripheral interrupt vectors rather than a hosted
`main` symbol. Use `inspect_firmware_vector_table` to:

- Inventory `InitialSP`, `Reset`, `NMI`, `HardFault`, `MemManage` / `BusFault` /
  `UsageFault` / `DebugMonitor` (ARMv7-M and ARMv8-M Mainline; reserved on
  ARMv6-M and ARMv8-M Baseline), `SecureFault` (ARMv8-M Mainline, present only
  with the Security Extension), `SVCall`, `PendSV`, `SysTick`, and external
  `IRQ 0..N` handler entry points before disassembling individual ISRs with
  `open_binary` or Rizin.
- Detect Thumb bit-0 clear violations (`invalid_even_thumb_address`), non-zero
  reserved slots (`nonzero_reserved`), an initial stack pointer that is not
  word-aligned, VTOR alignment below the 128-byte ARMv7-M/ARMv8-M minimum, and
  handlers shared by several slots (`shared_handler_groups`, most-shared first),
  which is how a default handler usually appears. `vtor_aligned` is `null` on
  ARMv6-M, whose VTOR is optional and implementation-defined.
- Decode RISC-V `mtvec` `JAL`, compressed `C.J`, and `AUIPC`+`JALR` jump slots
  (clearing `JALR` bit 0 and reporting slot 0's target in `trap_entry_address`
  while leaving `reset_code_address` `null`) across standard cause codes
  (`MachineSoftwareInterrupt`, `MachineTimerInterrupt`,
  `MachineExternalInterrupt`) and local interrupt slots (`>= 16`).
- Bind external IRQ numbers to declared peripheral interrupt names from an
  optional caller-supplied CMSIS-SVD XML text (`svd_xml`) within
  `max_svd_xml_nodes` and `max_svd_expanded_chars` without guessing vendor names
  when no profile is provided.

## CLI and MCP usage

```bash
rea inspect-firmware-vector-table firmware.bin \
  --architecture armv7-m \
  --base-address 0x08000000 \
  --vector-table-offset 0 \
  --max-entries 128

# Emit a bounded summary receipt while saving complete Evidence to a bundle
rea inspect-firmware-vector-table firmware.bin \
  --architecture armv7-m \
  --base-address 0x08000000 \
  --detail summary \
  --evidence_output vector-table.evidence.json
```

In MCP, call `inspect_firmware_vector_table` with `path`, `architecture`, and
`base_address`, plus optional `vector_table_offset`, `max_entries`, `svd_xml`,
`max_svd_xml_nodes`, `max_svd_expanded_chars`, `max_file_bytes`, and `detail`
(`"complete"` or `"summary"`). When `detail: "summary"` is selected (or when
omitted `detail` exceeds the agent response budget), complete Evidence is
retained and individual slots, shared-handler groups, and anomalies can be paged
with `inspect_analysis_view` (`kind: "firmware-vector-table"`, collections
`arm_entries`, `riscv_slots`, `shared_handler_groups`, and `anomalies`, or
`kind: "evidence-json"`).

## Provenance and limitations

- Architectural slot names (`Reset`, `HardFault`, `SysTick`,
  `MachineTimerInterrupt`) carry `name_basis: "architecture_manual"`.
- External IRQs matched through `svd_xml` carry `name_basis: "explicit_profile"`
  and `peripheral_name`; duplicate IRQ numbers in an SVD file keep `name: null`
  and list `ambiguous_profile_names`.
- Unmapped external IRQs keep `name: null` (`name_basis: "observed_slot"`).
- On RISC-V, whether the CPU uses `mtvec` in `DIRECT` or `VECTORED` mode at
  runtime is determined by `csrw mtvec` code rather than the table bytes alone.
  In vectored mode slot 0 also receives every synchronous exception. A CLIC
  table (`mtvt`) holds handler addresses rather than jumps, so its slots decode
  as `unrecognized`.
- CMSIS-SVD `<interrupt>` values are bound as ARM IRQ numbers, or as RISC-V
  `mcause` codes 16 and up. A declaration without a name or with a value that
  is not a non-negative integer is reported in `anomalies` rather than dropped.
- Slots that would lie past the end of the 32-bit address space are not
  decoded, and coverage is `partial`.

## Sources

Exception numbers follow the Armv6-M, Armv7-M and Armv8-M Architecture
Reference Manuals and CMSIS-Core `IRQn_Type` (`core_cm0plus.h`, `core_cm3.h`,
`core_cm23.h`, `core_cm33.h`). VTOR alignment follows the manuals' TBLOFF
field; CMSIS places it at bit 7 on Cortex-M3/M4/M7/M23/M33 and at bit 8 on
Cortex-M0+, so ARMv6-M alignment is reported as unknown. RISC-V causes, `mtvec`
modes and alignment follow the RISC-V Privileged Architecture; CLIC follows the
RISC-V CLIC specification. The `<interrupt><value>` type is `xs:integer` in
`CMSIS-SVD.xsd`; hexadecimal values are also accepted because vendor files use
them.
