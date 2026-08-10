const state = {
  roots: [], definitions: [], definitionMap: new Map(), rules: [], items: [],
  presets: {}, history: [], browse: null, job: null, pollTimer: null, previewTimer: null,
  previewController: null, previewRevision: 0, previewDirty: false,
  previewPage: 0, previewPageSize: 100, previewShowAll: false,
};

const AUTO_PREVIEW_LIMIT = 1500;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const token = () => localStorage.getItem("renamedock-token") || "";
let openSelectShell = null;
let actionResolver = null;
let actionMode = "confirm";

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem("renamedock-theme", selected);
  const light = selected === "light";
  $$("[data-theme-toggle]").forEach(button => {
    const icon = button.querySelector("[data-theme-icon]");
    if (icon) icon.textContent = light ? "â˜¾" : "â˜€";
    button.querySelector("[data-theme-label]")?.replaceChildren(light ? "æ·±è‰²æ¨¡å¼" : "æµ…è‰²æ¨¡å¼");
    button.title = light ? "åˆ‡æ¢æ·±è‰²æ¨¡å¼" : "åˆ‡æ¢æµ…è‰²æ¨¡å¼";
    button.setAttribute("aria-label", light ? "åˆ‡æ¢æ·±è‰²æ¨¡å¼" : "åˆ‡æ¢æµ…è‰²æ¨¡å¼");
  });
}

function initTheme() {
  const saved = localStorage.getItem("renamedock-theme");
  const preferred = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  applyTheme(saved || preferred);
}

function closeCustomSelect() {
  if (!openSelectShell) return;
  openSelectShell.classList.remove("open");
  openSelectShell.querySelector(".select-trigger")?.setAttribute("aria-expanded", "false");
  openSelectShell = null;
}

function syncCustomSelect(select) {
  const shell = select.closest(".custom-select");
  if (!shell) return;
  const trigger = shell.querySelector(".select-trigger");
  const label = shell.querySelector(".select-value");
  const menu = shell.querySelector(".select-menu");
  const selected = select.options[select.selectedIndex] || select.options[0];
  label.textContent = selected?.textContent || "è¯·é€‰æ‹©";
  trigger.disabled = select.disabled;
  menu.innerHTML = [...select.options].map((option, index) => (
    `<button type="button" role="option" data-option="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>` +
      `<span>${escapeHtml(option.textContent)}</span>${option.selected ? "<i>âœ“</i>" : ""}</button>`
  )).join("");
  $$('[data-option]', menu).forEach(button => button.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    const option = select.options[Number(button.dataset.option)];
    if (!option || option.disabled) return;
    select.value = option.value;
    select.dispatchEvent(new Event("change", {bubbles: true}));
    syncCustomSelect(select);
    closeCustomSelect();
    trigger.focus();
  }));
}

function enhanceSelect(select) {
  if (select.closest(".custom-select")) { syncCustomSelect(select); return; }
  const shell = document.createElement("div");
  shell.className = "custom-select";
  select.parentNode.insertBefore(shell, select);
  shell.append(select);
  select.classList.add("native-select");
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML = `<span class="select-value"></span><i aria-hidden="true">âŒ„</i>`;
  const menu = document.createElement("div");
  menu.className = "select-menu";
  menu.setAttribute("role", "listbox");
  shell.append(trigger, menu);
  trigger.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    const opening = !shell.classList.contains("open");
    closeCustomSelect();
    if (!opening) return;
    syncCustomSelect(select);
    shell.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    openSelectShell = shell;
  });
  trigger.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (!shell.classList.contains("open")) trigger.click();
    const options = $$('[data-option]:not(:disabled)', menu);
    const chosen = options.find(button => button.getAttribute("aria-selected") === "true");
    (chosen || options[0])?.focus();
  });
  menu.addEventListener("keydown", event => {
    const options = $$('[data-option]:not(:disabled)', menu);
    const current = options.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeCustomSelect(); trigger.focus(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(current + step + options.length) % options.length]?.focus();
    }
  });
  syncCustomSelect(select);
}

function enhanceSelects(root = document) {
  $$("select:not([data-native-select])", root).forEach(enhanceSelect);
}

function settleActionDialog(value) {
  const dialog = $("#actionDialog");
  if (dialog.open) dialog.close();
  const resolve = actionResolver;
  actionResolver = null;
  resolve?.(value);
}

function openActionDialog({title, message, confirmLabel = "ç¡®è®¤", eyebrow = "CONFIRM ACTION", kind = "default", input = null}) {
  if (actionResolver) settleActionDialog(null);
  actionMode = input ? "input" : "confirm";
  $("#actionTitle").textContent = title;
  $("#actionMessage").textContent = message;
  $("#actionEyebrow").textContent = eyebrow;
  $("#actionIcon").textContent = kind === "danger" ? "!" : (input ? "âœ" : "?");
  $("#actionDialog").dataset.kind = kind;
  $("#actionConfirm").textContent = confirmLabel;
  $("#actionConfirm").className = `button ${kind === "danger" ? "danger-solid" : "primary"}`;
  $("#actionInputWrap").classList.toggle("hidden", !input);
  $("#actionInputLabel").textContent = input?.label || "åç§°";
  $("#actionInput").value = input?.value || "";
  $("#actionInput").placeholder = input?.placeholder || "";
  $("#actionInput").classList.remove("invalid");
  closeCustomSelect();
  $("#actionDialog").showModal();
  setTimeout(() => (input ? $("#actionInput") : $("#actionConfirm")).focus(), 0);
  return new Promise(resolve => { actionResolver = resolve; });
}

const confirmAction = options => openActionDialog(options).then(Boolean);
const requestText = options => openActionDialog({...options, input: options.input || {}});

async function api(path, options = {}) {
  const headers = {"Content-Type": "application/json", "X-Access-Token": token(), ...(options.headers || {})};
  const response = await fetch(path, {...options, headers});
  const data = await response.json().catch(() => ({ok: false, error: `HTTP ${response.status}`}));
  if (!response.ok || !data.ok) {
    if (response.status === 401) $("#tokenDialog").showModal();
    throw new Error(data.error || `è¯·æ±‚å¤±è´¥ (${response.status})`);
  }
  return data;
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  $("#toastStack").append(node);
  setTimeout(() => node.remove(), 4200);
}

