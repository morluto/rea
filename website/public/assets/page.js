function createElement(tag, className, attributes) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attributes) {
    Object.entries(attributes).forEach(([key, value]) => {
      node.setAttribute(key, value);
    });
  }
  return node;
}

function initializeScrollProgress() {
  const bar = createElement("div", "scroll-progress", {
    "aria-hidden": "true",
  });
  document.body.appendChild(bar);

  let ticking = false;
  const update = () => {
    ticking = false;
    const root = document.documentElement;
    const max = root.scrollHeight - root.clientHeight;
    const ratio = max > 0 ? window.scrollY / max : 0;
    const progress = Math.min(1, Math.max(0, ratio));
    bar.style.transform = `scaleX(${progress})`;
  };
  const schedule = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  update();
}

function createToast() {
  const toast = createElement("div", "toast", {
    role: "status",
    "aria-live": "polite",
  });
  document.body.appendChild(toast);
  let timer;
  return (message) => {
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 1800);
  };
}

function initializeSectionEnhancements(t) {
  const sections = Array.from(
    document.querySelectorAll(".article-section[id]"),
  );
  const headings = sections
    .map((section) => {
      const heading = section.querySelector("h2");
      if (heading === null) return null;
      return { section, heading, text: heading.textContent.trim() };
    })
    .filter(Boolean);

  const announce = createToast();
  headings.forEach(({ section, heading, text }) => {
    const button = createElement("button", "anchor-btn", {
      type: "button",
      "aria-label": t("Copy link to section: {heading}", { heading: text }),
    });
    button.textContent = "#";
    button.addEventListener("click", () => {
      const base = `${window.location.origin}${window.location.pathname}`;
      const url = `${base}${window.location.search}#${section.id}`;
      window.history.replaceState(null, "", `#${section.id}`);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          () => announce(t("Link copied")),
          () => announce(t("Link added to address bar")),
        );
      } else {
        announce(t("Link added to address bar"));
      }
    });
    heading.appendChild(button);
  });

  const main = document.getElementById("main");
  const article = document.querySelector(".article");
  if (
    main === null ||
    article === null ||
    main.querySelector(".contents") !== null ||
    headings.length < 3
  ) {
    return;
  }

  const tocLabel = t("On this page");
  const nav = createElement("nav", "toc", { "aria-label": tocLabel });
  const title = createElement("p");
  title.textContent = tocLabel;
  const list = createElement("ol");
  const links = new Map();

  headings.forEach(({ section, text }) => {
    const item = createElement("li");
    const link = createElement("a", "", { href: `#${section.id}` });
    link.textContent = text;
    item.appendChild(link);
    list.appendChild(item);
    links.set(section.id, link);
  });

  nav.appendChild(title);
  nav.appendChild(list);
  main.classList.add("has-toc");
  article.after(nav);

  const entries = headings.map(({ section }) => ({
    section,
    link: links.get(section.id),
  }));
  let scheduled = false;
  const updateCurrent = () => {
    scheduled = false;
    const offset = Math.max(88, Math.round(window.innerHeight * 0.2));
    let current = entries[0];
    entries.forEach((entry) => {
      if (entry.section.getBoundingClientRect().top <= offset) {
        current = entry;
      }
    });
    if (
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 2
    ) {
      const selected = entries.find(
        (entry) => entry.link.hash === window.location.hash,
      );
      const selectedTop = selected?.section.getBoundingClientRect().top;
      current =
        selectedTop !== undefined &&
        selectedTop >= 0 &&
        selectedTop < window.innerHeight
          ? selected
          : entries[entries.length - 1];
    }
    entries.forEach(({ link }) => {
      if (link === current.link) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };
  const scheduleUpdate = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(updateCurrent);
  };
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate, { passive: true });
  window.addEventListener("hashchange", scheduleUpdate);
  updateCurrent();
}

async function initializePageEnhancements() {
  const { t } = await import("./i18n.js");
  initializeScrollProgress();
  initializeSectionEnhancements(t);
}

initializePageEnhancements().catch((cause) => {
  console.error("Page enhancements failed", cause);
});
