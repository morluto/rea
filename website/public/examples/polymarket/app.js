const markets = [
  {
    id: "fed-december-cut",
    category: "Economics",
    icon: "↗",
    color: "#527bdc",
    wash: "#edf1ff",
    question: "Will the Fed cut interest rates in December?",
    yes: 68,
    volume: 482600,
    close: "Dec 10",
    group: "Trending",
    updated: 1,
  },
  {
    id: "bitcoin-100k",
    category: "Crypto",
    icon: "₿",
    color: "#bc8a39",
    wash: "#fbf3e5",
    question: "Will Bitcoin reach $100,000 this month?",
    yes: 42,
    volume: 371200,
    close: "Nov 30",
    group: "Trending",
    updated: 3,
  },
  {
    id: "us-shutdown",
    category: "Politics",
    icon: "⌂",
    color: "#735fbd",
    wash: "#f1edfc",
    question: "Will the US government avoid a shutdown this year?",
    yes: 81,
    volume: 294800,
    close: "Dec 31",
    group: "Trending",
    updated: 2,
  },
  {
    id: "global-temp-record",
    category: "Climate",
    icon: "☼",
    color: "#328d77",
    wash: "#e9f6f1",
    question: "Will 2026 be the hottest year on record?",
    yes: 57,
    volume: 192500,
    close: "Dec 31",
    group: "New",
    updated: 5,
  },
  {
    id: "mars-sample-return",
    category: "Science",
    icon: "✳",
    color: "#d16d60",
    wash: "#fff0ed",
    question: "Will a crewed Mars mission launch before 2030?",
    yes: 12,
    volume: 127400,
    close: "Jan 01, 2030",
    group: "New",
    updated: 4,
  },
  {
    id: "inflation-below-3",
    category: "Economics",
    icon: "↗",
    color: "#5c8b6d",
    wash: "#edf5ee",
    question: "Will US inflation fall below 3% by year-end?",
    yes: 73,
    volume: 110900,
    close: "Dec 31",
    group: "Ending soon",
    updated: 6,
  },
  {
    id: "ethereum-upgrade",
    category: "Crypto",
    icon: "◆",
    color: "#6470bd",
    wash: "#eff0fc",
    question: "Will Ethereum set a new all-time high this year?",
    yes: 29,
    volume: 85400,
    close: "Dec 31",
    group: "Ending soon",
    updated: 7,
  },
];

const storageKey = "forecast-market-demo-v1";
const defaultState = () => ({
  balanceCents: 100000,
  watchlist: [],
  positions: {},
  activity: [],
});

const searchInput = document.querySelector("#market-search");
const marketList = document.querySelector("#market-list");
const tradeStatus = document.querySelector("#trade-status");
const amountInput = document.querySelector("#trade-amount");
let category = "All";
let filter = "Trending";
let sort = "volume";
let selectedMarketId = markets[0].id;
let selectedOutcome = "yes";
let activePage = "markets";

function isValidState(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger(value.balanceCents) &&
    value.balanceCents >= 0 &&
    Array.isArray(value.watchlist) &&
    value.positions !== null &&
    typeof value.positions === "object" &&
    Array.isArray(value.activity)
  );
}

function readState() {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!isValidState(parsed)) throw new Error("Stored demo data has an unexpected shape.");
    const marketIds = new Set(markets.map((market) => market.id));
    parsed.watchlist = [...new Set(parsed.watchlist.filter((id) => marketIds.has(id)))];
    parsed.activity = parsed.activity.slice(0, 30).filter(
      (item) =>
        item &&
        typeof item.marketId === "string" &&
        marketIds.has(item.marketId) &&
        typeof item.text === "string" &&
        typeof item.time === "string",
    );
    for (const [key, position] of Object.entries(parsed.positions)) {
      const [marketId, outcome] = key.split(":");
      if (
        !marketIds.has(marketId) ||
        !["yes", "no"].includes(outcome) ||
        !position ||
        !Number.isFinite(position.shares) ||
        position.shares <= 0 ||
        !Number.isSafeInteger(position.costCents) ||
        position.costCents < 0
      ) {
        delete parsed.positions[key];
      }
    }
    return parsed;
  } catch {
    tradeStatus.textContent = "Could not read saved demo data. A fresh paper balance is available.";
    return defaultState();
  }
}

let state = readState();

function saveState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    tradeStatus.textContent = "Browser storage is unavailable; this demo session may not persist.";
  }
}

