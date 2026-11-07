ENTRY(rea_riscv_esp_entry)
/*
 * esp32c6-shared-window.ld with the NOLOAD reservation before the code in the
 * section table. Ghidra 12.1.4's ELF loader gives overlapping addresses to the
 * later section, so this order already loads the code in the default address
 * space, and REA's load preparation must change nothing.
 */
PHDRS
{
  iram PT_LOAD;
  dram PT_LOAD;
  irom PT_LOAD;
  drom PT_LOAD;
}
SECTIONS
{
  .iram0.text 0x40800000 : { *(.iram0.text) } :iram
  .dram0.data 0x40810000 : { *(.sdata .sdata.* .data .data.* .sbss .sbss.* .bss .bss.*) } :dram
  .flash_rodata_dummy 0x42000020 (NOLOAD) :
  {
    _flash_rodata_dummy_start = .;
    . = . + 0x10000;
  } :drom
  .flash.text 0x42000020 : { *(.flash.text) *(.text .text.*) } :irom
  .flash.rodata 0x42010020 : { *(.srodata .srodata.* .rodata .rodata.*) } :drom
  /DISCARD/ : { *(.comment) *(.note.*) }
}
