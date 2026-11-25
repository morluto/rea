const STORAGE_KEY = "solo-x-web-state-v1";
const TIMER_STORAGE_KEY = "solo-x-timer-v1";

const defaultState = {
  xp: 1280,
  streak: 7,
  focusMinutes: 126,
  sessions: [],
  tasks: [
    { id: "move", title: "Movimente o corpo", detail: "10 minutos de movimento", xp: 30, done: false },
    { id: "plan", title: "Planeje sua sessão", detail: "Defina uma missão para hoje", xp: 20, done: false },
    { id: "water", title: "Recarregue sua energia", detail: "Beba água e faça uma pausa", xp: 15, done: false },
  ],
};

const state = loadState();
let timer = loadTimer();
let selectedDuration = 25;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const formatNumber = (value) => new Intl.NumberFormat("pt-BR").format(value);

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved ? { ...defaultState, ...saved } : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadTimer() {
  const fallback = { seconds: 25 * 60, total: 25 * 60, running: false, interval: null, updatedAt: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(TIMER_STORAGE_KEY));
    if (!saved || !Number.isFinite(saved.seconds) || !Number.isFinite(saved.total)) return fallback;
    const elapsed = saved.running && Number.isFinite(saved.updatedAt)
      ? Math.floor((Date.now() - saved.updatedAt) / 1000)
      : 0;
    return {
      seconds: Math.max(0, Math.min(saved.seconds - elapsed, saved.total)),
      total: Math.max(1, saved.total),
      running: Boolean(saved.running),
      interval: null,
      updatedAt: Date.now(),
    };
  } catch {
    return fallback;
  }
}

function saveTimer() {
  if (!timer.running && timer.seconds === timer.total) {
    localStorage.removeItem(TIMER_STORAGE_KEY);
    return;
  }
  localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify({
    seconds: timer.seconds,
    total: timer.total,
    running: timer.running,
    updatedAt: Date.now(),
  }));
}

function render() {
  $$("[data-xp]").forEach((element) => { element.textContent = formatNumber(state.xp); });
  $$("[data-streak]").forEach((element) => { element.textContent = state.streak; });
  $$("[data-focus-minutes]").forEach((element) => { element.textContent = state.focusMinutes; });
  $$("[data-completed-tasks]").forEach((element) => { element.textContent = 12 + state.tasks.filter((task) => task.done).length; });
  $$("[data-rank-xp]").forEach((element) => { element.textContent = formatNumber(state.xp); });
  $$("[data-rank-remaining]").forEach((element) => { element.textContent = formatNumber(Math.max(0, 1500 - state.xp)); });
  $$("[data-rank-progress]").forEach((element) => { element.style.width = `${Math.min(100, (state.xp / 1500) * 100)}%`; });
  $$("[data-best-streak]").forEach((element) => { element.textContent = `${Math.max(state.streak, 7)} dias`; });
  $$("[data-session-count]").forEach((element) => { element.textContent = state.sessions.length; });
  $$("[data-average-session]").forEach((element) => {
    const total = state.sessions.reduce((sum, session) => sum + session.minutes, 0);
    element.textContent = `${state.sessions.length ? Math.round(total / state.sessions.length) : 0} min`;
  });
  renderTasks();
  renderChart();
  renderTimer();
}

function renderTasks() {
  const taskMarkup = state.tasks.map((task) => `
    <div class="task-row ${task.done ? "is-done" : ""}" data-task-id="${task.id}">
      <button class="task-check" type="button" data-task-toggle="${task.id}" aria-label="${task.done ? "Reabrir" : "Concluir"} ${task.title}">${task.done ? "✓" : ""}</button>
      <span><strong>${task.title}</strong><small>${task.detail}</small></span>
      <span class="task-xp">+${task.xp} XP</span>
    </div>
  `).join("");
  $$("[data-task-list], [data-task-board]").forEach((element) => { element.innerHTML = taskMarkup; });
  $$("[data-task-toggle]").forEach((button) => button.addEventListener("click", () => toggleTask(button.dataset.taskToggle)));
}

function renderChart() {
  const values = [32, 54, 25, 74, 46, 83, Math.min(100, Math.max(12, state.focusMinutes / 2))];
  const labels = ["dom", "seg", "ter", "qua", "qui", "sex", "hoje"];
  const chart = values.map((value, index) => `
    <div class="chart-column ${index === 6 ? "is-today" : ""}">
      <div class="chart-bar" style="height:${value}%"></div>
      <span>${labels[index]}</span>
    </div>
  `).join("");
  $$("[data-activity-chart]").forEach((element) => { element.innerHTML = chart; });
}

