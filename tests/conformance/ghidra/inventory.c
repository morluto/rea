#include <stdio.h>

volatile int rea_ghidra_inventory_global = 7;

__attribute__((noinline, used)) int rea_ghidra_inventory_leaf(int value) {
  puts("REA_GHIDRA_LEAF_VALUE");
  return value + rea_ghidra_inventory_global;
}

__attribute__((noinline, used)) int rea_ghidra_inventory_entry(void) {
  puts("REA_GHIDRA_INVENTORY_ENTRY");
  return rea_ghidra_inventory_leaf(35);
}

int main(void) { return rea_ghidra_inventory_entry() == 42 ? 0 : 1; }
