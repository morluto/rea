ENTRY(rea_riscv_esp_entry)
/*
 * ESP-IDF v6.1's ESP32-C6 application layout, reduced for REA's RISC-V lane
 * (components/esp_system/ld/esp32c6/memory.ld.in and sections.ld.in): flash
 * text and rodata share the 0x42000020 window, and the NOLOAD
 * .flash_rodata_dummy reserves the text's addresses in the rodata segment.
 * The two allocations overlap by design, so the link needs --no-check-sections.
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
  .flash.text 0x42000020 : { *(.flash.text) *(.text .text.*) } :irom
  .flash_rodata_dummy 0x42000020 (NOLOAD) :
  {
    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);
    . = ALIGN(0x10000) + 0x20;
  } :drom
  .flash.rodata : { *(.srodata .srodata.* .rodata .rodata.*) } :drom
  /DISCARD/ : { *(.comment) *(.note.*) }
}
