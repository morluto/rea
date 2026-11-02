const STORAGE_KEY = "civic-atlas.workspace.v1";
const PALETTE = ["#5885a9", "#568c7d", "#9a7dad", "#ba8954", "#628f9e", "#9b6d75", "#7588b5", "#718d62"];
const DEFAULT_CATEGORIES = ["Executive", "Legislative", "Judicial", "Independent"];
const DEFAULT_RELATIONSHIPS = ["contains", "oversees", "coordinates with"];
const STATUS_LABELS = {
  untracked: "Not tracked",
  vacant: "Vacant",
  acting: "Acting official",
  filled: "Confirmed",
};

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const starterEntities = [
  { id: "president", name: "President of the United States", category: "Executive", kind: "Constitutional office", status: "untracked", notes: "Head of the executive branch." },
  { id: "white-house", name: "Executive Office of the President", category: "Executive", kind: "Office", status: "untracked", notes: "Supports the President in carrying out executive responsibilities." },
  { id: "cabinet", name: "Cabinet", category: "Executive", kind: "Leadership body", status: "untracked", notes: "A sample grouping of executive departments." },
  { id: "state", name: "Department of State", category: "Executive", kind: "Executive department", status: "untracked" },
  { id: "treasury", name: "Department of the Treasury", category: "Executive", kind: "Executive department", status: "untracked" },
  { id: "justice", name: "Department of Justice", category: "Executive", kind: "Executive department", status: "untracked" },
  { id: "epa", name: "Environmental Protection Agency", category: "Independent", kind: "Agency", status: "untracked", notes: "Independent agency in the executive branch." },
  { id: "congress", name: "United States Congress", category: "Legislative", kind: "Legislature", status: "untracked" },
  { id: "senate", name: "Senate", category: "Legislative", kind: "Chamber", status: "untracked" },
  { id: "house", name: "House of Representatives", category: "Legislative", kind: "Chamber", status: "untracked" },
  { id: "gao", name: "Government Accountability Office", category: "Legislative", kind: "Legislative agency", status: "untracked" },
  { id: "supreme-court", name: "Supreme Court of the United States", category: "Judicial", kind: "Court", status: "untracked" },
  { id: "federal-courts", name: "Federal Courts", category: "Judicial", kind: "Court system", status: "untracked" },
  { id: "fed", name: "Federal Reserve System", category: "Independent", kind: "Independent system", status: "untracked" },
  { id: "sec", name: "Securities and Exchange Commission", category: "Independent", kind: "Independent agency", status: "untracked" },
  { id: "nara", name: "National Archives and Records Administration", category: "Independent", kind: "Independent agency", status: "untracked" },
];

const starterRelationships = [
  ["president", "white-house", "contains"],
  ["president", "cabinet", "contains"],
  ["cabinet", "state", "contains"],
  ["cabinet", "treasury", "contains"],
  ["cabinet", "justice", "contains"],
  ["congress", "senate", "contains"],
  ["congress", "house", "contains"],
  ["congress", "gao", "contains"],
  ["supreme-court", "federal-courts", "contains"],
  ["congress", "gao", "oversees"],
  ["president", "epa", "oversees"],
  ["treasury", "fed", "coordinates with"],
  ["justice", "sec", "coordinates with"],
];

