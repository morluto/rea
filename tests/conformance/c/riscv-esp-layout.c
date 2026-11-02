/*
 * Freestanding ESP-IDF flash layout probe for REA's RISC-V lane. REA never
 * runs it. tests/conformance/esp/esp32c6-shared-window.ld places .flash.text
 * where the NOBITS .flash_rodata_dummy reserves the same addresses, as
 * ESP-IDF does for ESP32-C6 and H4.
 */
#define REA_FLASH __attribute__((section(".flash.text"), noinline))
#define REA_IRAM __attribute__((section(".iram0.text"), noinline))

volatile int rea_riscv_esp_sink;
const int rea_riscv_esp_table[2] = {7, 9};

REA_FLASH __attribute__((noreturn)) void rea_riscv_esp_restart(void) {
  for (;;) rea_riscv_esp_sink = 1;
}

REA_FLASH int rea_riscv_esp_sum(int left, int right) {
  return left + right + rea_riscv_esp_table[1];
}

/* Ends with the no-return call, as ESP-IDF's app_main ends with esp_restart(). */
REA_FLASH void rea_riscv_esp_main(void) {
  rea_riscv_esp_sink = rea_riscv_esp_sum(2, 3);
  rea_riscv_esp_restart();
}

/* Follows rea_riscv_esp_main; pseudocode that runs past the call shows 0x5a5a. */
REA_FLASH void rea_riscv_esp_next(void) { rea_riscv_esp_sink = 0x5a5a; }

/* IRAM calls flash code through auipc+jalr, as ESP-IDF's startup does. */
REA_IRAM void rea_riscv_esp_entry(void) {
  rea_riscv_esp_main();
}
