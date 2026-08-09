const state = {
  roots: [], definitions: [], definitionMap: new Map(), rules: [], items: [],
  presets: {}, history: [], browse: null, job: null, pollTimer: null, previewTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const token = () => localStorage.getItem("renamedock-token") || "";

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
    const data = await api("/api/scan", {method: "POST", body: JSON.stringify(scanOptions())});
    state.items = data.items;
    $("#metricPath").textContent = $("#pathInput").value;
    toast(`已载入 ${data.count} 个对象`);
    await refreshPreview(false);
    document.querySelector("#review").scrollIntoView({behavior: "smooth", block: "start"});
  } catch (error) { toast(error.message, "error"); }
  finally { setBusy(button, false); updateMetrics(); }
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  if (!state.items.length) return;
  state.previewTimer = setTimeout(() => refreshPreview(true), 500);
}

async function refreshPreview(silent = false) {
  if (!state.items.length) { if (!silent) toast("请先扫描文件", "warn"); return; }
  const previous = new Map(state.items.map(item => [item.path, item.checked !== false]));
  try {
    const data = await api("/api/preview", {method: "POST", body: JSON.stringify({paths: state.items.map(item => item.path), rules: state.rules})});
    state.items = data.items.map(item => ({...item, checked: previous.get(item.path) ?? true}));
    renderPreview(); updateMetrics();
    $("#previewHint").textContent = `${state.items.length} 项 · ${state.rules.length} 条规则`;
  } catch (error) { if (!silent) toast(error.message, "error"); }
}

function renderPreview() {
  const body = $("#previewBody");
  if (!state.items.length) { body.innerHTML = `<tr><td colspan="6" class="table-empty">扫描结果会显示在这里</td></tr>`; return; }
  body.innerHTML = state.items.map((item, index) => {
    let statusClass = item.conflict || item.error ? "conflict" : "";
    if (item.duplicate_of) statusClass = "duplicate";
    const status = item.duplicate_of ? "内容重复" : (item.error || item.status);
    return `<tr data-index="${index}">
      <td><label class="check"><input type="checkbox" data-check="${index}" ${item.checked !== false ? "checked" : ""}><span></span></label></td>
      <td><span class="file-name" title="${escapeHtml(item.old_name)}">${escapeHtml(item.old_name)}</span></td>
      <td class="arrow-cell">→</td>
      <td><input class="new-name" data-name="${index}" value="${escapeHtml(item.new_name || "")}" ${item.error ? "disabled" : ""}></td>
      <td class="path-cell" title="${escapeHtml(item.path)}">${escapeHtml(item.path.substring(0, item.path.length - item.old_name.length))}</td>
      <td><span class="status-pill ${statusClass}" title="${escapeHtml(status)}">${escapeHtml(status)}</span></td>
    </tr>`;
  }).join("");
  $$('[data-check]', body).forEach(box => box.addEventListener("change", () => { state.items[Number(box.dataset.check)].checked = box.checked; updateMetrics(); }));
  $$('[data-name]', body).forEach(input => input.addEventListener("input", () => { const item = state.items[Number(input.dataset.name)]; item.new_name = input.value; item.status = input.value === item.old_name ? "无变化" : "手动修改"; updateMetrics(); }));
}

function updateMetrics() {
  const selected = state.items.filter(item => item.checked !== false);
  const changed = selected.filter(item => item.new_name && item.new_name !== item.old_name);
  const conflicts = selected.filter(item => item.conflict || item.error);
  $("#metricLoaded").textContent = state.items.length;
  $("#metricChanged").textContent = changed.length;
  $("#metricConflicts").textContent = conflicts.length;
  $("#executeButton").disabled = changed.length === 0 || Boolean(state.job && ["queued", "running", "paused"].includes(state.job.state));
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
}

async function savePreset() {
  const suggested = $("#presetSelect").value;
  const name = window.prompt("方案名称", suggested || "我的 NAS 方案");
  if (!name) return;
  try {
    const data = await api(`/api/presets/${encodeURIComponent(name)}`, {method: "PUT", body: JSON.stringify({rules: state.rules})});
    state.presets = data.presets; renderPresets(); $("#presetSelect").value = name; toast("方案已保存");
  } catch (error) { toast(error.message, "error"); }
}

async function deletePreset() {
  const name = $("#presetSelect").value;
  if (!name) { toast("请先选择方案", "warn"); return; }
  if (!confirm(`删除方案“${name}”？`)) return;
  try { const data = await api(`/api/presets/${encodeURIComponent(name)}`, {method: "DELETE"}); state.presets = data.presets; renderPresets(); toast("方案已删除"); }
  catch (error) { toast(error.message, "error"); }
}

async function startJob() {
  const items = state.items.filter(item => item.checked !== false && item.new_name && item.new_name !== item.old_name);
  if (!items.length) return;
  if (!confirm(`即将重命名 ${items.length} 个对象。确认执行？`)) return;
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
    if (!confirm("撤销此批次并恢复原名称？")) return;
    setBusy(button, true);
    try { const data = await api(`/api/history/${button.dataset.undo}/undo`, {method: "POST", body: "{}"}); toast(`已恢复 ${data.reverted} 个对象`); await loadHistory(); if (state.items.length) await scan(); }
    catch (error) { toast(error.message, "error"); } finally { setBusy(button, false); }
  }));
}

function bindEvents() {
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
  $("#browseButton").addEventListener("click", async () => { $("#browserDialog").showModal(); await browse($("#pathInput").value); });
  $("#browserUp").addEventListener("click", () => state.browse?.parent && browse(state.browse.parent));
  $("#chooseDirectory").addEventListener("click", () => { $("#pathInput").value = state.browse.path; $("#browserDialog").close(); });
  $("#executeButton").addEventListener("click", startJob);
  $("#pauseJob").addEventListener("click", () => controlJob(state.job?.state === "paused" ? "resume" : "pause"));
  $("#cancelJob").addEventListener("click", () => controlJob("cancel"));
  $("#openHistory").addEventListener("click", async () => { $("#historyDialog").showModal(); await loadHistory(); });
  $("#openToken").addEventListener("click", () => { $("#tokenInput").value = token(); $("#tokenDialog").showModal(); });
  $("#saveToken").addEventListener("click", () => { localStorage.setItem("renamedock-token", $("#tokenInput").value); $("#tokenDialog").close(); bootstrap(); });
  $$('[data-close]').forEach(button => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
  $$(".nav-item").forEach(button => button.addEventListener("click", () => $("#" + button.dataset.jump).scrollIntoView({behavior:"smooth"})));
  setInterval(() => $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", {hour:"2-digit",minute:"2-digit"}), 1000);
  if (document.body.dataset.tokenRequired === "true" && !token()) $("#tokenDialog").showModal();
}

document.addEventListener("DOMContentLoaded", () => { bindEvents(); bootstrap(); renderRules(); renderPreview(); updateMetrics(); });