function createInitialWorkspace() {
  return {
    version: 1,
    categories: [...DEFAULT_CATEGORIES],
    relationshipTypes: [...DEFAULT_RELATIONSHIPS],
    entities: starterEntities.map((entity) => ({ ...entity })),
    relationships: starterRelationships.map(([sourceId, targetId, type]) => ({
      id: makeId("rel"),
      sourceId,
      targetId,
      type,
    })),
    activity: [],
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateWorkspace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The file must contain a workspace object.");
  const { categories, relationshipTypes, entities, relationships, activity } = value;
  if (!Array.isArray(categories) || !Array.isArray(relationshipTypes) || !Array.isArray(entities) || !Array.isArray(relationships)) {
    throw new Error("Workspace is missing categories, relationship types, institutions, or relationships.");
  }
  if (categories.length > 100 || relationshipTypes.length > 100 || entities.length > 2000 || relationships.length > 10000) {
    throw new Error("The workspace exceeds the supported size.");
  }
  if (!categories.every(isNonEmptyString) || !relationshipTypes.every(isNonEmptyString)) {
    throw new Error("Categories and relationship types must be non-empty text.");
  }
  const normalizedCategories = categories.map((item) => item.trim().toLowerCase());
  const normalizedTypes = relationshipTypes.map((item) => item.trim().toLowerCase());
  if (new Set(normalizedCategories).size !== categories.length || new Set(normalizedTypes).size !== relationshipTypes.length) {
    throw new Error("Categories and relationship types must be unique.");
  }
  if (!relationshipTypes.includes("contains")) {
    throw new Error('Relationship type "contains" is required for hierarchy.');
  }
  const entityIds = new Set();
  for (const entity of entities) {
    if (!entity || !isNonEmptyString(entity.id) || !isNonEmptyString(entity.name) || !isNonEmptyString(entity.category)) {
      throw new Error("Every institution needs an ID, name, and category.");
    }
    if (entityIds.has(entity.id)) throw new Error("Institution IDs must be unique.");
    entityIds.add(entity.id);
    if (!categories.includes(entity.category)) throw new Error(`Unknown category on institution "${entity.name}".`);
    if (!["untracked", "vacant", "acting", "filled"].includes(entity.status || "untracked")) {
      throw new Error(`Unknown leadership status on institution "${entity.name}".`);
    }
  }
  const relationIds = new Set();
  for (const relation of relationships) {
    if (!relation || !isNonEmptyString(relation.id) || relationIds.has(relation.id)) throw new Error("Relationship IDs must be present and unique.");
    if (!entityIds.has(relation.sourceId) || !entityIds.has(relation.targetId) || relation.sourceId === relation.targetId) {
      throw new Error("Each relationship must connect two different institutions in the workspace.");
    }
    if (!relationshipTypes.includes(relation.type)) throw new Error(`Unknown relationship type "${relation.type}".`);
    relationIds.add(relation.id);
  }
  if (!Array.isArray(activity) || !activity.every((item) => item && isNonEmptyString(item.action) && isNonEmptyString(item.at))) {
    throw new Error("Workspace activity must be a list of timestamped changes.");
  }
  const parent = new Map();
  for (const relation of relationships.filter((item) => item.type.toLowerCase() === "contains")) {
    if (parent.has(relation.targetId)) throw new Error("An institution cannot have more than one containing parent.");
    parent.set(relation.targetId, relation.sourceId);
  }
  for (const id of entityIds) {
    const seen = new Set();
    let current = id;
    while (parent.has(current)) {
      if (seen.has(current)) throw new Error("The hierarchy contains a cycle.");
      seen.add(current);
      current = parent.get(current);
    }
  }
  return {
    version: 1,
    categories: [...categories],
    relationshipTypes: [...relationshipTypes],
    entities: entities.map((entity) => ({
      id: entity.id,
      name: entity.name.trim(),
      category: entity.category,
      kind: typeof entity.kind === "string" ? entity.kind.slice(0, 60) : "",
      status: entity.status || "untracked",
      notes: typeof entity.notes === "string" ? entity.notes.slice(0, 1000) : "",
    })),
    relationships: relationships.map((relation) => ({ id: relation.id, sourceId: relation.sourceId, targetId: relation.targetId, type: relation.type })),
    activity: activity.slice(0, 300).map((item) => ({
      action: item.action.slice(0, 180),
      at: item.at,
      icon: typeof item.icon === "string" ? item.icon.slice(0, 2) : "↻",
    })),
  };
}

function loadWorkspace() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { workspace: validateWorkspace(JSON.parse(saved)), warning: "" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown local storage error.";
    return { workspace: createInitialWorkspace(), warning: `Saved workspace could not be loaded (${reason}); the starter graph is shown. Export important data before continuing.` };
  }
  return { workspace: createInitialWorkspace(), warning: "" };
}

const loaded = loadWorkspace();
let workspace = loaded.workspace;
let selectedEntityId = "";
let toastTimer;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function entityById(id) {
  return workspace.entities.find((entity) => entity.id === id);
}

function parentOf(id) {
  const relation = workspace.relationships.find((item) => item.targetId === id && item.type.toLowerCase() === "contains");
  return relation ? entityById(relation.sourceId) : undefined;
}

function childrenOf(id) {
  return workspace.relationships
    .filter((item) => item.sourceId === id && item.type.toLowerCase() === "contains")
    .map((item) => entityById(item.targetId))
    .filter(Boolean);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown storage error.";
    showToast(`Could not save to this browser: ${reason}`);
    return false;
  }
}

function announce(message) {
  $("#announcer").textContent = message;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
  announce(message);
}

function recordActivity(action, icon = "↻") {
  workspace.activity.unshift({ action, at: new Date().toISOString(), icon });
  workspace.activity = workspace.activity.slice(0, 300);
}

function saveAndRender(message) {
  persist();
  renderAll();
  if (message) showToast(message);
}

function el(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "className") node.className = value;
    else if (key === "value") {
      node.setAttribute(key, value);
      node.dataset.value = value;
    } else if (key.startsWith("aria-") || ["type", "title", "href", "download", "tabindex", "role", "name", "accept"].includes(key)) node.setAttribute(key, value);
    else node.dataset[key] = value;
  }
  if (text) node.textContent = text;
  return node;
}

function svgEl(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function setView(name) {
  const validViews = ["overview", "graph", "directory", "activity"];
  if (!validViews.includes(name)) return;
  $$(".view-panel").forEach((panel) => panel.classList.toggle("is-hidden", panel.id !== `${name}View`));
  $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === name));
  const labels = { overview: "Overview", graph: "Organization graph", directory: "Directory", activity: "Recent changes" };
  $("#breadcrumbCurrent").textContent = labels[name];
  if (name === "graph") drawGraph();
  if (name === "directory") renderDirectory();
  if (name === "activity") renderActivity();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function categoryColor(category) {
  const index = workspace.categories.indexOf(category);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
}

function populateSelect(select, values, placeholder) {
  const previous = select.value;
  select.replaceChildren();
  if (placeholder) select.append(el("option", { value: "" }, placeholder));
  values.forEach((value) => select.append(el("option", { value }, value)));
  if (values.includes(previous)) select.value = previous;
}

