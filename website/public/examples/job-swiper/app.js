const jobs = [
  {
    id: "juniper-product-designer",
    company: "Juniper Health",
    initial: "J",
    title: "Senior Product Designer",
    subtitle: "Make care feel more human.",
    location: "Remote · US",
    type: "Full-time",
    level: "Senior",
    salary: "$145k–$175k",
    match: 96,
    color: "#638c70",
    wash: "#e8efe3",
    artNote: "care, made clearer",
    description:
      "Help a small, thoughtful team make the everyday experience of finding care feel a little less overwhelming.",
  },
  {
    id: "fieldnotes-product-design",
    company: "Fieldnotes",
    initial: "F",
    title: "Product Designer",
    subtitle: "Tools for a more curious world.",
    location: "New York · Hybrid",
    type: "Full-time",
    level: "Mid–senior",
    salary: "$125k–$155k",
    match: 92,
    color: "#b5795c",
    wash: "#f4e7dc",
    artNote: "made for the makers",
    description:
      "Shape approachable research tools with designers, educators, and people building a more curious internet.",
  },
  {
    id: "northstar-design-lead",
    company: "Northstar Studio",
    initial: "N",
    title: "Design Lead",
    subtitle: "Build what comes next.",
    location: "Remote · US",
    type: "Full-time",
    level: "Lead",
    salary: "$160k–$195k",
    match: 89,
    color: "#607c9b",
    wash: "#e7edf3",
    artNote: "a little more possibility",
    description:
      "Bring a close-knit product team together around a clear, welcoming experience for independent creators.",
  },
  {
    id: "commonthread-product-designer",
    company: "Common Thread",
    initial: "C",
    title: "Product Designer, Growth",
    subtitle: "Better work, together.",
    location: "Remote · North America",
    type: "Full-time",
    level: "Mid-level",
    salary: "$118k–$148k",
    match: 87,
    color: "#a38654",
    wash: "#f2ecd9",
    artNote: "small steps, shared",
    description:
      "Find the small moments that help independent teams build a calmer, more sustainable way to work.",
  },
  {
    id: "morrow-design-systems",
    company: "Morrow",
    initial: "M",
    title: "Design Systems Designer",
    subtitle: "A clearer canvas for everyone.",
    location: "Chicago · Hybrid",
    type: "Full-time",
    level: "Senior",
    salary: "$135k–$165k",
    match: 84,
    color: "#90749a",
    wash: "#eee8f0",
    artNote: "consistency with character",
    description:
      "Make a growing design system useful, expressive, and genuinely shared across a warm product organization.",
  },
];

const storageKey = "goodwork-job-swiper-v1";
const stage = document.querySelector("#job-stage");
const statusMessage = document.querySelector("#status-message");
const sectionEyebrow = document.querySelector("#section-eyebrow");
const pageTitle = document.querySelector("#page-title");
const pageCopy = document.querySelector("#page-copy");
const deckTopline = document.querySelector("#deck-topline");
const swipeActions = document.querySelector("#swipe-actions");
const keyboardHint = document.querySelector("#keyboard-hint");
const undoButton = document.querySelector("#undo-button");
const infoDialog = document.querySelector("#info-dialog");
let activeView = "discover";
let actionHistory = [];

function readState() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    const validIds = new Set(jobs.map((job) => job.id));
    const validList = (value) =>
      Array.isArray(value) ? [...new Set(value.filter((id) => validIds.has(id)))] : [];
    return {
      saved: validList(stored.saved),
      applied: validList(stored.applied),
      passed: validList(stored.passed),
    };
  } catch {
    statusMessage.textContent = "Your browser couldn't load saved roles. You can still explore sample jobs.";
    return { saved: [], applied: [], passed: [] };
  }
}

let state = readState();

function persistState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    statusMessage.textContent = "Changes are temporary because this browser couldn't save local data.";
  }
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function currentJobs() {
  if (activeView === "saved") return jobs.filter((job) => state.saved.includes(job.id));
  if (activeView === "applied") return jobs.filter((job) => state.applied.includes(job.id));
  return jobs.filter(
    (job) =>
      !state.saved.includes(job.id) &&
      !state.applied.includes(job.id) &&
      !state.passed.includes(job.id),
  );
}

function updateCounts() {
  document.querySelector("#discover-count").textContent = currentCount();
  document.querySelector("#saved-count").textContent = state.saved.length;
  document.querySelector("#applied-count").textContent = state.applied.length;
}

function currentCount() {
  return jobs.filter(
    (job) =>
      !state.saved.includes(job.id) &&
      !state.applied.includes(job.id) &&
      !state.passed.includes(job.id),
  ).length;
}

