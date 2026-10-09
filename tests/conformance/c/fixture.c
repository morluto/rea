#include <stdio.h>

volatile int rea_c_global = 7;

#define REA_LONG_CHUNK "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
#define REA_LONG_256 REA_LONG_CHUNK REA_LONG_CHUNK REA_LONG_CHUNK REA_LONG_CHUNK
#define REA_LONG_1024 REA_LONG_256 REA_LONG_256 REA_LONG_256 REA_LONG_256
__attribute__((noinline, used)) void rea_long_literal_procedure(void) {
  puts("REA_LONG_LITERAL_" REA_LONG_1024 REA_LONG_1024 REA_LONG_1024 REA_LONG_1024 "needle");
  puts("REA_UTF8_é_😀");
  puts("REA_ESCAPED_\"\\line\nend\t\r");
  puts("REA_LITERAL_BACKSLASH_\\n");
  puts("REA_LITERAL_…");
  puts("REA_LATIN1_\xff");
}

__attribute__((noinline, used)) int rea_leaf(int value) {
  puts("REA_C_LEAF");
  return value + rea_c_global;
}

__attribute__((noinline, used)) int rea_branch(int value) {
  return value > 3 ? rea_leaf(value) : rea_leaf(-value);
}

__attribute__((noinline, used)) int rea_entry(void) {
  puts("REA_C_ENTRY");
  /* Give the native locals oracle explicit stack storage. */
  volatile int input = 5;
  return rea_branch(input);
}

int main(void) { return rea_entry() == 12 ? 0 : 1; }

__attribute__((noinline, used)) int rea_cycle_b(int value);

__attribute__((noinline, used)) int rea_cycle_a(int value) {
  return value > 0 ? rea_cycle_b(value - 1) : value;
}

__attribute__((noinline, used)) int rea_cycle_b(int value) {
  return value > 0 ? rea_cycle_a(value - 1) : value;
}