function refreshSelects() {
  const categoryOptions = [...workspace.categories];
  const filterCategories = ["", ...categoryOptions];
  const previousCategory = $("#categoryFilter").value;
  const previousDirectoryCategory = $("#directoryCategoryFilter").value;
  $("#categoryFilter").replaceChildren(el("option", { value: "" }, "All categories"));
  $("#directoryCategoryFilter").replaceChildren(el("option", { value: "" }, "All categories"));
  categoryOptions.forEach((category) => {
    $("#categoryFilter").append(el("option", { value: category }, category));
    $("#directoryCategoryFilter").append(el("option", { value: category }, category));
  });
  if (filterCategories.includes(previousCategory)) $("#categoryFilter").value = previousCategory;
  if (filterCategories.includes(previousDirectoryCategory)) $("#directoryCategoryFilter").value = previousDirectoryCategory;
  populateSelect($("#entityCategory"), categoryOptions, "");
  populateSelect($("#relationType"), workspace.relationshipTypes, "");
  const parentSelect = $("#entityParent");
  const previousParent = parentSelect.value;
  parentSelect.replaceChildren(el("option", { value: "" }, "No parent relationship"));
  workspace.entities
    .filter((entity) => entity.id !== $("#entityId").value)
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((entity) => parentSelect.append(el("option", { value: entity.id }, entity.name)));
  if (workspace.entities.some((entity) => entity.id === previousParent)) parentSelect.value = previousParent;
}

function renderAll() {
  $("#navEntityCount").textContent = String(workspace.entities.length);
  $("#entityMetric").textContent = String(workspace.entities.length);
  $("#vacantMetric").textContent = String(workspace.entities.filter((entity) => entity.status === "vacant").length);
  $("#actingMetric").textContent = String(workspace.entities.filter((entity) => entity.status === "acting").length);
  const last = workspace.activity[0];
  $("#lastChangeMetric").textContent = last ? "Edited" : "Starter graph";
  $("#lastChangeCaption").textContent = last ? formatRelative(last.at) : "Ready for your edits";
  refreshSelects();
  renderBranches();
  renderActivity();
  renderDirectory();
  renderStructure();
  drawGraph();
  if (selectedEntityId && !entityById(selectedEntityId)) {
    selectedEntityId = "";
    renderInspector();
  } else if (selectedEntityId) {
    renderInspector();
  }
}

function renderBranches() {
  const list = $("#branchList");
  list.replaceChildren();
  const counts = workspace.categories.map((category) => ({
    category,
    count: workspace.entities.filter((entity) => entity.category === category).length,
  }));
  const maximum = Math.max(1, ...counts.map((item) => item.count));
  counts.forEach(({ category, count }, index) => {
    const row = el("div", { className: "branch-row" });
    row.append(el("span", { className: "branch-name" }, category));
    const bar = el("span", { className: "branch-bar" });
    const fill = el("span");
    fill.style.width = `${(count / maximum) * 100}%`;
    fill.style.setProperty("--branch-color", PALETTE[index % PALETTE.length]);
    bar.append(fill);
    row.append(bar, el("span", { className: "branch-count" }, String(count)));
    list.append(row);
  });
}

function formatRelative(timestamp) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "Date unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(parsed).toLocaleDateString();
}

function renderActivityList(container, limit) {
  container.replaceChildren();
  const items = workspace.activity.slice(0, limit);
  if (!items.length) {
    container.append(el("div", { className: "empty-activity" }, "No local edits yet. Your changes will appear here."));
    return;
  }
  items.forEach((item) => {
    const entry = el("div", { className: "activity-entry" });
    entry.append(el("span", { className: "activity-symbol" }, item.icon || "↻"));
    const text = el("span");
    text.append(el("strong", {}, item.action), el("small", {}, "Local workspace"));
    entry.append(text, el("span", { className: "activity-time", title: new Date(item.at).toLocaleString() }, formatRelative(item.at)));
    container.append(entry);
  });
}

function renderActivity() {
  renderActivityList($("#overviewActivity"), 4);
  renderActivityList($("#fullActivity"), 200);
}

function statusClass(status) {
  return `status-${status || "untracked"}`;
}

