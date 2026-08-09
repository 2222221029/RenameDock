const state = {
  roots: [], definitions: [], definitionMap: new Map(), rules: [], items: [],
  presets: {}, history: [], browse: null, job: null, pollTimer: null, previewTimer: null,
  previewController: null, previewRevision: 0, previewDirty: false, renderFrame: null,
};

const PREVIEW_ROW_HEIGHT = 55;
const PREVIEW_OVERSCAN = 12;
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
  $("#themeIcon").textContent = light ? "☾" : "☀";
  $("#themeToggle").title = light ? "切换深色模式" : "切换浅色模式";
  $("#themeToggle").setAttribute("aria-label", light ? "切换深色模式" : "切换浅色模式");
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
  label.textContent = selected?.textContent || "请选择";
  trigger.disabled = select.disabled;
  menu.innerHTML = [...select.options].map((option, index) => (
    `<button type="button" role="option" data-option="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}>` +
      `<span>${escapeHtml(option.textContent)}</span>${option.selected ? "<i>✓</i>" : ""}</button>`
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
  trigger.innerHTML = `<span class="select-value"></span><i aria-hidden="true">⌄</i>`;
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
  $$("select", root).forEach(enhanceSelect);
}

function settleActionDialog(value) {
  const dialog = $("#actionDialog");
  if (dialog.open) dialog.close();
  const resolve = actionResolver;
  actionResolver = null;
  resolve?.(value);
}

function openActionDialog({title, message, confirmLabel = "确认", eyebrow = "CONFIRM ACTION", kind = "default", input = null}) {
  if (actionResolver) settleActionDialog(null);
  actionMode = input ? "input" : "confirm";
  $("#actionTitle").textContent = title;
  $("#actionMessage").textContent = message;
  $("#actionEyebrow").textContent = eyebrow;
  $("#actionIcon").textContent = kind === "danger" ? "!" : (input ? "✎" : "?");
  $("#actionDialog").dataset.kind = kind;
  $("#actionConfirm").textContent = confirmLabel;
  $("#actionConfirm").className = `button ${kind === "danger" ? "danger-solid" : "primary"}`;
  $("#actionInputWrap").classList.toggle("hidden", !input);
  $("#actionInputLabel").textContent = input?.label || "名称";
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
    throw new Error(data.error || `请求失败 (${response.status})`);
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

function setBusy(button, busy, label = "处理中…") {
  if (!button.dataset.label) button.dataset.label = button.innerHTML;
  button.disabled = busy;
  button.innerHTML = busy ? label : button.dataset.label;
}

async function bootstrap() {
  try {
    const data = await api("/api/bootstrap");
    state.roots = data.roots;
    state.definitions = data.rule_definitions;
    state.definitionMap = new Map(state.definitions.map(def => [def.type, def]));
    state.presets = data.presets;
    state.history = data.history;
    renderBootstrap();
  } catch (error) {
    toast(error.message, "error");
  }
}

function renderBootstrap() {
  const roots = $("#rootSelect");
  roots.innerHTML = state.roots.map(root => `<option value="${escapeHtml(root.path)}">${escapeHtml(root.name)}</option>`).join("");
  syncCustomSelect(roots);
  if (state.roots[0]) $("#pathInput").value = state.roots[0].path;
  $("#rootCount").textContent = `${state.roots.length} 个挂载目录`;
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
    return `<button class="rule-type" data-type="${escapeHtml(def.type)}"><b>${escapeHtml(label)}</b><small>${escapeHtml(def.type.toUpperCase())} ＋</small></button>`;
  }).join("") || `<p class="table-empty">没有匹配的规则</p>`;
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
  return values.length ? values.join(" · ") : (def?.description || "点击展开配置参数");
}