function toggleTask(id) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) return;
  task.done = !task.done;
  if (task.done) {
    state.xp += task.xp;
    showToast(`Missão concluída. +${task.xp} XP`);
  } else {
    state.xp = Math.max(0, state.xp - task.xp);
  }
  saveState();
  render();
}

function renderTimer() {
  const minutes = Math.floor(timer.seconds / 60).toString().padStart(2, "0");
  const seconds = (timer.seconds % 60).toString().padStart(2, "0");
  $$("[data-timer-display]").forEach((element) => { element.textContent = `${minutes}:${seconds}`; });
  $$("[data-focus-status]").forEach((element) => {
    element.textContent = timer.running ? "Sessão em andamento" : timer.seconds < timer.total ? "Sessão pausada" : "Escolha uma missão para começar";
  });
  $$('[data-timer-action="pause"]').forEach((button) => {
    button.hidden = !timer.running && timer.seconds === timer.total;
    button.textContent = timer.running ? "Pausar" : "Retomar";
  });
  $$('[data-timer-action="stop"]').forEach((button) => { button.hidden = timer.seconds === timer.total; });
  saveTimer();
}

function openFocusModal() {
  $("[data-focus-modal]").classList.remove("is-hidden");
  $("[data-focus-task]").focus();
}

function closeFocusModal() {
  $("[data-focus-modal]").classList.add("is-hidden");
}

function startFocus() {
  selectedDuration = Number($(".duration-button.is-selected").dataset.duration);
  timer.total = selectedDuration * 60;
  timer.seconds = timer.total;
  timer.running = true;
  closeFocusModal();
  clearInterval(timer.interval);
  timer.interval = setInterval(tickTimer, 1000);
  showToast(`${selectedDuration} minutos protegidos. Bom foco.`);
  renderTimer();
}

function tickTimer() {
  timer.seconds -= 1;
  if (timer.seconds <= 0) completeSession();
  renderTimer();
}

function completeSession() {
  clearInterval(timer.interval);
  timer.running = false;
  const minutes = Math.round(timer.total / 60);
  state.focusMinutes += minutes;
  state.xp += minutes * 10;
  state.sessions.push({ minutes, date: new Date().toISOString() });
  saveState();
  timer.seconds = timer.total;
  render();
  showToast(`Sessão concluída. +${minutes * 10} XP`);
}

function pauseFocus() {
  if (timer.running) {
    timer.running = false;
    clearInterval(timer.interval);
  } else if (timer.seconds < timer.total) {
    timer.running = true;
    timer.interval = setInterval(tickTimer, 1000);
  }
  renderTimer();
}

function stopFocus() {
  clearInterval(timer.interval);
  timer = { seconds: 25 * 60, total: 25 * 60, running: false, interval: null };
  renderTimer();
  showToast("Sessão encerrada sem registrar XP.");
}

function showToast(message) {
  const toast = $("[data-toast]");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function switchScreen(screenName) {
  $$("[data-screen]").forEach((screen) => screen.classList.toggle("is-hidden", screen.dataset.screen !== screenName));
  $$("[data-screen-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.screenTarget === screenName));
  const titles = { dashboard: "Seu painel de foco", tasks: "Missões do operador", insights: "Seu progresso", settings: "Preferências" };
  $("[data-page-title]").textContent = titles[screenName] || titles.dashboard;
}

function resetDemo() {
  if (!window.confirm("Redefinir todo o progresso desta demo?")) return;
  localStorage.removeItem(STORAGE_KEY);
  Object.assign(state, structuredClone(defaultState));
  stopFocus();
  render();
  showToast("Demo redefinida.");
}

$$("[data-screen-target]").forEach((button) => button.addEventListener("click", () => switchScreen(button.dataset.screenTarget)));
$$("[data-open-focus]").forEach((button) => button.addEventListener("click", openFocusModal));
$("[data-close-focus]").addEventListener("click", closeFocusModal);
$("[data-start-focus]").addEventListener("click", startFocus);
$('[data-timer-action="pause"]').addEventListener("click", pauseFocus);
$('[data-timer-action="stop"]').addEventListener("click", stopFocus);
$("[data-reset]").addEventListener("click", resetDemo);
$("[data-focus-modal]").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeFocusModal();
});
$$("[data-duration]").forEach((button) => button.addEventListener("click", () => {
  $$("[data-duration]").forEach((candidate) => candidate.classList.toggle("is-selected", candidate === button));
  selectedDuration = Number(button.dataset.duration);
}));
$$("[data-setting=compact]").forEach((input) => input.addEventListener("change", (event) => {
  document.body.classList.toggle("is-compact", event.target.checked);
}));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeFocusModal();
});

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

if (timer.running) {
  if (timer.seconds <= 0) {
    completeSession();
  } else {
    timer.interval = setInterval(tickTimer, 1000);
  }
}

render();
