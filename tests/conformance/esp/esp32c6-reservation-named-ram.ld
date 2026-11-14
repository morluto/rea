ENTRY(rea_riscv_esp_entry)
/*
 * esp32c6-shared-window.ld with the NOLOAD reservation named `ram`, the name of
 * the RISC-V default address space. Section names are display labels, so REA's
 * load preparation must still give the reservation an overlay space.
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
  /* ESP-IDF's text bounds: Ghidra pins the absolute ones; _etext is past the
     section's last byte. */
  .flash.text 0x42000020 :
  {
    _text_start = ABSOLUTE(.);
    *(.flash.text) *(.text .text.*)
    _text_end = ABSOLUTE(.);
    _etext = .;
  } :irom
  ram 0x42000020 (NOLOAD) :
  {
    _flash_rodata_dummy_start = .;
    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);
    . = ALIGN(0x10000) + 0x20;
  } :drom
  .flash.rodata : { *(.srodata .srodata.* .rodata .rodata.*) } :drom
  /DISCARD/ : { *(.comment) *(.note.*) }
}