function renderJob(job, index, total) {
  stage.classList.add("has-job-card");
  stage.innerHTML = `
    <article class="job-card" data-job-card style="--job-color:${job.color};--job-wash:${job.wash}">
      <div class="job-art">
        <span class="art-note">${job.artNote}</span>
        <span class="art-blob"></span>
        <span class="company-monogram" aria-hidden="true">${job.initial}</span>
        <span class="match-pill"><span aria-hidden="true">✳</span> ${job.match}% match</span>
      </div>
      <div class="job-details">
        <div class="company-line">${job.company}<span class="sample-badge">SAMPLE</span></div>
        <h2 class="job-title">${job.title}</h2>
        <p class="job-subtitle">${job.subtitle}</p>
        <div class="job-meta">
          <span class="meta-chip">${job.location}</span>
          <span class="meta-chip">${job.type}</span>
          <span class="meta-chip">${job.level}</span>
        </div>
        <p class="job-description">${job.description}</p>
        <div class="job-card-footer">
          <span class="salary-label">ESTIMATED BASE SALARY<strong>${job.salary}</strong></span>
          <button class="detail-link" type="button" data-details="${job.id}">Why this match <span aria-hidden="true">→</span></button>
        </div>
      </div>
    </article>`;
  document.querySelector("#match-position").innerHTML =
    `${String(index + 1).padStart(2, "0")} <i>/</i> ${String(total).padStart(2, "0")}`;
  stage.querySelector("[data-details]").addEventListener("click", () => {
    document.querySelector("#dialog-title").textContent = "Why this could fit";
    document.querySelector("#dialog-copy").textContent =
      `${job.company} is a sample company. This illustrative match is based on your stated interest in product and design, remote-friendly work, and a $110k+ salary range.`;
    infoDialog.showModal();
  });
  attachSwipe(stage.querySelector("[data-job-card]"));
}

function renderTracked(list) {
  stage.classList.remove("has-job-card");
  const isSaved = activeView === "saved";
  const title = isSaved ? "Your saved roles" : "Your application list";
  const count = list.length;
  const cards = list
    .map(
      (job) => `
        <article class="tracked-card" style="--job-color:${job.color};--job-wash:${job.wash}">
          <span class="tracked-logo" aria-hidden="true">${job.initial}</span>
          <div class="tracked-details">
            <strong>${job.title}</strong>
            <span>${job.company} · ${job.location}</span>
          </div>
          <div class="tracked-actions">
            ${
              isSaved
                ? `<button class="tracked-action" type="button" data-mark-applied="${job.id}">Mark applied</button>`
                : `<button class="tracked-action" type="button" data-move-saved="${job.id}">Move to saved</button>`
            }
            <button class="tracked-action is-muted" type="button" data-remove="${job.id}">${isSaved ? "Remove" : "Undo"}</button>
          </div>
        </article>`,
    )
    .join("");
  stage.innerHTML = `
    <div class="tracked-heading"><span>${title}</span><span>${count} ${count === 1 ? "role" : "roles"}</span></div>
    ${
      count
        ? `<div class="tracked-list">${cards}</div>`
        : `<div class="empty-state">
            <span class="empty-illustration" aria-hidden="true">${isSaved ? "♡" : "✳"}</span>
            <h2>${isSaved ? "Your shortlist starts here." : "One step at a time."}</h2>
            <p>${isSaved ? "Save a role that feels promising and it will be waiting here." : "When you apply to a saved role, mark it here to keep your search organized."}</p>
            <button type="button" data-go-discover>Explore roles</button>
          </div>`
    }`;
  stage.querySelectorAll("[data-mark-applied]").forEach((button) => {
    button.addEventListener("click", () => trackApplied(button.dataset.markApplied));
  });
  stage.querySelectorAll("[data-move-saved]").forEach((button) => {
    button.addEventListener("click", () => moveToSaved(button.dataset.moveSaved));
  });
  stage.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => removeTracked(button.dataset.remove));
  });
  stage.querySelector("[data-go-discover]")?.addEventListener("click", () => setView("discover"));
}

function render() {
  updateCounts();
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === activeView;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  const list = currentJobs();
  const isDiscover = activeView === "discover";
  const label = activeView === "saved" ? "SAVED FOR LATER" : "APPLICATION TRACKER";
  sectionEyebrow.textContent = isDiscover ? "CURATED FOR YOU" : label;
  pageTitle.innerHTML = isDiscover
    ? 'Find your next <span>good thing.</span>'
    : activeView === "saved"
      ? 'A few maybes, <span>made yours.</span>'
      : 'Your search, <span>in motion.</span>';
  pageCopy.textContent = isDiscover
    ? "Thoughtful matches, one role at a time."
    : activeView === "saved"
      ? "Keep the roles that feel worth a closer look."
      : "A calm little place to keep track of your next steps.";
  deckTopline.hidden = !isDiscover;
  swipeActions.hidden = !isDiscover || list.length === 0;
  keyboardHint.hidden = !isDiscover || list.length === 0;
  document.querySelector("#filter-button").hidden = !isDiscover;

  if (isDiscover && list.length) {
    renderJob(list[0], jobs.length - list.length, jobs.length);
  } else if (isDiscover) {
    stage.classList.remove("has-job-card");
    stage.innerHTML = `
      <div class="empty-state">
        <span class="empty-illustration" aria-hidden="true">✦</span>
        <h2>That's your last match for now.</h2>
        <p>You've made it through this sample set. Your saved and applied roles are still here whenever you need them.</p>
        <button type="button" data-reset-passes>Bring passed roles back</button>
      </div>`;
    stage.querySelector("[data-reset-passes]").addEventListener("click", () => {
      state.passed = [];
      persistState();
      setStatus("Passed roles are back in your discovery deck.");
      render();
    });
  } else {
    renderTracked(list);
  }

  undoButton.disabled = actionHistory.length === 0;
}