function renderRules() {
  const list = $("#ruleList");
  $("#ruleCount").textContent = `${state.rules.length} 条规则`;
  if (!state.rules.length) {
    list.className = "rule-list empty-state";
    list.innerHTML = `<div class="empty-illustration"><i></i><i></i><i></i></div><h3>从左侧添加第一条规则</h3><p>推荐先做清理，再进行重排与序号处理。</p>`;
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
          <button data-action="toggle" title="启用/禁用">${rule.enabled ? "●" : "○"}</button>
          <button data-action="up" title="上移">↑</button><button data-action="down" title="下移">↓</button>
          <button data-action="remove" title="删除">×</button>
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
  if (input.type === "number" && value !== "") value = Number(value);
  state.rules[Number(input.dataset.rule)].params[input.dataset.key] = value;
  const subtitle = input.closest(".rule-card").querySelector(".rule-title small");
  subtitle.textContent = summarizeLocal(state.rules[Number(input.dataset.rule)]);
  schedulePreview();
}

function scanOptions() {
  return {
    path: $("#pathInput").value.trim(), recursive: $("#recursive").checked,
    include_dirs: $("#includeDirs").checked, include_hidden: $("#includeHidden").checked,
    extensions: $("#extensions").value, name_regex: $("#nameRegex").value,
    min_size: $("#minSize").value, max_size: $("#maxSize").value,
    after: $("#after").value, before: $("#before").value, sort: $("#sort").value,
    deduplicate: $("#deduplicate").checked,
  };
}

async function scan() {
  const button = $("#scanButton"); setBusy(button, true, "扫描中…");
  try {
    state.previewController?.abort();
    const data = await api("/api/scan", {method: "POST", body: JSON.stringify(scanOptions())});
    state.items = data.items.map(item => ({...item, status: "无变化"}));
    state.previewDirty = state.rules.some(rule => rule.enabled !== false);
    $(".table-wrap").scrollTop = 0;
    $("#metricPath").textContent = $("#pathInput").value;
    toast(`已载入 ${data.count} 个对象`);
    renderPreview();
    updateMetrics();
    if (state.rules.some(rule => rule.enabled !== false)) refreshPreview(true);
    document.querySelector("#review").scrollIntoView({behavior: "smooth", block: "start"});
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(button, false); updateMetrics(); }
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  if (!state.items.length) return;
  state.previewDirty = true;
  updateMetrics();
  if (state.items.length > AUTO_PREVIEW_LIMIT) {
    state.previewController?.abort();
    updatePreviewHint();
    return;
  }
  state.previewTimer = setTimeout(() => refreshPreview(true), 700);
}

async function refreshPreview(silent = false) {
  if (!state.items.length) { if (!silent) toast("请先扫描文件", "warn"); return; }
  if (!state.rules.some(rule => rule.enabled !== false)) {
    state.previewController?.abort();
    state.items = state.items.map(item => ({
      ...item, new_name: item.old_name, status: "无变化", conflict: false, error: undefined,
    }));
    state.previewDirty = false;
    renderPreview(); updateMetrics();
    return;
  }
  state.previewController?.abort();
  const controller = new AbortController();
  const revision = ++state.previewRevision;
  state.previewController = controller;
  const previous = new Map(state.items.map(item => [item.path, item.checked !== false]));
  $("#previewHint").textContent = `正在生成 ${state.items.length} 项预览…`;
  try {
    const data = await api("/api/preview", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({paths: state.items.map(item => item.path), rules: state.rules}),
    });
    if (revision !== state.previewRevision) return;
    state.items = data.items.map(item => ({...item, checked: previous.get(item.path) ?? true}));
    state.previewDirty = false;
    renderPreview(); updateMetrics();
  } catch (error) {
    if (error.name !== "AbortError" && !silent) toast(error.message, "error");
  } finally {
    if (revision === state.previewRevision) {
      state.previewController = null;
      updatePreviewHint();
    }
  }
}

function previewWindow() {
  const wrap = $(".table-wrap");
  const visibleRows = Math.ceil((wrap.clientHeight || 590) / PREVIEW_ROW_HEIGHT);
  const start = Math.max(0, Math.floor(wrap.scrollTop / PREVIEW_ROW_HEIGHT) - PREVIEW_OVERSCAN);
  const end = Math.min(state.items.length, start + visibleRows + PREVIEW_OVERSCAN * 2);
  return {start, end};
}

function updatePreviewHint(windowRange = previewWindow()) {
  if (!state.items.length) {
    $("#previewHint").textContent = "请先扫描文件";
    return;
  }
  if (state.previewController) {
    $("#previewHint").textContent = `正在生成 ${state.items.length} 项预览…`;
    return;
  }
  if (state.previewDirty) {
    $("#previewHint").textContent = `${state.items.length} 项 · 规则已更改，请点击刷新预览`;
    return;
  }
  const first = windowRange.start + 1;
  $("#previewHint").textContent = `${state.items.length} 项 · 显示 ${first}–${windowRange.end} · ${state.rules.length} 条规则`;
}