function money(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function compactMoney(value) {
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}m`;
  if (value >= 1000) return `$${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return `$${value}`;
}

function selectedMarket() {
  return markets.find((market) => market.id === selectedMarketId) ?? markets[0];
}

function outcomePrice(market, outcome) {
  return outcome === "yes" ? market.yes : 100 - market.yes;
}

function visibleMarkets() {
  const query = searchInput.value.trim().toLowerCase();
  let visible = markets.filter((market) => {
    const matchesCategory = category === "All" || market.category === category;
    const matchesFilter = market.group === filter;
    const matchesQuery =
      !query ||
      `${market.question} ${market.category}`.toLowerCase().includes(query);
    return matchesCategory && matchesFilter && matchesQuery;
  });
  if (sort === "probability") {
    visible = [...visible].sort((a, b) => b.yes - a.yes);
  } else if (sort === "newest") {
    visible = [...visible].sort((a, b) => a.updated - b.updated);
  } else {
    visible = [...visible].sort((a, b) => b.volume - a.volume);
  }
  return visible;
}

function createMarketRow(market) {
  const row = document.createElement("article");
  row.className = "market-row";
  row.innerHTML = `
    <button class="market-row-main" type="button" data-select-market="${market.id}" aria-label="View ${market.question}">
      <span class="market-token" style="--token-bg:${market.wash};--token-color:${market.color}" aria-hidden="true">${market.icon}</span>
      <span class="market-text">
        <span class="market-question">${market.question}</span>
        <span class="market-meta"><span>${market.category}</span><span>${compactMoney(market.volume)} volume</span><span>Ends ${market.close}</span></span>
      </span>
    </button>
    <div class="market-probability"><strong>${market.yes}%</strong><span>YES chance</span></div>
    <div class="market-outcomes" aria-label="Choose an outcome">
      <button class="small-outcome small-yes" type="button" data-quick-trade="${market.id}:yes">Yes ${market.yes}¢</button>
      <button class="small-outcome small-no" type="button" data-quick-trade="${market.id}:no">No ${100 - market.yes}¢</button>
    </div>
    <button class="watch-button ${state.watchlist.includes(market.id) ? "is-watched" : ""}" type="button" data-watch="${market.id}" aria-label="${state.watchlist.includes(market.id) ? "Remove from" : "Add to"} watchlist" aria-pressed="${state.watchlist.includes(market.id)}">${state.watchlist.includes(market.id) ? "★" : "☆"}</button>`;

  row.querySelector("[data-select-market]").addEventListener("click", () => {
    selectedMarketId = market.id;
    selectedOutcome = "yes";
    renderTradePanel();
    tradeStatus.textContent = "Market selected. Choose a paper-trade outcome.";
  });
  row.querySelectorAll("[data-quick-trade]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMarketId = market.id;
      selectedOutcome = button.dataset.quickTrade.endsWith(":no") ? "no" : "yes";
      renderTradePanel();
      tradeStatus.textContent = `${selectedOutcome === "yes" ? "Yes" : "No"} selected for paper trading.`;
      document.querySelector(".trade-sidebar").scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  });
  row.querySelector("[data-watch]").addEventListener("click", () => toggleWatch(market.id));
  return row;
}

function renderMarkets() {
  const visible = visibleMarkets();
  marketList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "no-results";
    empty.textContent = "No sample markets match. Try a different category or search.";
    marketList.append(empty);
  } else {
    visible.forEach((market) => marketList.append(createMarketRow(market)));
  }
  document.querySelector("#market-list-heading").textContent =
    category === "All" ? "Markets to watch" : `${category} markets`;
  document.querySelector("#market-list-subtitle").textContent =
    visible.length === markets.length
      ? "A few questions on everyone's mind."
      : `${visible.length} sample ${visible.length === 1 ? "market" : "markets"} in this view.`;
  renderWatchlist();
}

function renderWatchlist() {
  const container = document.querySelector("#watchlist-mini");
  const watched = markets.filter((market) => state.watchlist.includes(market.id));
  document.querySelector("#watchlist-count").textContent = watched.length;
  container.replaceChildren();
  if (!watched.length) {
    const empty = document.createElement("p");
    empty.textContent = "Save a market to keep it close.";
    container.append(empty);
    return;
  }
  watched.forEach((market) => {
    const button = document.createElement("button");
    button.className = "watchlist-item";
    button.type = "button";
    button.innerHTML = `<span class="watchlist-dot" style="background:${market.color}"></span><span>${market.question}</span>`;
    button.addEventListener("click", () => {
      selectMarket(market.id, "yes");
      setPage("markets");
    });
    container.append(button);
  });
}