function renderDirectory() {
  const query = $("#directorySearch").value.trim().toLowerCase();
  const category = $("#directoryCategoryFilter").value;
  const status = $("#statusFilter").value;
  const rows = $("#directoryRows");
  rows.replaceChildren();
  const filtered = [...workspace.entities]
    .filter((entity) => !category || entity.category === category)
    .filter((entity) => !status || (entity.status || "untracked") === status)
    .filter((entity) => !query || `${entity.name} ${entity.category} ${entity.kind} ${entity.notes || ""}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  filtered.forEach((entity) => {
    const row = el("tr");
    const nameCell = el("td");
    const name = el("div", { className: "directory-name" });
    const icon = el("span", { className: "directory-node-icon" }, entity.category.slice(0, 1).toUpperCase());
    const copy = el("span");
    copy.append(el("strong", {}, entity.name), el("small", {}, parentOf(entity.id)?.name || "Top-level institution"));
    name.append(icon, copy);
    nameCell.append(name);
    const categoryCell = el("td");
    categoryCell.append(el("span", { className: "table-category" }, entity.category));
    const statusCell = el("td");
    statusCell.append(el("span", { className: `table-status ${statusClass(entity.status)}` }, STATUS_LABELS[entity.status || "untracked"]));
    const relationCount = workspace.relationships.filter((relation) => relation.sourceId === entity.id || relation.targetId === entity.id).length;
    const actionsCell = el("td");
    const actions = el("div", { className: "row-actions" });
    const edit = el("button", { className: "row-action", action: "edit-entity", id: entity.id, type: "button", title: `Edit ${entity.name}` }, "Edit");
    const focus = el("button", { className: "row-action", action: "focus-entity", id: entity.id, type: "button", title: `Inspect ${entity.name}` }, "Graph");
    actions.append(focus, edit);
    actionsCell.append(actions);
    row.append(nameCell, categoryCell, el("td", {}, entity.kind || "—"), statusCell, el("td", {}, String(relationCount)), actionsCell);
    rows.append(row);
  });
  $("#directoryEmpty").classList.toggle("is-hidden", filtered.length > 0);
}

function renderStructure() {
  const categoryList = $("#categoryList");
  categoryList.replaceChildren();
  workspace.categories.forEach((category) => {
    const count = workspace.entities.filter((entity) => entity.category === category).length;
    const row = el("div", { className: "structure-row" });
    row.append(el("span", { className: "structure-row-name" }, category), el("span", { className: "structure-row-meta" }, `${count} institutions`));
    const actions = el("span", { className: "structure-actions" });
    actions.append(
      el("button", { className: "structure-action", type: "button", action: "rename-category", value: category }, "Rename"),
      el("button", { className: "structure-action danger", type: "button", action: "delete-category", value: category }, "Delete"),
    );
    row.append(actions);
    categoryList.append(row);
  });
  const typeList = $("#relationshipTypeList");
  typeList.replaceChildren();
  workspace.relationshipTypes.forEach((type) => {
    const count = workspace.relationships.filter((relation) => relation.type === type).length;
    const row = el("div", { className: "structure-row" });
    row.append(el("span", { className: "structure-row-name" }, type), el("span", { className: "structure-row-meta" }, `${count} relationships`));
    const actions = el("span", { className: "structure-actions" });
    if (type.toLowerCase() === "contains") {
      actions.append(el("span", { className: "structure-row-meta" }, "Required"));
    } else {
      actions.append(
        el("button", { className: "structure-action", type: "button", action: "rename-type", value: type }, "Rename"),
        el("button", { className: "structure-action danger", type: "button", action: "delete-type", value: type }, "Delete"),
      );
    }
    row.append(actions);
    typeList.append(row);
  });
}

function graphPositions(entities, categories) {
  const laneWidth = 240;
  const positions = new Map();
  let maxRows = 1;
  categories.forEach((category, categoryIndex) => {
    const members = entities.filter((entity) => entity.category === category);
    const depth = (entity, visiting = new Set()) => {
      if (visiting.has(entity.id)) return 0;
      visiting.add(entity.id);
      const parent = parentOf(entity.id);
      if (!parent || parent.category !== category) return 0;
      return 1 + depth(parent, visiting);
    };
    members.sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name));
    maxRows = Math.max(maxRows, members.length);
    members.forEach((entity, index) => positions.set(entity.id, {
      x: 20 + categoryIndex * laneWidth,
      y: 91 + index * 78,
      width: 206,
      height: 55,
      categoryIndex,
    }));
  });
  return { positions, width: Math.max(240, categories.length * laneWidth + 20), height: Math.max(300, 110 + maxRows * 78) };
}

function drawGraph() {
  const svg = $("#graphSvg");
  if (!svg) return;
  svg.replaceChildren();
  const selectedCategory = $("#categoryFilter").value;
  const entities = workspace.entities.filter((entity) => !selectedCategory || entity.category === selectedCategory);
  const visibleIds = new Set(entities.map((entity) => entity.id));
  const categories = workspace.categories.filter((category) => !selectedCategory || category === selectedCategory);
  const layout = graphPositions(entities, categories);
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
  svg.style.width = `${layout.width}px`;
  svg.style.height = `${layout.height}px`;
  const positions = layout.positions;

  categories.forEach((category, index) => {
    const x = 20 + index * 240;
    const header = svgEl("g");
    const color = categoryColor(category);
    const label = svgEl("text", { x: x + 2, y: 28, fill: color, "font-size": 9, "font-family": "DM Sans, sans-serif", "font-weight": 700, "letter-spacing": 1 });
    label.textContent = category.toUpperCase();
    header.append(label, svgEl("line", { x1: x, y1: 42, x2: x + 206, y2: 42, stroke: color, "stroke-width": 1, opacity: .45 }));
    svg.append(header);
  });

  workspace.relationships.forEach((relation) => {
    if (!visibleIds.has(relation.sourceId) || !visibleIds.has(relation.targetId)) return;
    const source = positions.get(relation.sourceId);
    const target = positions.get(relation.targetId);
    if (!source || !target) return;
    const isHierarchy = relation.type.toLowerCase() === "contains";
    const path = svgEl("path", {
      d: `M ${source.x + source.width / 2} ${source.y + source.height} C ${source.x + source.width / 2} ${(source.y + source.height + target.y) / 2}, ${target.x + target.width / 2} ${(source.y + source.height + target.y) / 2}, ${target.x + target.width / 2} ${target.y}`,
      class: isHierarchy ? "graph-link" : "graph-link graph-link-cross",
    });
    path.append(svgEl("title"));
    path.firstElementChild.textContent = `${entityById(relation.sourceId)?.name} ${relation.type} ${entityById(relation.targetId)?.name}`;
    svg.append(path);
  });

  categories.forEach((category) => {
    const categoryEntities = entities.filter((entity) => entity.category === category);
    categoryEntities.forEach((entity, index) => {
      const pos = positions.get(entity.id);
      const color = categoryColor(category);
      const node = svgEl("g", {
        class: `graph-node${selectedEntityId === entity.id ? " is-selected" : ""}`,
        tabindex: 0,
        role: "button",
        "aria-label": `${entity.name}, ${category}. ${STATUS_LABELS[entity.status || "untracked"]}. Select to inspect.`,
      });
      node.dataset.entityId = entity.id;
      node.append(svgEl("rect", {
        x: pos.x,
        y: pos.y,
        width: pos.width,
        height: pos.height,
        rx: 7,
        fill: "#ffffff",
        stroke: selectedEntityId === entity.id ? color : "#d8e0e6",
        "stroke-width": selectedEntityId === entity.id ? 2.5 : 1,
      }));
      node.append(svgEl("rect", { x: pos.x, y: pos.y, width: 4, height: pos.height, rx: 2, fill: color }));
      const name = svgEl("text", { x: pos.x + 14, y: pos.y + 22, class: "node-label" });
      const displayName = entity.name.length > 31 ? `${entity.name.slice(0, 29)}…` : entity.name;
      name.textContent = displayName;
      const kind = svgEl("text", { x: pos.x + 14, y: pos.y + 39, class: "node-sub" });
      kind.textContent = (entity.kind || "Institution").slice(0, 33);
      node.append(name, kind);
      if (entity.status && entity.status !== "untracked") {
        const markerColor = entity.status === "vacant" ? "#c18446" : entity.status === "acting" ? "#8676ad" : "#59926e";
        node.append(svgEl("circle", { cx: pos.x + pos.width - 13, cy: pos.y + 13, r: 4, fill: markerColor }));
      }
      node.addEventListener("click", () => selectEntity(entity.id));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectEntity(entity.id);
        }
      });
      svg.append(node);
    });
  });
  const extraConnections = workspace.relationships.filter((relation) => relation.type.toLowerCase() !== "contains" && visibleIds.has(relation.sourceId) && visibleIds.has(relation.targetId)).length;
  $("#graphCount").textContent = `${entities.length} institutions · ${extraConnections + workspace.relationships.filter((relation) => relation.type.toLowerCase() === "contains" && visibleIds.has(relation.sourceId) && visibleIds.has(relation.targetId)).length} connections`;
}

function selectEntity(id) {
  selectedEntityId = id;
  renderInspector();
  drawGraph();
}

function renderInspector() {
  const inspector = $("#inspector");
  inspector.replaceChildren();
  if (!selectedEntityId || !entityById(selectedEntityId)) {
    inspector.classList.add("is-hidden");
    return;
  }
  inspector.classList.remove("is-hidden");
  const entity = entityById(selectedEntityId);
  const top = el("div", { className: "inspector-top" });
  top.append(el("span", { className: "inspector-category" }, entity.category));
  top.append(el("button", { className: "icon-button", type: "button", action: "close-inspector", "aria-label": "Close details" }, "×"));
  inspector.append(top, el("h2", {}, entity.name), el("div", { className: "inspector-kind" }, entity.kind || "Institution"));
  inspector.append(el("span", { className: `inspector-status ${statusClass(entity.status)}` }, STATUS_LABELS[entity.status || "untracked"]));
  const parent = parentOf(entity.id);
  if (parent) {
    const parentSection = el("section", { className: "inspector-section" });
    parentSection.append(el("h3", {}, "Contains / reports to"));
    const relation = el("div", { className: "inspector-relation" });
    relation.append(el("strong", {}, parent.name), el("small", {}, "Containing institution"));
    parentSection.append(relation);
    inspector.append(parentSection);
  }
  const notesSection = el("section", { className: "inspector-section" });
  notesSection.append(el("h3", {}, "Notes"), el("div", { className: "inspector-notes" }, entity.notes || "No notes added."));
  inspector.append(notesSection);
  const related = workspace.relationships.filter((relation) =>
    (relation.sourceId === entity.id || relation.targetId === entity.id) && relation.type.toLowerCase() !== "contains",
  );
  if (related.length) {
    const relatedSection = el("section", { className: "inspector-section" });
    relatedSection.append(el("h3", {}, "Other relationships"));
    const list = el("div", { className: "inspector-relations" });
    related.forEach((relation) => {
      const other = entityById(relation.sourceId === entity.id ? relation.targetId : relation.sourceId);
      if (!other) return;
      const card = el("div", { className: "inspector-relation" });
      card.append(el("strong", {}, relation.sourceId === entity.id ? `${relation.type} ${other.name}` : `${other.name} ${relation.type}`));
      const controls = el("span", { className: "structure-actions" });
      controls.append(
        el("button", { className: "row-action", type: "button", action: "edit-relation", id: relation.id }, "Edit"),
        el("button", { className: "row-action", type: "button", action: "delete-relation", id: relation.id }, "Remove"),
      );
      card.append(controls);
      list.append(card);
    });
    relatedSection.append(list);
    inspector.append(relatedSection);
  }
  const children = childrenOf(entity.id);
  if (children.length) {
    const childSection = el("section", { className: "inspector-section" });
    childSection.append(el("h3", {}, "Contains"));
    const list = el("div", { className: "inspector-relations" });
    children.forEach((child) => {
      const item = el("div", { className: "inspector-relation" });
      item.append(el("strong", {}, child.name), el("small", {}, child.category));
      list.append(item);
    });
    childSection.append(list);
    inspector.append(childSection);
  }
  const actions = el("div", { className: "inspector-actions" });
  actions.append(
    el("button", { className: "button button-quiet", type: "button", action: "edit-entity", id: entity.id }, "Edit"),
    el("button", { className: "button button-quiet", type: "button", action: "add-related", id: entity.id }, "Connect"),
    el("button", { className: "button button-quiet", type: "button", action: "delete-entity", id: entity.id }, "Delete"),
  );
  inspector.append(actions);
}

function openEntityDialog(id = "") {
  const entity = id ? entityById(id) : null;
  $("#entityForm").reset();
  $("#entityId").value = entity?.id || "";
  refreshSelects();
  $("#entityDialogTitle").textContent = entity ? "Edit institution" : "Add institution";
  $("#entityName").value = entity?.name || "";
  $("#entityCategory").value = entity?.category || workspace.categories[0] || "";
  $("#entityKind").value = entity?.kind || "";
  $("#entityStatus").value = entity?.status || "untracked";
  $("#entityNotes").value = entity?.notes || "";
  $("#entityParent").value = entity ? (parentOf(entity.id)?.id || "") : "";
  $("#entityDialog").showModal();
  $("#entityName").focus();
}

function parentWouldCycle(parentId, childId) {
  const visited = new Set();
  let cursor = parentId;
  while (cursor) {
    if (cursor === childId || visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = parentOf(cursor)?.id;
  }
  return false;
}

function saveEntity(event) {
  event.preventDefault();
  const id = $("#entityId").value;
  const name = $("#entityName").value.trim();
  const category = $("#entityCategory").value;
  const parentId = $("#entityParent").value;
  const existing = id ? entityById(id) : null;
  if (!name || !workspace.categories.includes(category)) {
    showToast("Add a name and choose a valid category.");
    return;
  }
  if (parentId && (!entityById(parentId) || parentWouldCycle(parentId, id || ""))) {
    showToast("That parent would create a circular hierarchy. Choose a different parent.");
    return;
  }
  const entity = {
    id: existing?.id || makeId("org"),
    name,
    category,
    kind: $("#entityKind").value.trim(),
    status: $("#entityStatus").value,
    notes: $("#entityNotes").value.trim(),
  };
  if (existing) {
    Object.assign(existing, entity);
    workspace.relationships = workspace.relationships.filter((relation) => !(relation.targetId === id && relation.type.toLowerCase() === "contains"));
    recordActivity(`Updated ${name}`, "✎");
  } else {
    workspace.entities.push(entity);
    recordActivity(`Added ${name}`, "+");
  }
  if (parentId) {
    workspace.relationships.push({ id: makeId("rel"), sourceId: parentId, targetId: entity.id, type: "contains" });
  }
  $("#entityDialog").close();
  selectedEntityId = entity.id;
  saveAndRender(existing ? "Institution updated." : "Institution added.");
}

function openRelationDialog(relationId = "", sourceId = "") {
  if (workspace.entities.length < 2) {
    showToast("Add at least two institutions before creating a relationship.");
    return;
  }
  const relation = relationId ? workspace.relationships.find((item) => item.id === relationId) : null;
  $("#relationForm").reset();
  $("#relationId").value = relation?.id || "";
  const sorted = [...workspace.entities].sort((a, b) => a.name.localeCompare(b.name));
  populateSelect($("#relationSource"), sorted.map((item) => item.id), "");
  populateSelect($("#relationTarget"), sorted.map((item) => item.id), "");
  $("#relationSource").replaceChildren(...sorted.map((item) => {
    const option = el("option", { value: item.id }, item.name);
    return option;
  }));
  $("#relationTarget").replaceChildren(...sorted.map((item) => el("option", { value: item.id }, item.name)));
  populateSelect($("#relationType"), workspace.relationshipTypes, "");
  if (relation) {
    $("#relationSource").value = relation.sourceId;
    $("#relationTarget").value = relation.targetId;
    $("#relationType").value = relation.type;
    $("#relationDialogTitle").textContent = "Edit relationship";
  } else {
    $("#relationSource").value = sourceId || sorted[0].id;
    $("#relationTarget").value = sorted.find((entity) => entity.id !== sourceId)?.id || sorted[1].id;
    $("#relationType").value = "contains";
    $("#relationDialogTitle").textContent = "Add relationship";
  }
  $("#relationDialog").showModal();
}

function saveRelation(event) {
  event.preventDefault();
  const id = $("#relationId").value;
  const sourceId = $("#relationSource").value;
  const targetId = $("#relationTarget").value;
  const type = $("#relationType").value;
  if (!entityById(sourceId) || !entityById(targetId) || sourceId === targetId || !workspace.relationshipTypes.includes(type)) {
    showToast("Choose two different institutions and a valid relationship type.");
    return;
  }
  const duplicate = workspace.relationships.find((relation) =>
    relation.id !== id && relation.sourceId === sourceId && relation.targetId === targetId && relation.type === type,
  );
  if (duplicate) {
    showToast("That relationship already exists.");
    return;
  }
  if (type.toLowerCase() === "contains") {
    const existingParent = workspace.relationships.find((relation) => relation.type.toLowerCase() === "contains" && relation.targetId === targetId && relation.id !== id);
    if (existingParent) {
      showToast("This institution already has a parent. Change its parent in the institution editor.");
      return;
    }
    if (parentWouldCycle(sourceId, targetId)) {
      showToast("That relationship would create a circular hierarchy.");
      return;
    }
  }
  const relation = { id: id || makeId("rel"), sourceId, targetId, type };
  if (id) {
    const index = workspace.relationships.findIndex((item) => item.id === id);
    if (index >= 0) workspace.relationships[index] = relation;
    recordActivity(`Updated ${entityById(sourceId).name} ${type} ${entityById(targetId).name}`, "⤳");
  } else {
    workspace.relationships.push(relation);
    recordActivity(`Connected ${entityById(sourceId).name} to ${entityById(targetId).name}`, "⤳");
  }
  $("#relationDialog").close();
  saveAndRender(id ? "Relationship updated." : "Relationship added.");
}

function deleteEntity(id) {
  const entity = entityById(id);
  if (!entity || !window.confirm(`Delete "${entity.name}" and all of its connections?`)) return;
  workspace.entities = workspace.entities.filter((item) => item.id !== id);
  workspace.relationships = workspace.relationships.filter((relation) => relation.sourceId !== id && relation.targetId !== id);
  recordActivity(`Deleted ${entity.name} and its connections`, "−");
  selectedEntityId = "";
  saveAndRender("Institution and connections deleted.");
}

function deleteRelation(id) {
  const index = workspace.relationships.findIndex((relation) => relation.id === id);
  if (index < 0) return;
  const [relation] = workspace.relationships.splice(index, 1);
  recordActivity(`Removed ${entityById(relation.sourceId)?.name || "Institution"} ${relation.type} ${entityById(relation.targetId)?.name || "institution"}`, "−");
  saveAndRender("Relationship removed.");
}

function addCategory(name) {
  const value = name.trim();
  if (!value) return;
  if (workspace.categories.some((category) => category.toLowerCase() === value.toLowerCase())) {
    showToast("A category with that name already exists.");
    return;
  }
  if (workspace.categories.length >= 100) {
    showToast("The workspace already has the maximum number of categories.");
    return;
  }
  workspace.categories.push(value);
  recordActivity(`Added the ${value} category`, "+");
  saveAndRender(`Category "${value}" added.`);
}

function renameCategory(oldName) {
  const field = $$('[data-action="rename-category"]', $("#categoryList")).find((button) => button.dataset.value === oldName);
  const row = field?.closest(".structure-row");
  if (!row) return;
  const input = el("input", { type: "text", value: oldName, "aria-label": `Rename ${oldName} category` });
  row.querySelector(".structure-row-name").replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const save = () => {
    if (finished) return;
    const name = input.value.trim();
    if (!name || name === oldName) { finished = true; renderStructure(); return; }
    if (workspace.categories.some((category) => category.toLowerCase() === name.toLowerCase())) {
      showToast("A category with that name already exists.");
      input.focus();
      return;
    }
    finished = true;
    workspace.categories = workspace.categories.map((category) => category === oldName ? name : category);
    workspace.entities.forEach((entity) => { if (entity.category === oldName) entity.category = name; });
    recordActivity(`Renamed ${oldName} to ${name}`, "✎");
    saveAndRender("Category renamed.");
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
    if (event.key === "Escape") { finished = true; renderStructure(); }
  });
  input.addEventListener("blur", save, { once: true });
}

function removeCategory(name) {
  const count = workspace.entities.filter((entity) => entity.category === name).length;
  if (count) {
    showToast(`Move ${count} institution${count === 1 ? "" : "s"} to another category before deleting this one.`);
    return;
  }
  if (workspace.categories.length <= 1) {
    showToast("Keep at least one category in the graph.");
    return;
  }
  workspace.categories = workspace.categories.filter((category) => category !== name);
  recordActivity(`Removed the ${name} category`, "−");
  saveAndRender(`Category "${name}" removed.`);
}

function addRelationshipType(name) {
  const value = name.trim();
  if (!value) return;
  if (workspace.relationshipTypes.some((type) => type.toLowerCase() === value.toLowerCase())) {
    showToast("A relationship type with that name already exists.");
    return;
  }
  if (workspace.relationshipTypes.length >= 100) {
    showToast("The workspace already has the maximum number of relationship types.");
    return;
  }
  workspace.relationshipTypes.push(value);
  recordActivity(`Added the ${value} relationship type`, "+");
  saveAndRender(`Relationship type "${value}" added.`);
}

function renameRelationshipType(oldName) {
  const field = $$('[data-action="rename-type"]', $("#relationshipTypeList")).find((button) => button.dataset.value === oldName);
  const row = field?.closest(".structure-row");
  if (!row) return;
  const input = el("input", { type: "text", value: oldName, "aria-label": `Rename ${oldName} relationship type` });
  row.querySelector(".structure-row-name").replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const save = () => {
    if (finished) return;
    const name = input.value.trim();
    if (!name || name === oldName) { finished = true; renderStructure(); return; }
    if (workspace.relationshipTypes.some((type) => type.toLowerCase() === name.toLowerCase())) {
      showToast("A relationship type with that name already exists.");
      input.focus();
      return;
    }
    finished = true;
    workspace.relationshipTypes = workspace.relationshipTypes.map((type) => type === oldName ? name : type);
    workspace.relationships.forEach((relation) => { if (relation.type === oldName) relation.type = name; });
    recordActivity(`Renamed ${oldName} relationships to ${name}`, "✎");
    saveAndRender("Relationship type renamed.");
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
    if (event.key === "Escape") { finished = true; renderStructure(); }
  });
  input.addEventListener("blur", save, { once: true });
}

function removeRelationshipType(type) {
  const count = workspace.relationships.filter((relation) => relation.type === type).length;
  if (count) {
    showToast(`Remove or change its ${count} relationship${count === 1 ? "" : "s"} before deleting this type.`);
    return;
  }
  workspace.relationshipTypes = workspace.relationshipTypes.filter((item) => item !== type);
  recordActivity(`Removed the ${type} relationship type`, "−");
  saveAndRender(`Relationship type "${type}" removed.`);
}

function exportWorkspace() {
  const file = new Blob([`${JSON.stringify(workspace, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const anchor = el("a", { href: url, download: `civic-atlas-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("Workspace exported as JSON.");
}

async function importWorkspace(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const imported = validateWorkspace(parsed);
    if (!window.confirm(`Replace this browser's workspace with ${imported.entities.length} institutions from "${file.name}"?`)) return;
    workspace = imported;
    selectedEntityId = "";
    const wasSaved = persist();
    renderAll();
    showToast(wasSaved ? "Workspace imported and saved." : "Workspace imported in memory, but browser storage failed. Export a backup.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The file could not be read.";
    showToast(`Import failed: ${reason}`);
  } finally {
    $("#importFile").value = "";
  }
}

function clearActivity() {
  if (!workspace.activity.length) {
    showToast("There is no activity to clear.");
    return;
  }
  if (!window.confirm("Clear the local edit history? Institution records and relationships will stay unchanged.")) return;
  workspace.activity = [];
  persist();
  renderAll();
  showToast("Local edit history cleared.");
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) setView(viewButton.dataset.view);
  const openViewButton = event.target.closest("[data-open-view]");
  if (openViewButton) setView(openViewButton.dataset.openView);
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const { action, id, value } = actionButton.dataset;
    if (action === "edit-entity") openEntityDialog(id);
    else if (action === "delete-entity") deleteEntity(id);
    else if (action === "focus-entity") { setView("graph"); selectEntity(id); }
    else if (action === "add-related") openRelationDialog("", id);
    else if (action === "edit-relation") openRelationDialog(id);
    else if (action === "delete-relation") deleteRelation(id);
    else if (action === "close-inspector") { selectedEntityId = ""; renderInspector(); drawGraph(); }
    else if (action === "rename-category") renameCategory(value);
    else if (action === "delete-category") removeCategory(value);
    else if (action === "rename-type") renameRelationshipType(value);
    else if (action === "delete-type") removeRelationshipType(value);
  }
  if (event.target.closest("#addEntityButton, #graphAddEntityButton, #directoryAddEntityButton")) openEntityDialog();
  if (event.target.closest("#addRelationButton")) openRelationDialog();
  if (event.target.closest("#structureButton, #overviewStructureButton")) $("#structureDialog").showModal();
  if (event.target.closest("#exportButton, #topExportButton")) exportWorkspace();
  if (event.target.closest("#importButton")) $("#importFile").click();
  if (event.target.closest("#fitGraphButton")) {
    $("#categoryFilter").value = "";
    drawGraph();
    $("#graphStage").scrollTo({ top: 0, left: 0, behavior: "smooth" });
  }
  if (event.target.closest("#clearActivityButton")) clearActivity();
  if (event.target.matches("[data-close-dialog]")) event.target.closest("dialog").close();
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#directorySearch")) renderDirectory();
  if (event.target.matches("#globalSearch")) {
    $("#directorySearch").value = event.target.value;
    if (event.target.value) setView("directory");
    renderDirectory();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches("#categoryFilter")) drawGraph();
  if (event.target.matches("#directoryCategoryFilter, #statusFilter")) renderDirectory();
});

$("#entityForm").addEventListener("submit", saveEntity);
$("#relationForm").addEventListener("submit", saveRelation);
$("#categoryForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addCategory($("#newCategory").value);
  event.target.reset();
});
$("#relationshipTypeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addRelationshipType($("#newRelationshipType").value);
  event.target.reset();
});
$("#importFile").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importWorkspace(file);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.target.matches("input, textarea, select") && !event.target.isContentEditable) {
    event.preventDefault();
    $("#globalSearch").focus();
  }
});

renderAll();
if (loaded.warning) showToast(loaded.warning);
