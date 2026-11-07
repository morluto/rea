#include <pspkernel.h>

PSP_MODULE_INFO("rea_psp_indirect", 0, 1, 0);

/* These probes are never executed; they are source-owned static fixtures. */
unsigned int rea_psp_computed_dispatch(unsigned int selector, unsigned int base);
unsigned int rea_psp_indirect_tail(unsigned int destination);
unsigned int rea_psp_return_control(void);
unsigned int rea_psp_direct_control(void);

volatile unsigned int rea_psp_control_selector = 0;

int main(void) {
  unsigned int selector = rea_psp_control_selector;
  if (selector == 1u) return (int)rea_psp_computed_dispatch(selector, 0u);
  if (selector == 2u) return (int)rea_psp_indirect_tail(selector);
  return (int)(rea_psp_return_control() + rea_psp_direct_control());
}