function renderTradePanel() {
  const market = selectedMarket();
  const yesPrice = outcomePrice(market, "yes");
  const noPrice = outcomePrice(market, "no");
  const price = outcomePrice(market, selectedOutcome);
  document.querySelector("#trade-category").textContent =
    `${market.category.toUpperCase()} · ENDS ${market.close.toUpperCase()}`;
  document.querySelector("#trade-question").textContent = market.question;
  document.querySelector("#trade-market .trade-market-icon").textContent = market.icon;
  document.querySelector("#trade-market .trade-market-icon").style.background = market.wash;
  document.querySelector("#trade-market .trade-market-icon").style.color = market.color;
  document.querySelector("#yes-price").textContent = `${yesPrice}¢`;
  document.querySelector("#no-price").textContent = `${noPrice}¢`;
  document.querySelectorAll("[data-outcome]").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.outcome === selectedOutcome);
  });
  document.querySelector("#selected-price").textContent = `${price}¢`;
  document.querySelector("#price-percent").textContent = `${price}% chance`;
  document.querySelector("#trade-submit").textContent =
    `Buy ${selectedOutcome === "yes" ? "Yes" : "No"} · ${money(amountInCents())}`;
  const dollars = amountInCents();
  const shares = price > 0 ? dollars / price : 0;
  document.querySelector("#estimate-shares").textContent = shares.toFixed(2);
  document.querySelector("#estimate-payout").textContent = money(Math.round(shares * 100));
  document.querySelector("#trade-balance").textContent = money(state.balanceCents);
  document.querySelector("#header-balance").textContent = money(state.balanceCents);
  updateTradeButton();
}

function amountInCents() {
  const amount = Number(amountInput.value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function updateTradeButton() {
  const amount = amountInCents();
  const submit = document.querySelector("#trade-submit");
  const invalid = amount < 100 || amount > state.balanceCents;
  submit.disabled = invalid;
  submit.textContent =
    amount > state.balanceCents
      ? "Insufficient paper balance"
      : `Buy ${selectedOutcome === "yes" ? "Yes" : "No"} · ${money(amount)}`;
}

function toggleWatch(id) {
  if (state.watchlist.includes(id)) {
    state.watchlist = state.watchlist.filter((marketId) => marketId !== id);
    tradeStatus.textContent = "Removed from your watchlist.";
  } else {
    state.watchlist.push(id);
    tradeStatus.textContent = "Added to your watchlist.";
  }
  saveState();
  renderMarkets();
}

function selectMarket(id, outcome) {
  selectedMarketId = id;
  selectedOutcome = outcome;
  renderTradePanel();
  tradeStatus.textContent = `${outcome === "yes" ? "Yes" : "No"} selected for paper trading.`;
}

function addActivity(marketId, text) {
  state.activity.unshift({
    marketId,
    text,
    time: new Date().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  });
  state.activity = state.activity.slice(0, 12);
}

function buyPaperPosition() {
  const amount = amountInCents();
  if (amount < 100) {
    tradeStatus.textContent = "Enter at least $1 to make a paper trade.";
    return;
  }
  if (amount > state.balanceCents) {
    tradeStatus.textContent = "That is more than your available paper balance.";
    return;
  }
  const market = selectedMarket();
  const price = outcomePrice(market, selectedOutcome);
  if (price <= 0) {
    tradeStatus.textContent = "This sample price cannot be used for a paper trade.";
    return;
  }
  const key = `${market.id}:${selectedOutcome}`;
  const shares = amount / price;
  const existing = state.positions[key] ?? { shares: 0, costCents: 0 };
  state.positions[key] = {
    shares: existing.shares + shares,
    costCents: existing.costCents + amount,
  };
  state.balanceCents -= amount;
  addActivity(
    market.id,
    `Bought ${shares.toFixed(2)} ${selectedOutcome.toUpperCase()} shares · ${money(amount)}`,
  );
  saveState();
  renderTradePanel();
  tradeStatus.textContent = `Paper trade placed: ${shares.toFixed(2)} ${selectedOutcome.toUpperCase()} shares.`;
  renderPortfolio();
}

function sellPosition(key) {
  const position = state.positions[key];
  if (!position) return;
  const [marketId, outcome] = key.split(":");
  const market = markets.find((item) => item.id === marketId);
  if (!market) return;
  const price = outcomePrice(market, outcome);
  const proceeds = Math.round(position.shares * price);
  state.balanceCents += proceeds;
  delete state.positions[key];
  addActivity(
    marketId,
    `Closed ${position.shares.toFixed(2)} ${outcome.toUpperCase()} shares · ${money(proceeds)} paper proceeds`,
  );
  saveState();
  renderPortfolio();
  renderTradePanel();
}

function renderPortfolio() {
  const positions = Object.entries(state.positions);
  document.querySelector("#portfolio-balance").textContent = money(state.balanceCents);
  document.querySelector("#position-count").textContent = positions.length;
  document.querySelector("#header-balance").textContent = money(state.balanceCents);
  document.querySelector("#trade-balance").textContent = money(state.balanceCents);

  const positionList = document.querySelector("#position-list");
  positionList.replaceChildren();
  if (!positions.length) {
    const empty = document.createElement("div");
    empty.className = "portfolio-empty";
    empty.innerHTML = `
      <strong>No paper positions yet.</strong>
      <p>Pick a sample market and choose a Yes or No position to see it here.</p>
      <button type="button" data-return-markets>Explore markets</button>`;
    empty.querySelector("[data-return-markets]").addEventListener("click", () => setPage("markets"));
    positionList.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "position-list";
    positions.forEach(([key, position]) => {
      const [marketId, outcome] = key.split(":");
      const market = markets.find((item) => item.id === marketId);
      if (!market) return;
      const currentValue = Math.round(position.shares * outcomePrice(market, outcome));
      const card = document.createElement("article");
      card.className = "position-card";
      card.innerHTML = `
        <div>
          <div class="position-title">${market.question}</div>
          <div class="position-meta">${outcome.toUpperCase()} · ${position.shares.toFixed(2)} shares · ${money(position.costCents)} paper cost</div>
        </div>
        <div class="position-value"><strong>${money(currentValue)}</strong><span>sample value</span></div>
        <button class="position-remove" type="button" data-sell="${key}">Close paper position · receive ${money(currentValue)}</button>`;
      card.querySelector("[data-sell]").addEventListener("click", () => sellPosition(key));
      list.append(card);
    });
    positionList.append(list);
  }

  const activityList = document.querySelector("#activity-list");
  activityList.replaceChildren();
  if (!state.activity.length) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "Your paper-trade activity will show up here.";
    activityList.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "activity-list";
    state.activity.forEach((item) => {
      const row = document.createElement("div");
      row.className = "activity-item";
      const description = document.createElement("strong");
      description.textContent = item.text;
      const time = document.createElement("span");
      time.textContent = item.time;
      row.append(description, time);
      list.append(row);
    });
    activityList.append(list);
  }
}

function setPage(page) {
  activePage = page;
  document.querySelector("#markets-view").hidden = page !== "markets";
  document.querySelector("#portfolio-view").hidden = page !== "portfolio";
  document.querySelectorAll("[data-page]").forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle("is-current", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  renderPortfolio();
  if (page === "markets") renderMarkets();
}

document.querySelectorAll("[data-category]").forEach((button) => {
  button.addEventListener("click", () => {
    category = button.dataset.category;
    document.querySelectorAll("[data-category]").forEach((item) => {
      item.classList.toggle("is-selected", item === button);
    });
    renderMarkets();
  });
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => {
      item.classList.toggle("is-active", item === button);
    });
    renderMarkets();
  });
});

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.page));
});

