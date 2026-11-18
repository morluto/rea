/* Source-owned Linux ELF fixture for the Ghidra loader-relocation boundary. */
typedef unsigned int rea_loader_word;

/* This file-backed value is the constant the unprotected decompiler may fold. */
__attribute__((used, visibility("default")))
const rea_loader_word rea_loader_value = 0x11111111u;

#if defined(__ELF__)
#define REA_LOADER_POINTER_SECTION ".data.rel.ro"
#elif defined(__APPLE__)
#define REA_LOADER_POINTER_SECTION "__DATA_CONST,__const"
#else
#error "The loader-relocation fixture requires an ELF or Mach-O compiler"
#endif

/* The loader fills this pointer before its RELRO block is sealed read-only. */
__attribute__((used, visibility("default"), section(REA_LOADER_POINTER_SECTION)))
const rea_loader_word *volatile const rea_loader_pointer = &rea_loader_value;

/* A const object defined by the provider. In a PIE, GCC and the linker copy
 * it into RELRO with a copy relocation that Ghidra cannot apply, so the file
 * holds zero where the loader writes the provider's value: the #4177 shape. */
extern const rea_loader_word rea_external_const;

__attribute__((noinline, used, visibility("default")))
rea_loader_word rea_loader_reader(void) {
  return rea_external_const;
}

__attribute__((noinline, used, visibility("default")))
void rea_loader_writer(void) {
  *(volatile rea_loader_word *)(void *)&rea_external_const = 0;
}

/* An applied relocation in the same RELRO segment; it is not protected. */
__attribute__((noinline, used, visibility("default")))
rea_loader_word rea_loader_pointer_reader(void) {
  return *rea_loader_pointer;
}

extern rea_loader_word rea_external(int value);
/* Weak so -fPIE code reads it through a RELRO GOT entry. A strong reference
 * lets GCC use a copy relocation into writable .bss instead. */
extern rea_loader_word rea_external_value __attribute__((weak));

__attribute__((noinline, used, visibility("default")))
rea_loader_word rea_loader_got_caller(rea_loader_word value) {
  return rea_external((int)value) + rea_external_value;
}

__attribute__((used, visibility("default"))) void rea_loader_start(void) {
  volatile rea_loader_word result = rea_loader_reader();
  (void)result;
  for (;;) {
  }
}

#undef REA_LOADER_POINTER_SECTION
