#include <stdio.h>

volatile int rea_ghidra_inventory_global = 7;

__attribute__((noinline, used)) int rea_ghidra_inventory_leaf(int value) {
  puts("REA_GHIDRA_LEAF_VALUE");
  return value + rea_ghidra_inventory_global;
}

__attribute__((noinline, used)) int rea_ghidra_inventory_branch(int value) {
  if (value > 10) {
    return rea_ghidra_inventory_leaf(value);
  }
  return rea_ghidra_inventory_leaf(-value);
}

__attribute__((noinline, used)) int rea_ghidra_inventory_indirect(
    int (*callback)(int), int value) {
  return callback(value);
}

__attribute__((noinline, used)) int rea_ghidra_inventory_entry(void) {
  puts("REA_GHIDRA_INVENTORY_ENTRY");
  return rea_ghidra_inventory_branch(35) +
         rea_ghidra_inventory_indirect(rea_ghidra_inventory_leaf, 0);
}

int main(void) { return rea_ghidra_inventory_entry() == 49 ? 0 : 1; }