function showDialog(dialog) {
  if (!dialog) return false;
  try {
    if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch (_error) {
    dialog.setAttribute("open", "");
  }
  return true;
}

async function openDirectoryBrowser() {
  const dialog = $("#browserDialog");
  if (!showDialog(dialog)) {
    toast("ç›®å½•æµè§ˆå™¨æ— æ³•æ‰“å¼€ï¼Œè¯·åˆ·æ–°é¡µé¢åé‡è¯•", "error");
    return;
  }
  try {
    await browse($("#pathInput").value.trim() || state.roots[0]?.path || "/data");
  } catch (error) {
    toast(error.message || "æ— æ³•è¯»å–ç›®å½•", "error");
  }
}

function setBusy(button, busy, label = "å¤„ç†ä¸­â€¦") {
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  button.disabled = busy;
  button.innerHTML = busy ? label : button.dataset.label;
}

async function bootstrap() {
  const roots = $("#rootSelect");
  const errorBox = $("#bootstrapError");
  roots.disabled = true;
  roots.innerHTML = "<option>æ­£åœ¨è¿æ¥ RenameDockâ€¦</option>";
  errorBox.classList.add("hidden");
  try {
    const data = await api("/api/bootstrap");
    state.roots = data.roots;
    state.definitions = data.rule_definitions;
    state.definitionMap = new Map(state.definitions.map(def => [def.type, def]));
    state.presets = data.presets;
    state.history = data.history;
    renderBootstrap();
    roots.disabled = false;
  } catch (error) {
    roots.innerHTML = "<option>æŒ‚è½½ç›®å½•åŠ è½½å¤±è´¥</option>";
    roots.disabled = true;
    $("#bootstrapErrorText").textContent = `åˆå§‹åŒ–å¤±è´¥ï¼š${error.message}`;
    errorBox.classList.remove("hidden");
    toast(error.message, "error");
  }
}

function renderBootstrap() {
  const roots = $("#rootSelect");
  roots.innerHTML = state.roots.map(root => `<option value="${escapeHtml(root.path)}">${escapeHtml(root.path)}</option>`).join("");
  syncCustomSelect(roots);
  if (state.roots[0]) $("#pathInput").value = state.roots[0].path;
  $("#rootCount").textContent = `${state.roots.length} ä¸ªæŒ‚è½½ç›®å½•`;
  $("#ruleTypeCount").textContent = `${state.definitions.length} TYPES`;
  renderRuleTypes();
  renderPresets();
  renderHistory();
}

function definitionDefaults(definition) {
  const params = {};
  for (const field of definition.fields || []) {
    if (field.key) params[field.key] = field.default ?? (field.kind === "bool" ? false : "");
  }
  return params;
}

function renderRuleTypes(query = "") {
  const normalized = query.trim().toLowerCase();
  const filtered = state.definitions.filter(def => `${def.label} ${def.type}`.toLowerCase().includes(normalized));
  $("#ruleTypes").innerHTML = filtered.map(def => {
    const label = def.label.replace(/\s*\([^)]*\)\s*/, "");
    return `<button class="rule-type" data-type="${escapeHtml(def.type)}"><b>${escapeHtml(label)}</b><small>${escapeHtml(def.type.toUpperCase())} ï¼‹</small></button>`;
  }).join("") || `<p class="table-empty">æ²¡æœ‰åŒ¹é…çš„è§„åˆ™</p>`;
  $$(".rule-type", $("#ruleTypes")).forEach(button => button.addEventListener("click", () => addRule(button.dataset.type)));
}

function addRule(type) {
  const definition = state.definitionMap.get(type);
  if (!definition) return;
  state.rules.push({type, enabled: true, params: definitionDefaults(definition)});
  renderRules();
  schedulePreview();
}