document.querySelectorAll("[data-outcome]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedOutcome = button.dataset.outcome;
    renderTradePanel();
    tradeStatus.textContent = `${selectedOutcome === "yes" ? "Yes" : "No"} selected for paper trading.`;
  });
});

document.querySelectorAll("[data-amount]").forEach((button) => {
  button.addEventListener("click", () => {
    amountInput.value = button.dataset.amount;
    renderTradePanel();
  });
});

document.querySelector("#max-amount").addEventListener("click", () => {
  amountInput.value = (state.balanceCents / 100).toFixed(2);
  renderTradePanel();
});

amountInput.addEventListener("input", renderTradePanel);
document.querySelector("#trade-submit").addEventListener("click", buyPaperPosition);
document.querySelector("#sort-select").addEventListener("change", (event) => {
  sort = event.target.value;
  renderMarkets();
});
searchInput.addEventListener("input", renderMarkets);
document.querySelector("#featured-cta").addEventListener("click", () => {
  selectMarket("fed-december-cut", "yes");
  document.querySelector("#trade-sidebar").scrollIntoView({ behavior: "smooth" });
});
document.querySelector("#reset-demo").addEventListener("click", () => {
  state = defaultState();
  saveState();
  tradeStatus.textContent = "Demo portfolio reset to $1,000.00.";
  renderPortfolio();
  renderTradePanel();
  renderMarkets();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const target = event.target;
    if (target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
    event.preventDefault();
    searchInput.focus();
  }
});

renderMarkets();
renderTradePanel();
renderPortfolio();
setPage(activePage);
