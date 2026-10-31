// Shared public UI workflow. It deliberately does not dismiss an existing modal
// or bypass a covered control: callers must establish the expected start state.
export async function openSettings(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
}
