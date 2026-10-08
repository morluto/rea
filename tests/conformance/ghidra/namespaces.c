// Emit C++ ABI names with the host C compiler; no C++ runtime is required.
#if defined(__APPLE__)
#define REA_CPP_SYMBOL(name) "_" name
#else
#define REA_CPP_SYMBOL(name) name
#endif

__attribute__((noinline, used)) int rea_namespace_alpha(int value)
    __asm__(REA_CPP_SYMBOL("_ZN5alpha4sameEi"));
__attribute__((noinline, used)) int rea_namespace_beta(int value)
    __asm__(REA_CPP_SYMBOL("_ZN4beta4sameEi"));
__attribute__((noinline, used)) int rea_namespace_nested(int value)
    __asm__(REA_CPP_SYMBOL("_ZN5outer5inner4sameEi"));

int rea_namespace_alpha(int value) { return value + 3; }
int rea_namespace_beta(int value) { return value * 2; }
int rea_namespace_nested(int value) { return value - 1; }

int main(void) {
  return rea_namespace_alpha(1) + rea_namespace_beta(2) +
         rea_namespace_nested(3);
}
