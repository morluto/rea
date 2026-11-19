/* Cross-compiled for inspection only; never load or execute these images. */
static void local_ctor(void) {}
void defined_ctor(void) {}
extern void external_ctor(void);
__attribute__((section(".init_array"), used))
void (*constructors[])(void) = {local_ctor, defined_ctor, external_ctor};
__attribute__((section(".fini_array"), used))
void (*finalizers[])(void) = {local_ctor};
