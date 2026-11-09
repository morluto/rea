ENTRY(rea_riscv_esp_entry)
/*
 * esp32c6-shared-window.ld with names the load preparation's temporary blocks
 * must avoid: the reservation is named `.flash.text.rea`, the code's first
 * temporary name, and a disjoint section takes the next, `.flash.text.rea.1`.
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
  .flash.text.rea.1 0x40808000 : { LONG(0x00000013) } :iram
  .dram0.data 0x40810000 : { *(.sdata .sdata.* .data .data.* .sbss .sbss.* .bss .bss.*) } :dram
  .flash.text 0x42000020 :
  {
    _text_start = ABSOLUTE(.);
    *(.flash.text) *(.text .text.*)
    _text_end = ABSOLUTE(.);
    _etext = .;
  } :irom
  .flash.text.rea 0x42000020 (NOLOAD) :
  {
    _flash_rodata_dummy_start = .;
    . = ALIGN(ALIGNOF(.flash.text)) + SIZEOF(.flash.text);
    . = ALIGN(0x10000) + 0x20;
  } :drom
  .flash.rodata : { *(.srodata .srodata.* .rodata .rodata.*) } :drom
  /DISCARD/ : { *(.comment) *(.note.*) }
}
