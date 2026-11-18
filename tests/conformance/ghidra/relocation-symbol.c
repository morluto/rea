/* Static ELF fixture: no target code is executed by the verifier. */
extern int rea_external(int);
int (*volatile rea_external_slot)(int) = rea_external;
__attribute__((visibility("hidden"), noinline, used)) int rea_local(int value) {
  return value + 1;
}
int (*volatile rea_local_slot)(int) = rea_local;
