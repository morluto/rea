#include <stdio.h>

volatile int rea_c_global = 7;

__attribute__((noinline, used)) int rea_leaf(int value) {
  puts("REA_C_LEAF");
  return value + rea_c_global;
}

__attribute__((noinline, used)) int rea_branch(int value) {
  return value > 3 ? rea_leaf(value) : rea_leaf(-value);
}

__attribute__((noinline, used)) int rea_entry(void) {
  puts("REA_C_ENTRY");
  return rea_branch(5);
}

int main(void) { return rea_entry() == 12 ? 0 : 1; }