function optionHtml(field, current) {
  return (field.options || []).map(([value, label]) => `<option value="${escapeHtml(value)}" ${String(current) === String(value) ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function fieldHtml(field, value, ruleIndex) {
  if (field.kind === "info") return `<p class="multiline">${escapeHtml(field.label)}</p>`;
  const key = escapeHtml(field.key);
  const label = escapeHtml(field.label || field.key);
  if (field.kind === "bool") return `<label class="bool-field"><input type="checkbox" data-rule="${ruleIndex}" data-key="${key}" ${value ? "checked" : ""}>${label}</label>`;
  if (field.kind === "choice") return `<label>${label}<select data-rule="${ruleIndex}" data-key="${key}">${optionHtml(field, value)}</select></label>`;
  if (field.kind === "multiline") return `<label class="multiline">${label}<textarea rows="3" data-rule="${ruleIndex}" data-key="${key}">${escapeHtml(value)}</textarea></label>`;
  const inputType = field.kind === "int" ? "number" : "text";
  const attrs = field.kind === "int" ? `${field.min !== undefined ? `min="${field.min}"` : ""} ${field.max !== undefined ? `max="${field.max}"` : ""}` : "";
  return `<label>${label}<input type="${inputType}" ${attrs} value="${escapeHtml(value)}" data-rule="${ruleIndex}" data-key="${key}"></label>`;
}

function summarizeLocal(rule) {
  const def = state.definitionMap.get(rule.type);
  const values = Object.values(rule.params || {}).filter(value => value !== "" && value !== false).slice(0, 2);
  return values.length ? values.join(" Â· ") : (def?.description || "ç‚¹å‡»å±•å¼€é…ç½®å‚æ•°");
}

function renderRules() {
  const list = $("#ruleList");
  $("#ruleCount").textContent = `${state.rules.length} æ¡è§„åˆ™`;
  if (!state.rules.length) {
    list.className = "rule-list empty-state";
    list.innerHTML = `<div class="empty-illustration"><i></i><i></i><i></i></div><h3>ä»å·¦ä¾§æ·»åŠ ç¬¬ä¸€æ¡è§„åˆ™</h3><p>æ¨èå…ˆåšæ¸…ç†ï¼Œå†è¿›è¡Œé‡æ’ä¸åºå·å¤„ç†ã€‚</p>`;
    return;
  }
  list.className = "rule-list";
  list.innerHTML = state.rules.map((rule, index) => {
    const def = state.definitionMap.get(rule.type);
    const fields = (def?.fields || []).map(field => fieldHtml(field, rule.params[field.key], index)).join("");
    return `<article class="rule-card" data-index="${index}">
      <div class="rule-card-head">
        <span class="rule-index">${String(index + 1).padStart(2, "0")}</span>
        <div class="rule-title"><b>${escapeHtml(def?.label || rule.type)}</b><small>${escapeHtml(summarizeLocal(rule))}</small></div>
        <div class="rule-card-actions">
          <button data-action="toggle" title="å¯ç”¨/ç¦ç”¨">${rule.enabled ? "â—" : "â—‹"}</button>
          <button data-action="up" title="ä¸Šç§»">â†‘</button><button data-action="down" title="ä¸‹ç§»">â†“</button>
          <button data-action="remove" title="åˆ é™¤">Ã—</button>
        </div>
      </div><div class="rule-fields">${fields}</div>
    </article>`;
  }).join("");
  $$(".rule-card-actions button", list).forEach(button => button.addEventListener("click", () => mutateRule(Number(button.closest(".rule-card").dataset.index), button.dataset.action)));
  $$('[data-rule][data-key]', list).forEach(input => input.addEventListener("input", onRuleInput));
  $$('select[data-rule][data-key], input[type="checkbox"][data-rule]', list).forEach(input => input.addEventListener("change", onRuleInput));
  enhanceSelects(list);
}

function mutateRule(index, action) {
  if (action === "remove") state.rules.splice(index, 1);
  if (action === "toggle") state.rules[index].enabled = !state.rules[index].enabled;
  if (action === "up" && index > 0) [state.rules[index - 1], state.rules[index]] = [state.rules[index], state.rules[index - 1]];
  if (action === "down" && index < state.rules.length - 1) [state.rules[index + 1], state.rules[index]] = [state.rules[index], state.rules[index + 1]];
  renderRules(); schedulePreview();
}

function onRuleInput(event) {
  const input = event.currentTarget;
  let value = input.type === "checkbox" ? input.checked : input.value;
  if (input.type === "number" && value×¾|¶‰ËkºwµçQ…ÉĞ€¬€Äì(€€ ˆÁÉ•Ù¥•İ!¥¹Ğˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô€‘íÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ¡ôƒ¦†äƒ
Ü€‘í™¥ÉÍÑ÷ŠL‘íÉ…¹”¹•¹‘ôƒ
Ü€‘íÍÑ…Ñ”¹ÉÕ±•Ì¹±•¹Ñ¡ôƒšv‡¢–"e€ì)ô()™Õ¹Ñ¥½¸ÁÉ•Ù¥•İI½Ü¡¥Ñ•´°¥¹‘•à¤ì(€±•ĞÍÑ…ÑÕÍ±…ÍÌ€ô¥Ñ•´¹½¹™±¥Ğñğ¥Ñ•´¹•ÉÉ½È€ü€‰½¹™±¥Ğˆ€è€ˆˆì(€¥˜€¡¥Ñ•´¹‘ÕÁ±¥…Ñ•}½˜¤ÍÑ…ÑÕÍ±…ÍÌ€ô€‰‘ÕÁ±¥…Ñ”ˆì(€½¹ÍĞÍÑ…ÑÕÌ€ô¥Ñ•´¹‘ÕÁ±¥…Ñ•}½˜€ü€‹––ºç¦7–’4ˆ€è€¡¥Ñ•´¹•ÉÉ½Èñğ¥Ñ•´¹ÍÑ…ÑÕÌ¤ì(€É•ÑÕÉ¸€ñÑÈ±…ÍÌô‰ÁÉ•Ù¥•ÜµÉ½Üˆ‘…Ñ„µ¥¹‘•àôˆ‘í¥¹‘•áôˆø(€€€€ñÑøñ±…‰•°±…ÍÌô‰¡•¬ˆøñ¥¹ÁÕĞÑåÁ”ô‰¡•­‰½àˆ‘…Ñ„µ¡•¬ôˆ‘í¥¹‘•áôˆ€‘í¥Ñ•´¹¡•­•€„ôô™…±Í”€ü€‰¡•­•ˆ€è€ˆ‰ôøñÍÁ…¸øğ½ÍÁ…¸øğ½±…‰•°øğ½Ñø(€€€€ñÑøñÍÁ…¸±…ÍÌô‰™¥±”µ¹…µ”ˆÑ¥Ñ±”ôˆ‘í•Í…Á•!Ñµ°¡¥Ñ•´¹½±‘}¹…µ”¥ôˆø‘í•Í…Á•!Ñµ°¡¥Ñ•´¹½±‘}¹…µ”¥ôğ½ÍÁ…¸øğ½Ñø(€€€€ñÑ±…ÍÌô‰…ÉÉ½Üµ•±°ˆûŠHğ½Ñø(€€€€ñÑøñ¥¹ÁÕĞ±…ÍÌô‰¹•Üµ¹…µ”ˆ‘…Ñ„µ¹…µ”ôˆ‘í¥¹‘•áôˆÙ…±Õ”ôˆ‘í•Í…Á•!Ñµ°¡¥Ñ•´¹¹•İ}¹…µ”ñğ€ˆˆ¥ôˆÑ¥Ñ±”ôˆ‘í•Í…Á•!Ñµ°¡¥Ñ•´¹¹•İ}¹…µ”ñğ€ˆˆ¥ôˆÍÑå±”ô‰İ¥‘Ñ è‘í¹…µ•¥•±‘]¥‘Ñ ¡¥Ñ•´¹¹•İ}¹…µ”ñğ€ˆˆ¥õÁàˆ€‘í¥Ñ•´¹•ÉÉ½È€ü€‰‘¥Í…‰±•ˆ€è€ˆ‰ôøğ½Ñø(€€€€ñÑ±…ÍÌô‰Á…Ñ µ•±°ˆÑ¥Ñ±”ôˆ‘í•Í…Á•!Ñµ°¡¥Ñ•´¹Á…Ñ ¥ôˆø‘í•Í…Á•!Ñµ°¡¥Ñ•´¹Á…Ñ ¹ÍÕ‰ÍÑÉ¥¹œ À°¥Ñ•´¹Á…Ñ ¹±•¹Ñ €´¥Ñ•´¹½±‘}¹…µ”¹±•¹Ñ ¤¥ôğ½Ñø(€€€€ñÑøñÍÁ…¸±…ÍÌô‰ÍÑ…ÑÕÌµÁ¥±°€‘íÍÑ…ÑÕÍ±…ÍÍôˆÑ¥Ñ±”ôˆ‘í•Í…Á•!Ñµ°¡ÍÑ…ÑÕÌ¥ôˆø‘í•Í…Á•!Ñµ°¡ÍÑ…ÑÕÌ¥ôğ½ÍÁ…¸øğ½Ñø(€€ğ½ÑÈù€ì)ô()™Õ¹Ñ¥½¸¹…µ•¥•±‘]¥‘Ñ ¡Ù…±Õ”¤ì(€½¹ÍĞÕ¹¥ÑÌ€ôl¸¸¹MÑÉ¥¹œ¡Ù…±Õ”¥t¹É•‘Õ” ¡Ñ½Ñ…°°¡…É…Ñ•È¤€ôøÑ½Ñ…°€¬€¡¡…É…Ñ•È¹½‘•A½¥¹ÑĞ À¤€ø€ÈÔÔ€ü€È€è€Ä¤°€À¤ì(€É•ÑÕÉ¸5…Ñ ¹µ…à ÔØÀ°5…Ñ ¹µ¥¸ ÄØÀÀ°5…Ñ ¹É½Õ¹¡Õ¹¥ÑÌ€¨€Ü¸È€¬€ÜÈ¤¤¤ì)ô()™Õ¹Ñ¥½¸É•¹‘•ÉAÉ•Ù¥•Ü ¤ì(€½¹ÍĞ‰½‘ä€ô€ ˆÁÉ•Ù¥•İ	½‘äˆ¤ì(€¥˜€ …ÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ ¤ì(€€€‰½‘ä¹¥¹¹•É!Q50€ô€ñÑÈøñÑ½±ÍÁ…¸ôˆØˆ±…ÍÌô‰Ñ…‰±”µ•µÁÑäˆûš&¯š>?îOšzs’òkšbû’ë–r£¢şg¦0ğ½Ñøğ½ÑÈù€ì(€€€ÕÁ‘…Ñ•AÉ•Ù¥•İ!¥¹Ğ ¤ì(€€€É•ÑÕÉ¸ì(€ô(€½¹ÍĞÉ…¹”€ôÁÉ•Ù¥•İA…•I…¹” ¤ì(€½¹ÍĞÉ½İÌ€ôÍÑ…Ñ”¹¥Ñ•µÌ¹Í±¥”¡É…¹”¹ÍÑ…ÉĞ°É…¹”¹•¹¤¹µ…À ¡¥Ñ•´°½™™Í•Ğ¤€ôøÁÉ•Ù¥•İI½Ü¡¥Ñ•´°É…¹”¹ÍÑ…ÉĞ€¬½™™Í•Ğ¤¤¹©½¥¸ ˆˆ¤ì(€‰½‘ä¹¥¹¹•É!Q50€ôÉ½İÌì(€ÕÁ‘…Ñ•AÉ•Ù¥•İ!¥¹Ğ¡É…¹”¤ì)ô()™Õ¹Ñ¥½¸¡…¹•AÉ•Ù¥•İA…”¡‘•±Ñ„¤ì(€½¹ÍĞÉ…¹”€ôÁÉ•Ù¥•İA…•I…¹” ¤ì(€½¹ÍĞ¹•áĞ€ô5…Ñ ¹µ¥¸¡5…Ñ ¹µ…à À°ÍÑ…Ñ”¹ÁÉ•Ù¥•İA…”€¬‘•±Ñ„¤°É…¹”¹Á…•½Õ¹Ğ€´€Ä¤ì(€¥˜€¡¹•áĞ€ôôôÍÑ…Ñ”¹ÁÉ•Ù¥•İA…”¤É•ÑÕÉ¸ì(€ÍÑ…Ñ”¹ÁÉ•Ù¥•İA…”€ô¹•áĞì(€€ ˆ¹Ñ…‰±”µİÉ…Àˆ¤¹ÍÉ½±±Q½À€ô€Àì(€É•¹‘•ÉAÉ•Ù¥•Ü ¤ì)ô()™Õ¹Ñ¥½¸Ñ½±•AÉ•Ù¥•İM¡½İ±° ¤ì(€ÍÑ…Ñ”¹ÁÉ•Ù¥•İM¡½İ±°€ô€…ÍÑ…Ñ”¹ÁÉ•Ù¥•İM¡½İ±°ì(€ÍÑ…Ñ”¹ÁÉ•Ù¥•İA…”€ô€Àì(€€ ˆ¹Ñ…‰±”µİÉ…Àˆ¤¹ÍÉ½±±Q½À€ô€Àì(€É•¹‘•ÉAÉ•Ù¥•Ü ¤ì)ô()™Õ¹Ñ¥½¸ÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ì(€±•ĞÍ•±•Ñ•€ô€Àì(€±•Ğ¡…¹•€ô€Àì(€±•Ğ½¹™±¥ÑÌ€ô€Àì(€™½È€¡½¹ÍĞ¥Ñ•´½˜ÍÑ…Ñ”¹¥Ñ•µÌ¤ì(€€€¥˜€¡¥Ñ•´¹¡•­•€ôôô™…±Í”¤½¹Ñ¥¹Õ”ì(€€€Í•±•Ñ•€¬ô€Äì(€€€¥˜€¡¥Ñ•´¹¹•İ}¹…µ”€˜˜¥Ñ•´¹¹•İ}¹…µ”€„ôô¥Ñ•´¹½±‘}¹…µ”¤¡…¹•€¬ô€Äì(€€€¥˜€¡¥Ñ•´¹½¹™±¥Ğñğ¥Ñ•´¹•ÉÉ½È¤½¹™±¥ÑÌ€¬ô€Äì(€ô(€€ ˆµ•ÑÉ¥1½…‘•ˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ôÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ ì(€€ ˆµ•ÑÉ¥¡…¹•ˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô¡…¹•ì(€€ ˆµ•ÑÉ¥½¹™±¥ÑÌˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô½¹™±¥ÑÌì(€€ ˆÍ•±•Ñ±°ˆ¤¹¡•­•€ô	½½±•…¸¡ÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ ¤€˜˜Í•±•Ñ•€ôôôÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ ì(€€ ˆÍ•±•Ñ±°ˆ¤¹¥¹‘•Ñ•Éµ¥¹…Ñ”€ôÍ•±•Ñ•€ø€À€˜˜Í•±•Ñ•€ğÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ ì(€€ ˆ•á•ÕÑ•	ÕÑÑ½¸ˆ¤¹‘¥Í…‰±•€ôÍÑ…Ñ”¹ÁÉ•Ù¥•İ¥ÉÑäñğ¡…¹•€ôôô€Àñğ	½½±•…¸¡ÍÑ…Ñ”¹©½ˆ€˜˜l‰ÅÕ•Õ•ˆ°€‰ÉÕ¹¹¥¹œˆ°€‰Á…ÕÍ•‰t¹¥¹±Õ‘•Ì¡ÍÑ…Ñ”¹©½ˆ¹ÍÑ…Ñ”¤¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸‰É½İÍ”¡Á…Ñ ¤ì(€ÑÉäì(€€€ÍÑ…Ñ”¹‰É½İÍ”€ô…İ…¥Ğ…Á¤ ˆ½…Á¤½‰É½İÍ”ˆ°íµ•Ñ¡½è€‰A=MPˆ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡íÁ…Ñ¡ô¥ô¤ì(€€€€ ˆ‰É½İÍ•ÉÕÉÉ•¹Ğˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ôÍÑ…Ñ”¹‰É½İÍ”¹Á…Ñ ì(€€€€ ˆ‰É½İÍ•ÉUÀˆ¤¹‘¥Í…‰±•€ô€…ÍÑ…Ñ”¹‰É½İÍ”¹Á…É•¹Ğì(€€€½¹ÍĞ‘¥É•Ñ½É¥•Ì€ôÍÑ…Ñ”¹‰É½İÍ”¹•¹ÑÉ¥•Ì¹™¥±Ñ•È¡•¹ÑÉä€ôø•¹ÑÉä¹¥Í}‘¥È¤ì(€€€€ ˆ‰É½İÍ•É¹ÑÉ¥•Ìˆ¤¹¥¹¹•É!Q50€ô‘¥É•Ñ½É¥•Ì¹µ…À¡•¹ÑÉä€ôø€ñ‰ÕÑÑ½¸±…ÍÌô‰‰É½İÍ•Èµ•¹ÑÉäˆ‘…Ñ„µÁ…Ñ ôˆ‘í•Í…Á•!Ñµ°¡•¹ÑÉä¹Á…Ñ ¥ôˆøñ¤ûŠZÀğ½¤øñˆø‘í•Í…Á•!Ñµ°¡•¹ÑÉä¹¹…µ”¥ôğ½ˆøñÍµ…±°ø‘í•Í…Á•!Ñµ°¡•¹ÑÉä¹µ½‘¥™¥•¥ôğ½Íµ…±°øğ½‰ÕÑÑ½¸ù€¤¹©½¥¸ ˆˆ¤ñğ€ñÀ±…ÍÌô‰Ñ…‰±”µ•µÁÑäˆûš¶“n»–öW’â/šÊ‡šr'–¶CšZ’îÛ–’äğ½Àù€ì(€€€€ ˆ¹‰É½İÍ•Èµ•¹ÑÉäˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰‘‰±±¥¬ˆ°€ ¤€ôø‰É½İÍ”¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ğ¹Á…Ñ ¤¤¤ì(€ô…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô)ô()™Õ¹Ñ¥½¸É•¹‘•ÉAÉ•Í•ÑÌ ¤ì(€½¹ÍĞÍ•±•Ğ€ô€ ˆÁÉ•Í•ÑM•±•Ğˆ¤ì(€½¹ÍĞÕÉÉ•¹Ğ€ôÍ•±•Ğ¹Ù…±Õ”ì(€Í•±•Ğ¹¥¹¹•É!Q50€ô€ñ½ÁÑ¥½¸Ù…±Õ”ôˆˆû¦'š.§–ŞË’şw–¶cšZçš† ğ½½ÁÑ¥½¸ù€€¬=‰©•Ğ¹­•åÌ¡ÍÑ…Ñ”¹ÁÉ•Í•ÑÌ¤¹Í½ÉĞ ¤¹µ…À¡¹…µ”€ôø€ñ½ÁÑ¥½¸Ù…±Õ”ôˆ‘í•Í…Á•!Ñµ°¡¹…µ”¥ôˆø‘í•Í…Á•!Ñµ°¡¹…µ”¥ôğ½½ÁÑ¥½¸ù€¤¹©½¥¸ ˆˆ¤ì(€¥˜€¡ÍÑ…Ñ”¹ÁÉ•Í•ÑÍmÕÉÉ•¹Ñt¤Í•±•Ğ¹Ù…±Õ”€ôÕÉÉ•¹Ğì(€Íå¹ÕÍÑ½µM•±•Ğ¡Í•±•Ğ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù•AÉ•Í•Ğ ¤ì(€½¹ÍĞÍÕ•ÍÑ•€ô€ ˆÁÉ•Í•ÑM•±•Ğˆ¤¹Ù…±Õ”ì(€½¹ÍĞ¹…µ”€ô…İ…¥ĞÉ•ÅÕ•ÍÑQ•áĞ¡ì(€€€Ñ¥Ñ±”è€‹’şw–¶c¢–"gšZçš† ˆ°(€€€µ•ÍÍ…”è€‹’âë–öO–&7¢–"gšÖšÂÓêÿ¢úO–—’â’â«–ºçšbO¢¾–"¯j–B7Ãˆ°(€€€•å•‰É½Üè€‰MYAIMPˆ°(€€€½¹™¥Éµ1…‰•°è€‹’şw–¶cšZçš† ˆ°(€€€¥¹ÁÕĞèí±…‰•°è€‹šZçš†#–B7Àˆ°Ù…±Õ”èÍÕ•ÍÑ•ñğ€‹š"Gj9LƒšZçš† ˆ°Á±…•¡½±‘•Èè€‹’ú/–š¾òk¦~Ï’æCšZ’îÛšVÓB‰ô°(€ô¤ì(€¥˜€ …¹…µ”¤É•ÑÕÉ¸ì(€ÑÉäì(€€€½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤¡€½…Á¤½ÁÉ•Í•ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ğ¡¹…µ”¥õ€°íµ•Ñ¡½è€‰AUPˆ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡íÉÕ±•ÌèÍÑ…Ñ”¹ÉÕ±•Íô¥ô¤ì(€€€ÍÑ…Ñ”¹ÁÉ•Í•ÑÌ€ô‘…Ñ„¹ÁÉ•Í•ÑÌìÉ•¹‘•ÉAÉ•Í•ÑÌ ¤ì€ ˆÁÉ•Í•ÑM•±•Ğˆ¤¹Ù…±Õ”€ô¹…µ”ìÍå¹ÕÍÑ½µM•±•Ğ  ˆÁÉ•Í•ÑM•±•Ğˆ¤¤ìÑ½…ÍĞ ‹šZçš†#–ŞË’şw–¶`ˆ¤ì(€ô…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô)ô()…Íå¹Œ™Õ¹Ñ¥½¸‘•±•Ñ•AÉ•Í•Ğ ¤ì(€½¹ÍĞ¹…µ”€ô€ ˆÁÉ•Í•ÑM•±•Ğˆ¤¹Ù…±Õ”ì(€¥˜€ …¹…µ”¤ìÑ½…ÍĞ ‹¢¾ß–#¦'š.§šZçš† ˆ°€‰İ…É¸ˆ¤ìÉ•ÑÕÉ¸ìô(€¥˜€ ……İ…¥Ğ½¹™¥ÉµÑ¥½¸¡íÑ¥Ñ±”è€‹–"ƒ¦f“¢–"gšZçš† ˆ°µ•ÍÍ…”èƒšZçš†#Šp‘í¹…µ•÷Šw–"ƒ¦f“–B;š^ƒšÎWš‹–’7	€°½¹™¥Éµ1…‰•°è€‹–"ƒ¦f“šZçš† ˆ°•å•‰É½Üè€‰1QAIMPˆ°­¥¹è€‰‘…¹•È‰ô¤¤É•ÑÕÉ¸ì(€ÑÉäì½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤¡€½…Á¤½ÁÉ•Í•ÑÌ¼‘í•¹½‘•UI%½µÁ½¹•¹Ğ¡¹…µ”¥õ€°íµ•Ñ¡½è€‰1Q‰ô¤ìÍÑ…Ñ”¹ÁÉ•Í•ÑÌ€ô‘…Ñ„¹ÁÉ•Í•ÑÌìÉ•¹‘•ÉAÉ•Í•ÑÌ ¤ìÑ½…ÍĞ ‹šZçš†#–ŞË–"ƒ¦fˆ¤ìô(€…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô)ô()…Íå¹Œ™Õ¹Ñ¥½¸ÍÑ…ÉÑ)½ˆ ¤ì(€½¹ÍĞ¥Ñ•µÌ€ôÍÑ…Ñ”¹¥Ñ•µÌ¹™¥±Ñ•È¡¥Ñ•´€ôø¥Ñ•´¹¡•­•€„ôô™…±Í”€˜˜¥Ñ•´¹¹•İ}¹…µ”€˜˜¥Ñ•´¹¹•İ}¹…µ”€„ôô¥Ñ•´¹½±‘}¹…µ”¤ì(€¥˜€ …¥Ñ•µÌ¹±•¹Ñ ¤É•ÑÕÉ¸ì(€¥˜€ ……İ…¥Ğ½¹™¥ÉµÑ¥½¸¡íÑ¥Ñ±”è€‹š&Ÿ¢†3š&ç¦?¦7–F÷–B4ˆ°µ•ÍÍ…”èƒ–6Ï–Â¦7–F÷–B4€‘í¥Ñ•µÌ¹±•¹Ñ¡ôƒ’â«–¾ç¢Æ‡¾ò3¢¾ß†»¢º“¦Š¢#îOšzs–J3–Ëª¶[V—	€°½¹™¥Éµ1…‰•°è€‹†»¢º“š&Ÿ¢†0ˆ°•å•‰É½Üè€‰IU8I95)=‰ô¤¤É•ÑÕÉ¸ì(€ÑÉäì(€€€½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤ ˆ½…Á¤½©½‰Ìˆ°íµ•Ñ¡½è€‰A=MPˆ°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡í¥Ñ•µÌ°½¹™±¥Ğè€ ˆ½¹™±¥Ñ5½‘”ˆ¤¹Ù…±Õ•ô¥ô¤ì(€€€ÍÑ…Ñ”¹©½ˆ€ô‘…Ñ„¹©½ˆìÉ•¹‘•É)½ˆ ¤ìÁ½±±)½ˆ ¤ì(€ô…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô)ô()™Õ¹Ñ¥½¸É•¹‘•É)½ˆ ¤ì(€¥˜€ …ÍÑ…Ñ”¹©½ˆ¤É•ÑÕÉ¸ì(€½¹ÍĞ©½ˆ€ôÍÑ…Ñ”¹©½ˆì(€€ ˆ©½‰MÑ…Ñ”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô€¡íÅÕ•Õ•è‹–ŞËš:K¦b|ˆ±ÉÕ¹¹¥¹œè‹š¶–r£šRç–B4ˆ±Á…ÕÍ•è‹–ŞËšj–pˆ±½µÁ±•Ñ•è‹š&Ÿ¢†3–º3š"@ˆ±™…¥±•è‹š&Ÿ¢†3–’Ç¢Ò”ˆ±…¹•±±•è‹–ŞË–>[šÚ ‰ô¥m©½ˆ¹ÍÑ…Ñ•tñğ©½ˆ¹ÍÑ…Ñ”ì(€€ ˆ©½‰•Ñ…¥°ˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô©½ˆ¹•ÉÉ½Èñğ©½ˆ¹µ•ÍÍ…”ì(€½¹ÍĞÁ•É•¹Ñ…”€ô©½ˆ¹Ñ½Ñ…°€ü5…Ñ ¹É½Õ¹¡©½ˆ¹½µÁ±•Ñ•€¼©½ˆ¹Ñ½Ñ…°€¨€ÄÀÀ¤€è€Àì(€€ ˆÁÉ½É•ÍÍ	…Èˆ¤¹ÍÑå±”¹İ¥‘Ñ €ô€‘íÁ•É•¹Ñ…•ô•€ì(€½¹ÍĞ…Ñ¥Ù”€ôl‰ÅÕ•Õ•ˆ°€‰ÉÕ¹¹¥¹œˆ°€‰Á…ÕÍ•‰t¹¥¹±Õ‘•Ì¡©½ˆ¹ÍÑ…Ñ”¤ì(€€ ˆÁ…ÕÍ•)½ˆˆ¤¹±…ÍÍ1¥ÍĞ¹Ñ½±” ‰¡¥‘‘•¸ˆ°€……Ñ¥Ù”¤ì(€€ ˆ…¹•±)½ˆˆ¤¹±…ÍÍ1¥ÍĞ¹Ñ½±” ‰¡¥‘‘•¸ˆ°€……Ñ¥Ù”¤ì(€€ ˆÁ…ÕÍ•)½ˆˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô©½ˆ¹ÍÑ…Ñ”€ôôô€‰Á…ÕÍ•ˆ€ü€‹îŸî´ˆ€è€‹šj–pˆì(€€ ˆ©½‰½Ğˆ¤¹ÍÑå±”¹‰…­É½Õ¹€ô©½ˆ¹ÍÑ…Ñ”€ôôô€‰™…¥±•ˆ€ü€‰Ù…È ´µ‘…¹•È¤ˆ€è©½ˆ¹ÍÑ…Ñ”€ôôô€‰Á…ÕÍ•ˆ€ü€‰Ù…È ´µİ…É¸¤ˆ€è€‰Ù…È ´µ…•¹Ğ¤ˆì(€ÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ì)ô()™Õ¹Ñ¥½¸Á½±±)½ˆ ¤ì(€±•…ÉQ¥µ•½ÕĞ¡ÍÑ…Ñ”¹Á½±±Q¥µ•È¤ì(€¥˜€ …ÍÑ…Ñ”¹©½ˆ¤É•ÑÕÉ¸ì(€ÍÑ…Ñ”¹Á½±±Q¥µ•È€ôÍ•ÑQ¥µ•½ÕĞ¡…Íå¹Œ€ ¤€ôøì(€€€ÑÉäì(€€€€€½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤¡€½…Á¤½©½‰Ì¼‘íÍÑ…Ñ”¹©½ˆ¹¥‘õ€¤ì(€€€€€ÍÑ…Ñ”¹©½ˆ€ô‘…Ñ„¹©½ˆìÉ•¹‘•É)½ˆ ¤ì(€€€€€¥˜€¡l‰ÅÕ•Õ•ˆ°€‰ÉÕ¹¹¥¹œˆ°€‰Á…ÕÍ•‰t¹¥¹±Õ‘•Ì¡ÍÑ…Ñ”¹©½ˆ¹ÍÑ…Ñ”¤¤Á½±±)½ˆ ¤ì(€€€€€•±Í”ì(€€€€€€€¥˜€¡ÍÑ…Ñ”¹©½ˆ¹ÍÑ…Ñ”€ôôô€‰½µÁ±•Ñ•ˆ¤ìÑ½…ÍĞ¡ÍÑ…Ñ”¹©½ˆ¹µ•ÍÍ…”°ÍÑ…Ñ”¹©½ˆ¹É•ÍÕ±Ğü¹¡¥ÍÑ½Éå}İ…É¹¥¹œ€ü€‰İ…É¸ˆ€è€‰¥¹™¼ˆ¤ì…İ…¥ĞÍ…¸ ¤ì…İ…¥Ğ±½…‘!¥ÍÑ½Éä ¤ìô(€€€€€€€•±Í”Ñ½…ÍĞ¡ÍÑ…Ñ”¹©½ˆ¹•ÉÉ½ÈñğÍÑ…Ñ”¹©½ˆ¹µ•ÍÍ…”°ÍÑ…Ñ”¹©½ˆ¹ÍÑ…Ñ”€ôôô€‰™…¥±•ˆ€ü€‰•ÉÉ½Èˆ€è€‰İ…É¸ˆ¤ì(€€€€€ô(€€€ô…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô(€ô°€ÔÔÀ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸½¹ÑÉ½±)½ˆ¡…Ñ¥½¸¤ì(€¥˜€ …ÍÑ…Ñ”¹©½ˆ¤É•ÑÕÉ¸ì(€ÑÉäì½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤¡€½…Á¤½©½‰Ì¼‘íÍÑ…Ñ”¹©½ˆ¹¥‘ô¼‘í…Ñ¥½¹õ€°íµ•Ñ¡½è€‰A=MPˆ°‰½‘äè€‰íô‰ô¤ìÍÑ…Ñ”¹©½ˆ€ô‘…Ñ„¹©½ˆìÉ•¹‘•É)½ˆ ¤ì¥˜€¡…Ñ¥½¸€ôôô€‰É•ÍÕµ”ˆ¤Á½±±)½ˆ ¤ìô(€…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô)ô()…Íå¹Œ™Õ¹Ñ¥½¸±½…‘!¥ÍÑ½Éä ¤ì(€ÑÉäì½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤ ˆ½…Á¤½¡¥ÍÑ½Éäˆ¤ìÍÑ…Ñ”¹¡¥ÍÑ½Éä€ô‘…Ñ„¹¡¥ÍÑ½ÉäìÉ•¹‘•É!¥ÍÑ½Éä ¤ìô(€…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô)ô()™Õ¹Ñ¥½¸É•¹‘•É!¥ÍÑ½Éä ¤ì(€½¹ÍĞ±¥ÍĞ€ô€ ˆ¡¥ÍÑ½Éå1¥ÍĞˆ¤ì(€±¥ÍĞ¹¥¹¹•É!Q50€ôÍÑ…Ñ”¹¡¥ÍÑ½Éä¹±•¹Ñ €üÍÑ…Ñ”¹¡¥ÍÑ½Éä¹µ…À¡‰…Ñ €ôø€ñ…ÉÑ¥±”±…ÍÌô‰¡¥ÍÑ½Éäµ…Éˆøñ¡•…‘•Èøñˆø‘í•Í…Á•!Ñµ°¡‰…Ñ ¹Ñ¥µ”¥ôğ½ˆøñÍµ…±°ø‘í‰…Ñ ¹¥Ñ•µÌ¹±•¹Ñ¡ôƒ¦†äğ½Íµ…±°øğ½¡•…‘•ÈøñÀø‘í•Í…Á•!Ñµ°¡‰…Ñ ¹¥Ñ•µÍlÁtü¹Í½ÕÉ”ñğ€‹¦ëš&çš²„ˆ¥ô‘í‰…Ñ ¹¥Ñ•µÌ¹±•¹Ñ €ø€Ä€ü€ƒ¶$€‘í‰…Ñ ¹¥Ñ•µÌ¹±•¹Ñ¡ôƒ¦†å€€è€ˆ‰ôğ½Àøñ‰ÕÑÑ½¸±…ÍÌô‰‰ÕÑÑ½¸Í•½¹‘…Éä½µÁ…Ğˆ‘…Ñ„µÕ¹‘¼ôˆ‘í•Í…Á•!Ñµ°¡‰…Ñ ¹¥¥ôˆ€‘í‰…Ñ ¹Õ¹‘½¹”€ü€‰‘¥Í…‰±•ˆ€è€ˆ‰ôø‘í‰…Ñ ¹Õ¹‘½¹”€ü€‹–ŞËšJ“¦R ˆ€è€‹šJ“¦Rš¶“š&çš²„‰ôğ½‰ÕÑÑ½¸øğ½…ÉÑ¥±”ù€¤¹©½¥¸ ˆˆ¤€è€ñÀ±…ÍÌô‰Ñ…‰±”µ•µÁÑäˆû¢şcšÊ‡šr'šRç–B7–:–>Èğ½Àù€ì(€€ m‘…Ñ„µÕ¹‘½tœ°±¥ÍĞ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì(€€€¥˜€ ……İ…¥Ğ½¹™¥ÉµÑ¥½¸¡íÑ¥Ñ±”è€‹šJ“¦R¦7–F÷–B7š&çš²„ˆ°µ•ÍÍ…”è€‹–Â–Âw¢¾Wš*+š¶“š&çš²‡’â·jšZ’îÛš‹–’7’âë–:–B7Ãˆ°½¹™¥Éµ1…‰•°è€‹†»¢º“šJ“¦R ˆ°•å•‰É½Üè€‰U9<	Q ˆ°­¥¹è€‰‘…¹•È‰ô¤¤É•ÑÕÉ¸ì(€€€Í•Ñ	ÕÍä¡‰ÕÑÑ½¸°ÑÉÕ”¤ì(€€€ÑÉäì½¹ÍĞ‘…Ñ„€ô…İ…¥Ğ…Á¤¡€½…Á¤½¡¥ÍÑ½Éä¼‘í‰ÕÑÑ½¸¹‘…Ñ…Í•Ğ¹Õ¹‘½ô½Õ¹‘½€°íµ•Ñ¡½è€‰A=MPˆ°‰½‘äè€‰íô‰ô¤ìÑ½…ÍĞ¡ƒ–ŞËš‹–’4€‘í‘…Ñ„¹É•Ù•ÉÑ•‘ôƒ’â«–¾ç¢Æ…€¤ì…İ…¥Ğ±½…‘!¥ÍÑ½Éä ¤ì¥˜€¡ÍÑ…Ñ”¹¥Ñ•µÌ¹±•¹Ñ ¤…İ…¥ĞÍ…¸ ¤ìô(€€€…Ñ €¡•ÉÉ½È¤ìÑ½…ÍĞ¡•ÉÉ½È¹µ•ÍÍ…”°€‰•ÉÉ½Èˆ¤ìô™¥¹…±±äìÍ•Ñ	ÕÍä¡‰ÕÑÑ½¸°™…±Í”¤ìô(€ô¤¤ì)ô()™Õ¹Ñ¥½¸‰¥¹‘Ù•¹ÑÌ ¤ì(€€ ‰m‘…Ñ„µÑ¡•µ”µÑ½±•tˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø…ÁÁ±åQ¡•µ”¡‘½Õµ•¹Ğ¹‘½Õµ•¹Ñ±•µ•¹Ğ¹‘…Ñ…Í•Ğ¹Ñ¡•µ”€ôôô€‰±¥¡Ğˆ€ü€‰‘…É¬ˆ€è€‰±¥¡Ğˆ¤¤¤ì(€€ ˆÉ½½ÑM•±•Ğˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°•Ù•¹Ğ€ôø€ ˆÁ…Ñ¡%¹ÁÕĞˆ¤¹Ù…±Õ”€ô•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”¤ì(€€ ˆÉ•ÑÉå	½½ÑÍÑÉ…Àˆ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°‰½½ÑÍÑÉ…À¤ì(€€ ˆÍ…¹	ÕÑÑ½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°Í…¸¤ì(€€ ˆÁÉ•Ù¥•İ	ÕÑÑ½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÉ•™É•Í¡AÉ•Ù¥•Ü¡™…±Í”¤¤ì(€€ ˆÑ½±•¥±Ñ•ÉÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø€ ˆ™¥±Ñ•ÉÉ¥ˆ¤¹±…ÍÍ1¥ÍĞ¹Ñ½±” ‰½±±…ÁÍ•ˆ¤¤ì(€€ ˆÉÕ±•M•…É ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕĞˆ°•Ù•¹Ğ€ôøÉ•¹‘•ÉIÕ±•QåÁ•Ì¡•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ”¤¤ì(€€ ˆÁÉ•Í•ÑM•±•Ğˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°•Ù•¹Ğ€ôøì¥˜€¡ÍÑ…Ñ”¹ÁÉ•Í•ÑÍm•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ•t¤ìÍÑ…Ñ”¹ÉÕ±•Ì€ôÍÑÉÕÑÕÉ•‘±½¹”¡ÍÑ…Ñ”¹ÁÉ•Í•ÑÍm•Ù•¹Ğ¹Ñ…É•Ğ¹Ù…±Õ•t¤ìÉ•¹‘•ÉIÕ±•Ì ¤ìÍ¡•‘Õ±•AÉ•Ù¥•Ü ¤ìôô¤ì(€€ ˆÍ…Ù•AÉ•Í•Ğˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°Í…Ù•AÉ•Í•Ğ¤ì€ ˆ‘•±•Ñ•AÉ•Í•Ğˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°‘•±•Ñ•AÉ•Í•Ğ¤ì(€€ ˆÍ•±•Ñ±°ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°•Ù•¹Ğ€ôøìÍÑ…Ñ”¹¥Ñ•µÌ¹™½É… ¡¥Ñ•´€ôø¥Ñ•´¹¡•­•€ô•Ù•¹Ğ¹Ñ…É•Ğ¹¡•­•¤ìÉ•¹‘•ÉAÉ•Ù¥•Ü ¤ìÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ìô¤ì(€€ ˆ¥¹Ù•ÉÑM•±•Ñ¥½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøìÍÑ…Ñ”¹¥Ñ•µÌ¹™½É… ¡¥Ñ•´€ôø¥Ñ•´¹¡•­•€ô¥Ñ•´¹¡•­•€ôôô™…±Í”¤ìÉ•¹‘•ÉAÉ•Ù¥•Ü ¤ìÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ìô¤ì(€€ ˆÍ•±•ÑÕÁ±¥…Ñ•Ìˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøìÍÑ…Ñ”¹¥Ñ•µÌ¹™½É… ¡¥Ñ•´€ôø¥Ñ•´¹¡•­•€ô	½½±•…¸¡¥Ñ•´¹‘ÕÁ±¥…Ñ•}½˜¤¤ìÉ•¹‘•ÉAÉ•Ù¥•Ü ¤ìÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ìô¤ì(€€ ˆÁÉ•Ù¥•İAÉ•Øˆ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø¡…¹•AÉ•Ù¥•İA…” ´Ä¤¤ì(€€ ˆÁÉ•Ù¥•İ9•áĞˆ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø¡…¹•AÉ•Ù¥•İA…” Ä¤¤ì(€€ ˆÁÉ•Ù¥•İM¡½İ±°ˆ¤ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°Ñ½±•AÉ•Ù¥•İM¡½İ±°¤ì(€€ ˆÁÉ•Ù¥•İ	½‘äˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°•Ù•¹Ğ€ôøì(€€€½¹ÍĞ‰½à€ô•Ù•¹Ğ¹Ñ…É•Ğ¹±½Í•ÍĞ ‰m‘…Ñ„µ¡•­tˆ¤ì(€€€¥˜€ …‰½à¤É•ÑÕÉ¸ì(€€€ÍÑ…Ñ”¹¥Ñ•µÍm9Õµ‰•È¡‰½à¹‘…Ñ…Í•Ğ¹¡•¬¥t¹¡•­•€ô‰½à¹¡•­•ì(€€€ÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ì(€ô¤ì(€€ ˆÁÉ•Ù¥•İ	½‘äˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕĞˆ°•Ù•¹Ğ€ôøì(€€€½¹ÍĞ¥¹ÁÕĞ€ô•Ù•¹Ğ¹Ñ…É•Ğ¹±½Í•ÍĞ ‰m‘…Ñ„µ¹…µ•tˆ¤ì(€€€¥˜€ …¥¹ÁÕĞ¤É•ÑÕÉ¸ì(€€€½¹ÍĞ¥Ñ•´€ôÍÑ…Ñ”¹¥Ñ•µÍm9Õµ‰•È¡¥¹ÁÕĞ¹‘…Ñ…Í•Ğ¹¹…µ”¥tì(€€€¥Ñ•´¹¹•İ}¹…µ”€ô¥¹ÁÕĞ¹Ù…±Õ”ì(€€€¥Ñ•´¹ÍÑ…ÑÕÌ€ô¥¹ÁÕĞ¹Ù…±Õ”€ôôô¥Ñ•´¹½±‘}¹…µ”€ü€‹š^ƒ–>c–2Xˆ€è€‹š&/–*£’ş»šRäˆì(€€€ÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ì(€ô¤ì(€€ ˆ‰É½İÍ•	ÕÑÑ½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°•Ù•¹Ğ€ôøì•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤ì½Á•¹¥É•Ñ½Éå	É½İÍ•È ¤ìô¤ì(€€ ˆÁ…Ñ¡%¹ÁÕĞˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰‘‰±±¥¬ˆ°½Á•¹¥É•Ñ½Éå	É½İÍ•È¤ì(€€ ˆ‰É½İÍ•ÉUÀˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍÑ…Ñ”¹‰É½İÍ”ü¹Á…É•¹Ğ€˜˜‰É½İÍ”¡ÍÑ…Ñ”¹‰É½İÍ”¹Á…É•¹Ğ¤¤ì(€€ ˆ¡½½Í•¥É•Ñ½Éäˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì€ ˆÁ…Ñ¡%¹ÁÕĞˆ¤¹Ù…±Õ”€ôÍÑ…Ñ”¹‰É½İÍ”¹Á…Ñ ì€ ˆ‰É½İÍ•É¥…±½œˆ¤¹±½Í” ¤ìô¤ì(€€ ˆ•á•ÕÑ•	ÕÑÑ½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°ÍÑ…ÉÑ)½ˆ¤ì(€€ ˆÁ…ÕÍ•)½ˆˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø½¹ÑÉ½±)½ˆ¡ÍÑ…Ñ”¹©½ˆü¹ÍÑ…Ñ”€ôôô€‰Á…ÕÍ•ˆ€ü€‰É•ÍÕµ”ˆ€è€‰Á…ÕÍ”ˆ¤¤ì(€€ ˆ…¹•±)½ˆˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø½¹ÑÉ½±)½ˆ ‰…¹•°ˆ¤¤ì(€€ ˆ½Á•¹!¥ÍÑ½Éäˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì€ ˆ¡¥ÍÑ½Éå¥…±½œˆ¤¹Í¡½İ5½‘…° ¤ì…İ…¥Ğ±½…‘!¥ÍÑ½Éä ¤ìô¤ì(€€ ˆ½Á•¹Q½­•¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì€ ˆÑ½­•¹%¹ÁÕĞˆ¤¹Ù…±Õ”€ôÑ½­•¸ ¤ì€ ˆÑ½­•¹¥…±½œˆ¤¹Í¡½İ5½‘…° ¤ìô¤ì(€€ ˆÍ…Ù•Q½­•¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì±½…±MÑ½É…”¹Í•Ñ%Ñ•´ ‰É•¹…µ•‘½¬µÑ½­•¸ˆ°€ ˆÑ½­•¹%¹ÁÕĞˆ¤¹Ù…±Õ”¤ì€ ˆÑ½­•¹¥…±½œˆ¤¹±½Í” ¤ì‰½½ÑÍÑÉ…À ¤ìô¤ì(€€ ˆ…Ñ¥½¹…¹•°ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ•ÑÑ±•Ñ¥½¹¥…±½œ¡¹Õ±°¤¤ì(€€ ˆ…Ñ¥½¹±½Í”ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøÍ•ÑÑ±•Ñ¥½¹¥…±½œ¡¹Õ±°¤¤ì(€€ ˆ…Ñ¥½¹½¹™¥É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôøì(€€€¥˜€¡…Ñ¥½¹5½‘”€ôôô€‰¥¹ÁÕĞˆ¤ì(€€€€€½¹ÍĞÙ…±Õ”€ô€ ˆ…Ñ¥½¹%¹ÁÕĞˆ¤¹Ù…±Õ”¹ÑÉ¥´ ¤ì(€€€€€¥˜€ …Ù…±Õ”¤ì€ ˆ…Ñ¥½¹%¹ÁÕĞˆ¤¹±…ÍÍ1¥ÍĞ¹…‘ ‰¥¹Ù…±¥ˆ¤ì€ ˆ…Ñ¥½¹%¹ÁÕĞˆ¤¹™½ÕÌ ¤ìÉ•ÑÕÉ¸ìô(€€€€€Í•ÑÑ±•Ñ¥½¹¥…±½œ¡Ù…±Õ”¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€Í•ÑÑ±•Ñ¥½¹¥…±½œ¡ÑÉÕ”¤ì(€ô¤ì(€€ ˆ…Ñ¥½¹%¹ÁÕĞˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¥¹ÁÕĞˆ°€ ¤€ôø€ ˆ…Ñ¥½¹%¹ÁÕĞˆ¤¹±…ÍÍ1¥ÍĞ¹É•µ½Ù” ‰¥¹Ù…±¥ˆ¤¤ì(€€ ˆ…Ñ¥½¹%¹ÁÕĞˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰­•å‘½İ¸ˆ°•Ù•¹Ğ€ôøì¥˜€¡•Ù•¹Ğ¹­•ä€ôôô€‰¹Ñ•Èˆ¤ì•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤ì€ ˆ…Ñ¥½¹½¹™¥É´ˆ¤¹±¥¬ ¤ìôô¤ì(€€ ˆ…Ñ¥½¹¥…±½œˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰…¹•°ˆ°•Ù•¹Ğ€ôøì•Ù•¹Ğ¹ÁÉ•Ù•¹Ñ•™…Õ±Ğ ¤ìÍ•ÑÑ±•Ñ¥½¹¥…±½œ¡¹Õ±°¤ìô¤ì(€€ m‘…Ñ„µ±½Í•tœ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø€ ˆŒˆ€¬‰ÕÑÑ½¸¹‘…Ñ…Í•Ğ¹±½Í”¤¹±½Í” ¤¤¤ì(€€ ‰‘¥…±½œˆ¤¹™½É… ¡‘¥…±½œ€ôø‘¥…±½œ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°•Ù•¹Ğ€ôøì(€€€¥˜€¡•Ù•¹Ğ¹Ñ…É•Ğ€„ôô‘¥…±½œ¤É•ÑÕÉ¸ì(€€€¥˜€¡‘¥…±½œ¹¥€ôôô€‰…Ñ¥½¹¥…±½œˆ¤Í•ÑÑ±•Ñ¥½¹¥…±½œ¡¹Õ±°¤ì•±Í”‘¥…±½œ¹±½Í” ¤ì(€ô¤¤ì(€€ ˆ¹¹…Øµ¥Ñ•´ˆ¤¹™½É… ¡‰ÕÑÑ½¸€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø€ ˆŒˆ€¬‰ÕÑÑ½¸¹‘…Ñ…Í•Ğ¹©ÕµÀ¤¹ÍÉ½±±%¹Ñ½Y¥•Ü¡í‰•¡…Ù¥½Èè‰Íµ½½Ñ ‰ô¤¤¤ì(€‘½Õµ•¹Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°±½Í•ÕÍÑ½µM•±•Ğ¤ì(€‘½Õµ•¹Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰¡…¹”ˆ°•Ù•¹Ğ€ôøì¥˜€¡•Ù•¹Ğ¹Ñ…É•Ğ¹µ…Ñ¡•Ìü¸ ‰Í•±•Ğ¹¹…Ñ¥Ù”µÍ•±•Ğˆ¤¤Íå¹ÕÍÑ½µM•±•Ğ¡•Ù•¹Ğ¹Ñ…É•Ğ¤ìô¤ì(€‘½Õµ•¹Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰­•å‘½İ¸ˆ°•Ù•¹Ğ€ôøì¥˜€¡•Ù•¹Ğ¹­•ä€ôôô€‰Í…Á”ˆ€˜˜½Á•¹M•±•ÑM¡•±°¤±½Í•ÕÍÑ½µM•±•Ğ ¤ìô¤ì(€İ¥¹‘½Ü¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰É•Í¥é”ˆ°±½Í•ÕÍÑ½µM•±•Ğ¤ì(€Í•Ñ%¹Ñ•ÉÙ…°  ¤€ôø€ ˆ±½¬ˆ¤¹Ñ•áÑ½¹Ñ•¹Ğ€ô¹•Ü…Ñ” ¤¹Ñ½1½…±•Q¥µ•MÑÉ¥¹œ ‰é µ8ˆ°í¡½ÕÈèˆÈµ‘¥¥Ğˆ±µ¥¹ÕÑ”èˆÈµ‘¥¥Ğ‰ô¤°€ÄÀÀÀ¤ì(€¥˜€¡‘½Õµ•¹Ğ¹‰½‘ä¹‘…Ñ…Í•Ğ¹Ñ½­•¹I•ÅÕ¥É•€ôôô€‰ÑÉÕ”ˆ€˜˜€…Ñ½­•¸ ¤¤€ ˆÑ½­•¹¥…±½œˆ¤¹Í¡½İ5½‘…° ¤ì)ô()‘½Õµ•¹Ğ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰=5½¹Ñ•¹Ñ1½…‘•ˆ°€ ¤€ôøì¥¹¥ÑQ¡•µ” ¤ì•¹¡…¹•M•±•ÑÌ ¤ì‰¥¹‘Ù•¹ÑÌ ¤ì‰½½ÑÍÑÉ…À ¤ìÉ•¹‘•ÉIÕ±•Ì ¤ìÉ•¹‘•ÉAÉ•Ù¥•Ü ¤ìÕÁ‘…Ñ•5•ÑÉ¥Ì ¤ìô¤ì(