function previewRow(item, index) {
  let statusClass = item.conflict || item.error ? "conflict" : "";
  if (item.duplicate_of) statusClass = "duplicate";
  const status = item.duplicate_of ? "内容重复" : (item.error || item.status);
  return `<tr class="preview-row" data-index="${index}">
    <td><label class="check"><input type="checkbox" data-check="${index}" ${item.checked !== false ? "checked" : ""}><span></span></label></td>
    <td><span class="file-name" title="${escapeHtml(item.old_name)}">${escapeHtml(item.old_name)}</span></td>
    <td class="arrow-cell">→</td>
    <td><input class="new-name" data-name="${index}" value="${escapeHtml(item.new_name || "")}" ${item.error ? "disabled" : ""}></td>
    <td class="path-cell" title="${escapeHtml(item.path)}">${escapeHtml(item.path.substring(0, item.path.length - item.old_name.length))}</td>
    <td><span class="status-pill ${statusClass}" title="${escapeHtml(status)}">${escapeHtml(status)}</span></td>
  </tr>`;
}

function renderPreview() {
  const body = $("#previewBody");
  if (!state.items.length) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty">扫描结果会显示在这里</td></tr>`;
    updatePreviewHint();
    return;
  }
  const range = previewWindow();
  const top = range.start * PREVIEW_ROW_HEIGHT;
  const bottom = (state.items.length - range.end) * PREVIEW_ROW_HEIGHT;
  const rows = state.items.slice(range.start, range.end).map((item, offset) => previewRow(item, range.start + offset)).join("");
  body.innerHTML = `${top ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="6" style="height:${top}px"></td></tr>` : ""}${rows}${bottom ? `<tr class="virtual-spacer" aria-hidden="true"><td colspan="6" style="height:${bottom}px"></td></tr>` : ""}`;
  updatePreviewHint(range);
}

function schedulePreviewRender() {
  if (state.renderFrame) return;
  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    renderPreview();
  });
}

function updateMetrics() {
  let selected = 0;
  let changed = 0;
  let conflicts = 0;
  for (const item of state.items) {
    if (item.checked === false) continue;
    selected += 1;
    if (item.new_name && item.new_name !== item.old_name) changed += 1;
    if (item.conflict || item.error) conflicts += 1;
  }
  $("#metricLoaded").textContent = state.items.length;
  $("#metricChanged").textContent = changed;
  $("#metricConflicts").textContent = conflicts;
  $("#selectAll").checked = Boolean(state.items.length) && selected === state.items.length;
  $("#selectAll").indeterminate = selected > 0 && selected < state.items.length;
  $("#executeButton").disabled = state.previewDirty || changed === 0 || Boolean(state.job && ["queued", "running", "paused"].includes(state.job.state));
}

async function browse(path) {
  try {
    state.browse = await api("/api/browse", {method: "POST", body: JSON.stringify({path})});
    $("#browserCurrent").textContent = state.browse.path;
    $("#browserUp").disabled = !state.browse.parent;
    const directories = state.browse.entries.filter(entry => entry.is_dir);
    $("#browserEntries").innerHTML = directories.map(entry => `<button class="browser-entry" data-path="${escapeHtml(entry.path)}"><i>▰</i><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(entry.modified)}</small></button>`).join("") || `<p class="table-empty">此目录下没有子文件夹</p>`;
    $$(".browser-entry").forEach(button => button.addEventListener("dblclick", () => browse(button.dataset.path)));
  } catch (error) { toast(error.message, "error"); }
}

function renderPresets() {
  const select = $("#presetSelect");
  const current = select.value;
  select.innerHTML = `<option value="">选择已保存方案</option>` + Object.keys(state.presets).sort().map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  if (state.presets[current]) select.value = current;
  syncCustomSelect(select);
}

async function savePreset() {
  const suggested = $("#presetSelect").value;
  const name = await requestText({
    title: "保存规则方案",
    message: "为当前规则流水线输入一个容易识别的名称。",
    eyebrow: "SAVE PRESET",
    confirmLabel: "保存方案",
    input: {label: "方案名称", value: suggested || "我的 NAS 方案", placeholder: "例如：音乐文件整理"},
  });
  if (!name) return;
  try {
    const data = await api(`/api/presets/${encodeURIComponent(name)}`, {method: "PUT", body: JSON.stringify({rules: state.rules})});
    state.presets = data.presets; renderPresets(); $("#presetSelect").value = name; syncCustomSelect($("#presetSelect")); toast("方案已保存");
  } catch (error) { toast(error.message, "error"); }
}

async function deletePreset() {
  const name = $("#presetSelect").value;
  if (!name) { toast("请先选择方案", "warn"); return; }
  if (!await confirmAction({title: "删除规则方案", message: `方案“${name}”删除后无法恢复。`, confirmLabel: "删除方案", eyebrow: "DELETE PRESET", kind: "danger"})) return;
  try { const data = await api(`/api/presets/${encodeURIComponent(name)}`, {method: "DELETE"}); state.presets = data.presets; renderPresets(); toast("方案已删除"); }
  catch (error) { toast(error.message, "error"); }
}

async function startJob() {
  const items = state.items.filter(item => item.checked !== false && item.new_name && item.new_name !== item.old_name);
  if (!items.length) return;
  if (!await confirmAction({title: "执行批量重命名", message: `即将重命名 ${items.length} 个对象，请确认预览结果和冲突策略。`, confirmLabel: "确认执行", eyebrow: "RUN RENAME JOB"})) return;
  try {
    const data = await api("/api/jobs", {method: "POST", body: JSON.stringify({items, conflict: $("#conflictMode").value})});
    state.job = data.job; renderJob(); pollJob();
  } catch (error) { toast(error.message, "error"); }
}

function renderJob() {
  if (!state.job) return;
  const job = state.job;
  $("#jobState").textContent = ({queued:"已排队",running:"正在改名",paused:"已暂停",completed:"执行完成",failed:"执行失败",cancelled:"已取消"})[job.state] || job.state;
  $("#jobDetail").textContent = job.error || job.message;
  const percentage = job.total ? Math.round(job.completed / job.total * 100) : 0;
  $("#progressBar").style.width = `${percentage}%`;
  const active = ["queued", "running", "paused"].includes(job.state);
  $("#pauseJob").classList.toggle("hidden", !active);
  $("#cancelJob").classList.toggle("hidden", !active);
  $("#pauseJob").textContent = job.state === "paused" ? "继续" : "暂停";
  $("#jobDot").style.background = job.state === "failed" ? "var(--danger)" : job.state === "paused" ? "var(--warn)" : "var(--accent)";
  updateMetrics();
}

function pollJob() {
  clearTimeout(state.pollTimer);
  if (!state.job) return;
  state.pollTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/jobs/${state.job.id}`);
      state.job = data.job; renderJob();
      if (["queued", "running", "paused"].includes(state.job.state)) pollJob();
      else {
        if (state.job.state === "completed") { toast(state.job.message, state.job.result?.history_warning ? "warn" : "info"); await scan(); await loadHistory(); }
        else toast(state.job.error || state.job.message, state.job.state === "failed" ? "error" : "warn");
      }
    } catch (error) { toast(error.message, "error"); }
  }, 550);
}

