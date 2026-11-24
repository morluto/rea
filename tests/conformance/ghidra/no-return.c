#include <stdlib.h>
#include <string.h>
#include <errno.h>

extern void *__tls_get_addr(void *);
extern int *__errno_location(void);
extern void rea_unknown_stop(void);
extern void _Unwind_Resume(void *) __attribute__((noreturn));
volatile unsigned long rea_after_call;

void *rea_malloc(size_t n) {
    void *p = malloc(n);
    rea_after_call++;
    return p;
}
void *rea_malloc_adjacent(size_t n) {
    void *p = malloc(n);
    rea_after_call++;
    return p;
}
__attribute__((visibility("hidden"))) void *rea_tls(void *p) {
    void *value = __tls_get_addr(p);
    rea_after_call++;
    return value;
}
__attribute__((visibility("hidden"))) void *rea_tls_chain(void *p) {
    void *value = rea_tls(p);
    rea_after_call++;
    return value;
}
void *rea_tls_outer(void *p) {
    void *value = rea_tls_chain(p);
    rea_after_call++;
    return value;
}
void *rea_memcpy(void *out, const void *in, size_t n) {
    void *value = memcpy(out, in, n);
    rea_after_call++;
    return value;
}
void *rea_memset(void *out, int c, size_t n) {
    void *value = memset(out, c, n);
    rea_after_call++;
    return value;
}
size_t rea_strlen(const char *p) {
    size_t value = strlen(p);
    rea_after_call++;
    return value;
}
int *rea_errno(void) {
    int *p = __errno_location();
    rea_after_call++;
    return p;
}
void rea_unknown(void) {
    rea_unknown_stop();
    rea_after_call++;
}
void rea_abort(void) { abort(); }
void rea_unwind(void *p) { _Unwind_Resume(p); }
void rea_local_stop(void) { __builtin_trap(); }
int rea_local_return(void) { return 1658; }

/* Computed calls to a local no-return function; never executed. Inline
 * assembly fixes the target in the instruction stream, as a RISC-V auipc+jalr
 * pair does, so only the probe's injected state tells these callers apart. */
#define REA_TEXT(value) #value
#define REA_STRING(value) REA_TEXT(value)
#define REA_SYMBOL(name) REA_STRING(__USER_LABEL_PREFIX__) #name
/* REA_ADDRESS loads a symbol's address from constants in the instruction stream. */
#if defined(__x86_64__)
#define REA_ADDRESS(reg, name) "leaq " REA_SYMBOL(name) "(%%rip), %%" reg "\n\t"
#define REA_CALL "call *%%rax"
#define REA_CLOBBERS "rax", "rcx", "memory"
/* cmove's p-code is a CBRANCH over the COPY, so the call may use either address. */
#define REA_SELECT "testl %k0, %k0\n\t" REA_ADDRESS("rax", rea_computed_return) \
    REA_ADDRESS("rcx", rea_computed_stop) "cmoveq %%rcx, %%rax\n\t"
#elif defined(__aarch64__)
#if defined(__APPLE__)
#define REA_ADDRESS(reg, name) \
    "adrp " reg ", " REA_SYMBOL(name) "@PAGE\n\tadd " reg ", " reg ", " REA_SYMBOL(name) "@PAGEOFF\n\t"
#else
#define REA_ADDRESS(reg, name) \
    "adrp " reg ", " REA_SYMBOL(name) "\n\tadd " reg ", " reg ", :lo12:" REA_SYMBOL(name) "\n\t"
#endif
#define REA_CALL "blr x16"
#define REA_CLOBBERS "x16", "x17", "x30", "cc", "memory"
#define REA_SELECT "cmp %w0, #0\n\t" REA_ADDRESS("x16", rea_computed_return) \
    REA_ADDRESS("x17", rea_computed_stop) "csel x16, x17, x16, eq\n\t"
#else
#error "no-return.c needs an x86-64 or AArch64 computed call"
#endif
#if defined(__x86_64__)
#define REA_TARGET "rax"
#else
#define REA_TARGET "x16"
#endif
#define REA_CONSTANT_CALL(name) __asm__ volatile(REA_ADDRESS(REA_TARGET, name) REA_CALL ::: REA_CLOBBERS)
#define REA_CONDITIONAL_CALL(code) __asm__ volatile(REA_SELECT REA_CALL :: "r"(code) : REA_CLOBBERS)
__attribute__((visibility("hidden"), noreturn, noinline)) void rea_computed_stop(void) { __builtin_trap(); }
__attribute__((visibility("hidden"), noinline)) void rea_computed_return(void) { rea_after_call++; }
void rea_constant_call(void) {
    REA_CONSTANT_CALL(rea_computed_stop);
    rea_after_call++;
}
void rea_constant_call_two_targets(void) {
    REA_CONSTANT_CALL(rea_computed_stop);
    rea_after_call++;
}
void rea_constant_call_overridden(void) {
    REA_CONSTANT_CALL(rea_computed_stop);
    rea_after_call++;
}
/* A writable slot: its initial value is only one of the targets it can hold. */
static void (*rea_stop_hook)(void) = rea_computed_stop;
void rea_set_stop_hook(void (*hook)(void)) { rea_stop_hook = hook; }
void rea_hook_call(void) {
    rea_stop_hook();
    rea_after_call++;
}
/* Only a zero code selects the no-return address. */
void rea_conditional_call(int code) {
    REA_CONDITIONAL_CALL(code);
    rea_after_call++;
}
