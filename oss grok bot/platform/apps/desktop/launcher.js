const primary = document.querySelector('#primary'),
  form = document.querySelector('#connect'),
  error = document.querySelector('#error');
async function run(fn) {
  error.textContent = '';
  primary.disabled = true;
  form.querySelector('button').disabled = true;
  try {
    await fn();
  } catch (e) {
    error.textContent = e.message;
  } finally {
    primary.disabled = false;
    form.querySelector('button').disabled = false;
  }
}
primary.onclick = () => run(() => window.workshopDesktop.startPrimary());
form.onsubmit = (event) => {
  event.preventDefault();
  void run(() =>
    window.workshopDesktop.connectPrimary(document.querySelector('#host').value.trim()),
  );
};
