import { t } from "./i18n.js";

// Draws the last 30 days of npm downloads under the hero command. The block
// stays hidden unless the registry answers, so the page never shows a stale count.
async function initializeDownloads() {
  const block = document.querySelector("[data-downloads]");
  if (block === null) return;
  const chart = block.querySelector("[data-downloads-chart]");
  const total = block.querySelector("[data-downloads-total]");

  try {
    const response = await fetch(
      "https://api.npmjs.org/downloads/range/last-month/rea-agents",
      { credentials: "omit", signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) return;
    const { downloads } = await response.json();
    if (!Array.isArray(downloads) || downloads.length === 0) return;
    const days = downloads
      .slice(-30)
      .map((day) => (Number.isSafeInteger(day.downloads) ? day.downloads : 0));
    const sum = days.reduce((a, b) => a + b, 0);
    if (sum === 0) return;

    const peak = Math.max(...days);
    const svg = "http://www.w3.org/2000/svg";
    chart.setAttribute("viewBox", `0 0 ${days.length * 4 - 1} 28`);
    chart.setAttribute("width", String(days.length * 4 - 1));
    days.forEach((count, index) => {
      const bar = document.createElementNS(svg, "rect");
      const height = count === 0 ? 1 : Math.max(1.5, (count / peak) * 28);
      bar.setAttribute("x", String(index * 4));
      bar.setAttribute("y", String(28 - height));
      bar.setAttribute("width", "3");
      bar.setAttribute("height", String(height));
      if (count === 0) bar.setAttribute("class", "is-empty");
      else bar.setAttribute("rx", "0.5");
      chart.append(bar);
    });

    const formatted = new Intl.NumberFormat(document.documentElement.lang, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(sum);
    total.textContent = t("{count} downloads", { count: formatted });
    block.hidden = false;
  } catch {
    // Leave the block hidden when the registry is unavailable.
  }
}

initializeDownloads();