function moveJob(id, from, to, message) {
  if (!jobs.some((job) => job.id === id)) return;
  if (from) state[from] = state[from].filter((jobId) => jobId !== id);
  if (to && !state[to].includes(id)) state[to].push(id);
  actionHistory.push({ id, from, to });
  persistState();
  setStatus(message);
  render();
}

function saveJob(id) {
  moveJob(id, null, "saved", "Saved for later. You can find it in your shortlist.");
}

function passJob(id) {
  moveJob(id, null, "passed", "Passed for now. You can bring passed roles back when you finish the deck.");
}

function trackApplied(id) {
  if (!state.saved.includes(id)) return;
  moveJob(id, "saved", "applied", "Marked as applied. Good luck with this next step.");
}

function moveToSaved(id) {
  if (!state.applied.includes(id)) return;
  moveJob(id, "applied", "saved", "Moved back to your saved roles.");
}

function removeTracked(id) {
  const from = activeView === "saved" ? "saved" : "applied";
  if (!state[from].includes(id)) return;
  state[from] = state[from].filter((jobId) => jobId !== id);
  actionHistory.push({ id, from, to: null });
  persistState();
  setStatus("Removed from your list.");
  render();
}

function undoLastAction() {
  const action = actionHistory.pop();
  if (!action) return;
  if (action.to) {
    state[action.to] = state[action.to].filter((jobId) => jobId !== action.id);
  }
  if (action.from && !state[action.from].includes(action.id)) {
    state[action.from].push(action.id);
  }
  persistState();
  setStatus("Last change undone.");
  render();
}

function chooseCurrent(action) {
  const job = currentJobs()[0];
  if (!job || activeView !== "discover") return;
  const card = stage.querySelector("[data-job-card]");
  if (!card) return;
  card.classList.add(action === "save" ? "is-leaving-right" : "is-leaving-left");
  window.setTimeout(() => {
    if (action === "save") saveJob(job.id);
    else passJob(job.id);
  }, 170);
}

function attachSwipe(card) {
  let startX = null;
  let startY = null;
  card.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    startX = event.clientX;
    startY = event.clientY;
    card.setPointerCapture(event.pointerId);
  });
  card.addEventListener("pointerup", (event) => {
    if (startX === null || startY === null) return;
    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    startX = null;
    startY = null;
    if (Math.abs(deltaX) < 85 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    chooseCurrent(deltaX > 0 ? "save" : "pass");
  });
  card.addEventListener("pointercancel", () => {
    startX = null;
    startY = null;
  });
}

function setView(view) {
  activeView = view;
  setStatus("");
  render();
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
document.querySelector("#pass-button").addEventListener("click", () => chooseCurrent("pass"));
document.querySelector("#save-button").addEventListener("click", () => chooseCurrent("save"));
undoButton.addEventListener("click", undoLastAction);
document.querySelector("#filter-button").addEventListener("click", () => {
  document.querySelector("#dialog-title").textContent = "Your preferences";
  document.querySelector("#dialog-copy").textContent =
    "You're looking for product and design roles, remote-friendly teams, and an estimated base salary of $110k or more. This demo uses sample roles and doesn't connect to a live job feed.";
  infoDialog.showModal();
});
document.querySelector("#edit-preferences").addEventListener("click", () => {
  document.querySelector("#filter-button").click();
});
document.querySelector("#portfolio-tip").addEventListener("click", () => {
  document.querySelector("#dialog-title").textContent = "A little profile tip";
  document.querySelector("#dialog-copy").textContent =
    "A portfolio link gives hiring teams a quick way to see how you think and what you make. Add one to your profile when you're ready.";
  infoDialog.showModal();
});
document.querySelector("#dialog-close").addEventListener("click", () => infoDialog.close());
document.querySelector("#dialog-done").addEventListener("click", () => infoDialog.close());
infoDialog.addEventListener("click", (event) => {
  if (event.target === infoDialog) infoDialog.close();
});
document.addEventListener("keydown", (event) => {
  if (infoDialog.open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    chooseCurrent("pass");
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    chooseCurrent("save");
  }
});

render();