async function controlJob(action) {
  if (!state.job) return;
  try { const data = await api(`/api/jobs/${state.job.id}/${action}`, {method: "POST", body: "{}"}); state.job = data.job; renderJob(); if (action === "resume") pollJob(); }
  catch (error) { toast(error.message, "error"); }
}

async function loadHistory() {
  try { const data = await api("/api/history"); state.history = data.history; renderHistory(); }
  catch (error) { toast(error.message, "error"); }
}

function renderHistory() {
  const list = $("#historyList");
  list.innerHTML = state.history.length ? state.history.map(batch => `<article class="history-card"><header><b>${escapeHtml(batch.time)}</b><small>${batch.items.length} 项</small></header><p>${escapeHtml(batch.items[0]?.source || "空批次")}${batch.items.length > 1 ? ` 等 ${batch.items.length} 项` : ""}</p><button class="button secondary compact" data-undo="${escapeHtml(batch.id)}" ${batch.undone ? "disabled" : ""}>${batch.undone ? "已撤销" : "撤销此批次"}</button></article>`).join("") : `<p class="table-empty">还没有改名历史</p>`;
  $$('[data-undo]', list).forEach(button => button.addEventListener("click", async () => {
    if (!await confirmAction({title: "撤销重命名批次", message: "将尝试把此批次中的文件恢复为原名称。", confirmLabel: "确认撤销", eyebrow: "UNDO BATCH", kind: "danger"})) return;
    setBusy(button, true);
    try { const data = await api(`/api/history/${button.dataset.undo}/undo`, {method: "POST", body: "{}"}); toast(`已恢复 ${data.reverted} 个对象`); await loadHistory(); if (state.items.length) await scan(); }
    catch (error) { toast(error.message, "error"); } finally { setBusy(button, false); }
  }));
}

