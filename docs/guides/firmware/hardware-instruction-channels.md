# Non-MMIO hardware instruction channels

`inspect_procedure_hardware_instructions` (`rea inspect-procedure-hardware-instructions`)
is a provider-neutral disassembly workflow that extracts architectural hardware
instructions outside memory-mapped I/O from one analyzed procedure via
`read_function_instructions`.

## When to use it

Reset handlers, bootloaders, RTOS context switches, hypervisors, and x86 BIOS or
SMM routines control core hardware state through privileged ISA instructions
rather than load/store MMIO accesses—operations that decompilers frequently
collapse into opaque intrinsics.

Supported `hardware_architecture` families:

- `arm`: Cortex-M and A-profile `MRS`/`MSR` (`MSP`, `PSP`, `MSPLIM`, `PSPLIM`,
  `PRIMASK`, `BASEPRI`, `FAULTMASK`, `CONTROL`, `CPSR`, `SPSR`, including field
  masks such as `CPSR_c` and conditional/Thumb width forms such as `mrsne`,
  `msreq`, `mrcne`, `cpsie.w`), `CPSID`/`CPSIE`, `MCR`/`MRC`/`MCRR`/`MRRC`
  coprocessor transfers (`CP15`/`CP14`), `DSB`/`DMB`/`ISB`, and
  `WFI`/`WFE`/`SEV`/`SVC`/`BKPT`.
- `arm64`: `MRS`/`MSR` (`SCTLR_EL*`, `VBAR_EL*`, `TTBR*`, `MAIR_EL*`, `ESR_EL*`,
  `ELR_EL*`, `DAIF`, `CurrentEL`, numeric `S3_*` encodings), `TLBI`/`IC`/`DC`/`AT`,
  `DSB`/`ISB`, and `SVC`/`HVC`/`SMC`/`ERET`.
- `riscv`: `csrrw`/`csrrs`/`csrrc` and pseudo-ops (`csrr`, `csrw`, `csrs`,
  `csrc`, `csrsi`, `csrci`) across standard CSRs (`mstatus`, `mie`, `mtvec`,
  `mepc`, `mcause`, `mtval`, `satp`, `pmpcfg*`, `pmpaddr*`), distinguishing
  zero-source non-mutating reads (`csrsi csr, 0`, `csrs csr, zero`) from
  writes, plus `mret`/`sret`/`ecall`/`wfi` and `fence`/`fence.i`/`sfence.vma`.
- `xtensa`: `rsr`/`wsr`/`xsr` special registers (`PS`, `INTENABLE`, `VECBASE`,
  `CCOUNT`, `EXCCAUSE`), `rsil`, `waiti`, and `memw`/`isync`/`dsync`.
- `mips`: `mfc0`/`mtc0` CP0 transfers, `ei`/`di`, `eret`, `sync`/`ehb`, and
  `cache`/`tlbwi`/`tlbwr`.
- `x86` and `x86_64`: `in`/`out`/`ins*`/`outs*` port I/O (attributing 8-bit
  immediate ports `0x00..0xff` such as `0x70`/`0x71` CMOS/RTC, `0x60`/`0x64`
  8042/EC, `0x80` POST, and `0xb2`/`0xb3` APM/SMI across `0x`, Intel `h`, `$`,
  and decimal syntax, while 16-bit ports such as `0xcf8`/`0xcfc` PCI or `0x3f8`
  UART accessed through `DX` report `target: null` with
  `target_basis: "unresolved_register"`), `rdmsr`/`wrmsr`, `mov cr*`/`dr*`,
  `lgdt`/`lidt`, `cli`/`sti`, `wbinvd`/`invlpg`, `cpuid`, and `rsm`/`vmcall`.

## CLI and MCP usage

```bash
rea inspect-procedure-hardware-instructions firmware.elf Reset_Handler \
  --hardware-architecture arm
```

In MCP, open a target with `open_binary`, then call
`inspect_procedure_hardware_instructions` with `procedure` and
`hardware_architecture`.

## Provenance and limitations

- Register-indirect port or MSR indices (`in al, dx`, `out dx, eax`,
  `rdmsr`/`wrmsr` via `ECX`) report `target: null` and
  `target_basis: "unresolved_register"` rather than guessing register values;
  pair with `trace_native_values` or `analyze_function` when constant
  propagation is needed. Symbolic or unparsed operand tokens report
  `target_basis: "unresolved_operand"` without counting as register-dynamic.
- Space-qualified native coordinates from multi-space providers (such as
  `rom:0x1000` or `overlay%3Aspace:0x1000`) are preserved verbatim on
  `instruction_address`.
- Body coverage reflects the selected provider's `read_function_instructions`
  extent and inherits any provider terminal-call caveats in `limitations`.
