# Firmware interrupt and trap vector tables

`inspect_firmware_vector_table` (`rea inspect-firmware-vector-table`) decodes
ARM M-profile (`armv6-m`, `armv7-m`, `armv8-m`) exception/IRQ vector tables and
RISC-V `mtvec` trap tables directly from a local firmware image without opening
an analysis session or executing target code.

## When to use it

Bare-metal and RTOS microcontroller firmware enters execution through hardware
reset, fault, timer, and peripheral interrupt vectors rather than a hosted
`main` symbol. Use `inspect_firmware_vector_table` to:

- Inventory `InitialSP`, `Reset`, `NMI`, `HardFault`, `MemManage` / `BusFault` /
  `UsageFault` / `DebugMonitor` (`armv7-m` and `armv8-m`; architecturally
  reserved on `armv6-m`), `SecureFault` (`armv8-m`), `SVCall`, `PendSV`,
  `SysTick`, and external `IRQ 0..N` handler entry points before disassembling
  individual ISRs with `open_binary` or Rizin.
- Detect Thumb bit-0 clear violations (`invalid_even_thumb_address`), non-zero
  reserved slots (`nonzero_reserved`), VTOR 128-byte alignment mismatches, and
  shared default/infinite-loop stubs (`shared_handler_groups`).
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
```

In MCP, call `inspect_firmware_vector_table` with `path`, `architecture`, and
`base_address`, plus optional `vector_table_offset`, `max_entries`, `svd_xml`,
`max_svd_xml_nodes`, `max_svd_expanded_chars`, and `max_file_bytes`.

## Provenance and limitations

- Architectural slot names (`Reset`, `HardFault`, `SysTick`,
  `MachineTimerInterrupt`) carry `name_basis: "architecture_manual"`.
- External IRQs matched through `svd_xml` carry `name_basis: "explicit_profile"`
  and `peripheral_name`; duplicate IRQ numbers in an SVD file keep `name: null`
  and list `ambiguous_profile_names`.
- Unmapped external IRQs keep `name: null` (`name_basis: "observed_slot"`).
- On RISC-V, whether the CPU uses `mtvec` in `DIRECT` or `VECTORED` mode at
  runtime is determined by `csrw mtvec` code rather than the table bytes alone.