function bindEvents() {
  $("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("#rootSelect").addEventListener("change", event => $("#pathInput").value = event.target.value);
  $("#scanButton").addEventListener("click", scan);
  $("#previewButton").addEventListener("click", () => refreshPreview(false));
  $("#toggleFilters").addEventListener("click", () => $("#filterGrid").classList.toggle("collapsed"));
  $("#ruleSearch").addEventListener("input", event => renderRuleTypes(event.target.value));
  $("#presetSelect").addEventListener("change", event => { if (state.presets[event.target.value]) { state.rules = structuredClone(state.presets[event.target.value]); renderRules(); schedulePreview(); } });
  $("#savePreset").addEventListener("click", savePreset); $("#deletePreset").addEventListener("click", deletePreset);
  $("#selectAll").addEventListener("change", event => { state.items.forEach(item => item.checked = event.target.checked); renderPreview(); updateMetrics(); });
  $("#invertSelection").addEventListener("click", () => { state.items.forEach(item => item.checked = item.checked === false); renderPreview(); updateMetrics(); });
  $("#selectDuplicates").addEventListener("click", () => { state.items.forEach(item => item.checked = Boolean(item.duplicate_of)); renderPreview(); updateMetrics(); });
  $(".table-wrap").addEventListener("scroll", schedulePreviewRender, {passive: true});
  $("#previewBody").addEventListener("change", event => {
    const box = event.target.closest("[data-check]");
    if (!box) return;
    state.items[Number(box.dataset.check)].checked = box.checked;
    updateMetrics();
  });
  $("#previewBody").addEventListener("input", event => {
    const input = event.target.closest("[data-name]");
    if (!input) return;
    const item = state.items[Number(input.dataset.name)];
    item.new_name = input.value;
    item.status = input.value === item.old_name ? "无变化" : "手动修改";
    updateMetrics();
  });
  $("#browseButton").addEventListener("click", async () => { $("#browserDialog").showModal(); await browse($("#pathInput").value); });
  $("#browserUp").addEventListener("click", () => state.browse?.parent && browse(state.browse.parent));
  $("#chooseDirectory").addEventListener("click", () => { $("#pathInput").value = state.browse.path; $("#browserDialog").close(); });
  $("#executeButton").addEventListener("click", startJob);
  $("#pauseJob").addEventListener("click", () => controlJob(state.job?.state === "paused" ? "resume" : "pause"));
  $("#cancelJob").addEventListener("click", () => controlJob("cancel"));
  $("#openHistory").addEventListener("click", async () => { $("#historyDialog").showModal(); await loadHistory(); });
  $("#openToken").addEventListener("click", () => { $("#tokenInput").value = token(); $("#tokenDialog").showModal(); });
  $("#saveToken").addEventListener("click", () => { localStorage.setItem("renamedock-token", $("#tokenInput").value); $("#tokenDialog").close(); bootstrap(); });
  $("#actionCancel").addEventListener("click", () => settleActionDialog(null));
  $("#actionClose").addEventListener("click", () => settleActionDialog(null));
  $("#actionConfirm").addEventListener("click", () => {
    if (actionMode === "input") {
      const value = $("#actionInput").value.trim();
      if (!value) { $("#actionInput").classList.add("invalid"); $("#actionInput").focus(); return; }
      settleActionDialog(value);
      return;
    }
    settleActionDialog(true);
  });
  $("#actionInput").addEventListener("input", () => $("#actionInput").classList.remove("invalid"));
  $("#actionInput").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); $("#actionConfirm").click(); } });
  $("#actionDialog").addEventListener("cancel", event => { event.preventDefault(); settleActionDialog(null); });
  $$('[data-close]').forEach(button => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
  $$("dialog").forEach(dialog => dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    if (dialog.id === "actionDialog") settleActionDialog(null); else dialog.close();
  }));
  $$(".nav-item").forEach(button => button.addEventListener("click", () => $("#" + button.dataset.jump).scrollIntoView({behavior:"smooth"})));
  document.addEventListener("click", closeCustomSelect);
  document.addEventListener("change", event => { if (event.target.matches?.("select.native-select")) syncCustomSelect(event.target); });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && openSelectShell) closeCustomSelect(); });
  window.addEventListener("resize", closeCustomSelect);
  setInterval(() => $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit"}), 1000);
  if (document.body.dataset.tokenRequired === "true" && !token()) $("#tokenDialog").showModal();
}

document.addEventListener("DOMContentLoaded", () => { initTheme(); enhanceSelects(); bindEvents(); bootstrap(); renderRules(); renderPreview(); updateMetrics(); });

