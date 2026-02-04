// DB Backup — Web UI

let currentConfig = null;
let statusPollInterval = null;

// --- Cron validation & preview ---

const CRON_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

const MONTH_NAMES_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES_MAP = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_LABELS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function resolveAlias(val, fieldIndex) {
  const lower = val.toLowerCase();
  if (fieldIndex === 3 && MONTH_NAMES_MAP[lower] !== undefined) return MONTH_NAMES_MAP[lower];
  if (fieldIndex === 4 && DOW_NAMES_MAP[lower] !== undefined) return DOW_NAMES_MAP[lower];
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function validateCronField(field, range, fieldIndex) {
  if (!field) return `Empty value in ${range.name}`;
  const fieldSpan = range.max - range.min + 1;
  const parts = field.split(",");
  for (const part of parts) {
    if (!part) return `Empty value in list for ${range.name}`;
    const stepParts = part.split("/");
    if (stepParts.length > 2) return `Invalid step in ${range.name}: "${part}"`;
    if (stepParts.length === 2) {
      const step = parseInt(stepParts[1], 10);
      if (isNaN(step) || step < 1) return `Invalid step value "${stepParts[1]}" in ${range.name}`;
      if (step > fieldSpan) return `Step ${step} exceeds range of ${range.name} (max ${fieldSpan})`;
    }
    const base = stepParts[0];
    if (base === "*") continue;
    const rangeParts = base.split("-");
    if (rangeParts.length > 2) return `Invalid range in ${range.name}: "${base}"`;
    const resolved = [];
    for (const val of rangeParts) {
      const n = resolveAlias(val, fieldIndex);
      if (n === null) {
        const hint = fieldIndex === 3 ? " (use 1-12 or JAN-DEC)" : fieldIndex === 4 ? " (use 0-7 or SUN-SAT)" : "";
        return `"${val}" is not valid in ${range.name}${hint}`;
      }
      if (n < range.min || n > range.max) return `${n} is out of range ${range.min}-${range.max} for ${range.name}`;
      resolved.push(n);
    }
    if (resolved.length === 2 && resolved[0] > resolved[1]) {
      return `Invalid range ${resolved[0]}-${resolved[1]} in ${range.name} (start must be <= end)`;
    }
  }
  return null;
}

function validateCron(expr) {
  if (!expr || !expr.trim()) return "Cron expression is required";
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], CRON_RANGES[i], i);
    if (err) return err;
  }
  return null;
}

// --- Cron to human-readable description ---

function expandField(field, min, max) {
  const results = new Set();
  for (const part of field.split(",")) {
    const [base, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (base === "*") {
      for (let i = min; i <= max; i += step) results.add(i);
    } else if (base.includes("-")) {
      const [lo, hi] = base.split("-").map((v) => parseInt(v, 10));
      for (let i = lo; i <= hi; i += step) results.add(i);
    } else {
      results.add(parseInt(base, 10));
    }
  }
  return [...results].sort((a, b) => a - b);
}

function formatTime24(h, m) {
  const hh = String(h).padStart(2, "0");
  if (m !== undefined) return `${hh}:${String(m).padStart(2, "0")}`;
  return `${hh}:00`;
}

function describeDow(field) {
  if (field === "*") return null;
  const values = expandField(field, 0, 6);
  if (!values) return field;
  if (values.length === 5 && values[0] === 1 && values[4] === 5) return "weekdays";
  if (values.length === 2 && values[0] === 0 && values[1] === 6) return "weekends";
  return values.map((d) => DOW_LABELS[d % 7]).join(", ");
}

function describeDom(field) {
  if (field === "*") return null;
  const values = expandField(field, 1, 31);
  if (!values) return field;
  return values.map((d) => ordinal(d)).join(", ");
}

function describeMonth(field) {
  if (field === "*") return null;
  const values = expandField(field, 1, 12);
  if (!values) return field;
  return values.map((m) => MONTH_LABELS[m] || m).join(", ");
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function isSimpleNumber(field) {
  return /^\d+$/.test(field);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function describeTime(min, hour) {
  if (min === "*" && hour === "*") return "Every minute";

  if (min.startsWith("*/") && hour === "*") {
    const n = parseInt(min.slice(2), 10);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  if (isSimpleNumber(min) && hour === "*") {
    return `At :${pad2(parseInt(min, 10))} every hour`;
  }

  if (isSimpleNumber(min) && isSimpleNumber(hour)) {
    return `At ${pad2(parseInt(hour, 10))}:${pad2(parseInt(min, 10))}`;
  }

  if (isSimpleNumber(min) && hour.startsWith("*/")) {
    const n = parseInt(hour.slice(2), 10);
    return `At :${pad2(parseInt(min, 10))} every ${n} hours`;
  }

  if (min === "0" && hour.startsWith("*/")) {
    const n = parseInt(hour.slice(2), 10);
    return n === 1 ? "Every hour" : `Every ${n} hours`;
  }

  if (min === "*" && hour !== "*") {
    const hourVals = expandField(hour, 0, 23);
    if (hourVals && hourVals.length <= 6) {
      return `Every minute during ${hourVals.map((h) => formatTime24(h)).join(", ")}`;
    }
    return `Every minute during hours ${hour}`;
  }

  if (hour === "*" && min !== "*") {
    return `At minutes ${min} every hour`;
  }

  return `Cron ${hour}:${min}`;
}

function cronToHuman(expr) {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;
  if (validateCron(trimmed)) return null;

  const [min, hour, dom, month, dow] = fields;
  const parts = [describeTime(min, hour)];

  if (dow !== "*") {
    const dowDesc = describeDow(dow);
    if (dowDesc) parts.push(`on ${dowDesc}`);
  }

  if (dom !== "*") {
    const domDesc = describeDom(dom);
    if (domDesc) parts.push(`on the ${domDesc}`);
  }

  if (month !== "*") {
    const monthDesc = describeMonth(month);
    if (monthDesc) parts.push(`in ${monthDesc}`);
  }

  return parts.join(" ");
}

function updateScheduleCronPreview() {
  const el = document.getElementById("schedule-cron-preview");
  if (!el) return;
  const input = document.getElementById("schedule-cron-input");
  const val = input ? input.value.trim() : "";
  if (!val) {
    el.textContent = "";
    el.className = "cron-preview";
    return;
  }
  const err = validateCron(val);
  if (err) {
    el.textContent = err;
    el.className = "cron-preview cron-error";
    return;
  }
  const human = cronToHuman(val);
  el.textContent = human || "Valid cron expression";
  el.className = "cron-preview cron-valid";
}

// --- Toast notifications (top-left, stacked downward) ---

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  const existing = document.querySelectorAll(".toast");
  const offset = 64 + existing.length * 48;
  toast.style.top = `${offset}px`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// --- Auth ---

let authRequired = false;

function getAuthToken() {
  const el = document.getElementById("auth-token");
  return el ? el.value.trim() : "";
}

function isAuthReady() {
  return !authRequired || !!getAuthToken();
}

function persistToken() {
  sessionStorage.setItem("backup-auth-token", getAuthToken());
}

function restoreToken() {
  const saved = sessionStorage.getItem("backup-auth-token");
  if (saved) {
    const el = document.getElementById("auth-token");
    if (el) el.value = saved;
  }
}

function setAuthHint(visible, message) {
  const hint = document.getElementById("auth-hint");
  if (hint) {
    if (message) hint.textContent = message;
    hint.hidden = !visible;
  }
  const field = document.getElementById("auth-field");
  if (field) field.classList.toggle("auth-required", visible);
}

async function reloadAfterAuth() {
  await loadConfig();
  await loadBackups();
  await loadLogs();
  await pollStatus();
}

async function handleAuthTokenUpdate() {
  persistToken();
  const token = getAuthToken();
  if (!token) {
    if (authRequired) {
      setAuthHint(true, "Enter token to load config");
    }
    return;
  }
  setAuthHint(false);
  showToast("Token saved. Loading config...");
  await reloadAfterAuth();
}

// --- Password Management ---

let passwordConfigs = [];

function togglePasswordVisibility() {
  const input = document.getElementById("db-form-password");
  const toggleText = document.getElementById("password-toggle-text");
  
  if (input.type === "password") {
    input.type = "text";
    toggleText.textContent = "Hide";
  } else {
    input.type = "password";
    toggleText.textContent = "Show";
  }
}

async function savePassword(configName, password) {
  if (!password) return;
  try {
    await api(`/api/passwords/${encodeURIComponent(configName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    console.error("Failed to save password:", err);
    throw err;
  }
}

async function deletePassword(configName) {
  try {
    await api(`/api/passwords/${encodeURIComponent(configName)}`, {
      method: "DELETE",
    });
  } catch (err) {
    console.error("Failed to delete password:", err);
  }
}

async function loadPasswordStatus() {
  try {
    const status = await api("/api/passwords");
    passwordConfigs = status.configs || [];
    
    if (status.decryptionFailed) {
      document.getElementById("password-warning").hidden = false;
    }
    
    return passwordConfigs;
  } catch (err) {
    console.error("Failed to load password status:", err);
    return [];
  }
}

function hasPassword(configName) {
  return passwordConfigs.includes(configName);
}

function hidePasswordWarning() {
  document.getElementById("password-warning").hidden = true;
}

// --- API helpers ---

async function api(path, options = {}) {
  const token = getAuthToken();
  if (token) {
    options.headers = { ...options.headers, Authorization: `Bearer ${token}` };
  }
  const res = await fetch(path, options);
  if (path.endsWith("/logs")) {
    return { ok: res.ok, text: await res.text() };
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// --- Status polling ---

async function pollStatus() {
  if (!isAuthReady()) {
    return null;
  }
  try {
    const status = await api("/api/status");
    const el = document.getElementById("status-indicator");
    if (status.running) {
      el.className = "status running";
      el.textContent = `Backing up ${status.database}`;
    } else {
      el.className = "status idle";
      el.textContent = "Idle";
    }
    return status;
  } catch {
    // ignore polling errors
    return null;
  }
}

// --- Backups ---

async function loadBackups() {
  const container = document.getElementById("backups-list");
  if (!isAuthReady()) {
    container.innerHTML = '<p class="no-backups">Enter auth token above to load backups.</p>';
    return;
  }
  try {
    const backups = await api("/api/backups");
    const dbs = Object.keys(backups);

    if (dbs.length === 0) {
      container.innerHTML = '<p class="no-backups">No backups yet. Configure a database and trigger your first backup.</p>';
      return;
    }

    let html = "";
    for (const db of dbs.sort()) {
      html += `<div class="env-group"><h3>${db}</h3>`;
      html += `<table class="backup-table">
        <thead><tr><th>Date</th><th>Size</th><th></th></tr></thead>
        <tbody>`;
      for (const b of backups[db]) {
        html += `<tr>
          <td>${b.date}</td>
          <td>${b.sizeHuman || `${b.sizeMB} MB`}</td>
          <td class="backup-actions">
            <button class="small secondary" data-download-file="${encodeURIComponent(b.filename)}">Download</button>
            <button class="small danger" data-delete-file="${encodeURIComponent(b.filename)}">Delete</button>
          </td>
        </tr>`;
      }
      html += "</tbody></table></div>";
    }
    container.innerHTML = html;
    container.querySelectorAll("[data-download-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        downloadBackup(decodeURIComponent(btn.dataset.downloadFile));
      });
    });
    container.querySelectorAll("[data-delete-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        deleteBackup(decodeURIComponent(btn.dataset.deleteFile));
      });
    });
  } catch (err) {
    container.innerHTML = `<p class="no-backups">Could not load backups: ${err.message}</p>`;
  }
}

async function downloadBackup(filename) {
  try {
    const token = getAuthToken();
    const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let msg = `Download failed (${res.status})`;
      try {
        const data = await res.json();
        if (data?.error) msg = data.error;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteBackup(filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    await api(`/api/backups/${encodeURIComponent(filename)}`, { method: "DELETE" });
    showToast("Backup deleted");
    loadBackups();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- Trigger ---

async function triggerBackup() {
  const database = document.getElementById("trigger-db").value;
  if (!database) {
    showToast("Pick a database first", "error");
    return;
  }
  const btn = document.getElementById("trigger-btn");

  btn.disabled = true;
  try {
    await api("/api/backups/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database }),
    });
    showToast(`Backup started for ${database}`);
    if (statusPollInterval) clearInterval(statusPollInterval);
    statusPollInterval = setInterval(async () => {
      const status = await pollStatus();
      if (!status || !status.running) {
        clearInterval(statusPollInterval);
        statusPollInterval = setInterval(pollStatus, 5000);
        loadBackups();
      }
    }, 2000);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// --- Database config CRUD ---

function populateTriggerSelect() {
  const select = document.getElementById("trigger-db");
  const scheduleSelect = document.getElementById("schedule-db-select");
  const dbs = Object.keys(currentConfig.databases || {});

  select.innerHTML = dbs.length === 0
    ? '<option value="">No databases configured</option>'
    : dbs.map((db) => `<option value="${db}">${db}</option>`).join("");

  scheduleSelect.innerHTML = '<option value="">Database</option>' +
    dbs.map((db) => `<option value="${db}">${db}</option>`).join("");
}

function renderDbCards() {
  const container = document.getElementById("db-cards");
  const dbs = Object.entries(currentConfig.databases || {});

  if (dbs.length === 0) {
    container.innerHTML = '<p class="empty-state">No databases configured yet.<br>Add one manually or pick a template to get started.</p>';
    return;
  }

  let html = "";
  for (const [name, cfg] of dbs) {
    const hasPass = hasPassword(name);
    const passStatus = hasPass 
      ? '<span class="password-status locked">Password set</span>'
      : '<span class="password-status unlocked">No password</span>';
    html += `<div class="db-card">
      <div class="db-card-header">
        <strong>${name}</strong>
        <div class="backup-actions">
          <button class="small secondary" onclick="editDatabase('${name}')">Edit</button>
          <button class="small danger" onclick="deleteDatabase('${name}')">Delete</button>
        </div>
      </div>
      <div class="db-card-body">
        <span class="conn-str">${cfg.db_user}@${cfg.db_host}:${cfg.db_port}/${cfg.db_name}</span>
        ${passStatus}
      </div>
    </div>`;
  }
  container.innerHTML = html;
}

function showAddDbForm() {
  document.getElementById("db-form-original-name").value = "";
  document.getElementById("db-form-name").value = "";
  document.getElementById("db-form-name").disabled = false;
  document.getElementById("db-form-host").value = "";
  document.getElementById("db-form-port").value = "3306";
  document.getElementById("db-form-dbname").value = "";
  document.getElementById("db-form-user").value = "";
  document.getElementById("db-form-password").value = "";
  document.getElementById("db-form-ignored").value = "";
  document.getElementById("db-form-structure").value = "";
  // Reset password visibility toggle
  document.getElementById("db-form-password").type = "password";
  document.getElementById("password-toggle-text").textContent = "Show";
  document.getElementById("db-form-container").hidden = false;
}

function hideDbForm() {
  document.getElementById("db-form-container").hidden = true;
}

function editDatabase(name) {
  const cfg = currentConfig.databases[name];
  if (!cfg) return;
  document.getElementById("db-form-original-name").value = name;
  document.getElementById("db-form-name").value = name;
  document.getElementById("db-form-name").disabled = true;
  document.getElementById("db-form-host").value = cfg.db_host || "";
  document.getElementById("db-form-port").value = cfg.db_port || "3306";
  document.getElementById("db-form-dbname").value = cfg.db_name || "";
  document.getElementById("db-form-user").value = cfg.db_user || "";
  // Clear password field - user must re-enter when editing
  document.getElementById("db-form-password").value = "";
  document.getElementById("db-form-password").type = "password";
  document.getElementById("password-toggle-text").textContent = "Show";
  document.getElementById("db-form-ignored").value = (cfg.ignored_tables || []).join("\n");
  document.getElementById("db-form-structure").value = (cfg.structure_only_tables || []).join("\n");
  document.getElementById("db-form-container").hidden = false;
}

function parseTextareaList(id) {
  return document.getElementById(id).value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function getDbFormValues() {
  return {
    name: document.getElementById("db-form-name").value.trim(),
    db_host: document.getElementById("db-form-host").value.trim(),
    db_port: document.getElementById("db-form-port").value.trim() || "3306",
    db_name: document.getElementById("db-form-dbname").value.trim(),
    db_user: document.getElementById("db-form-user").value.trim(),
    password: document.getElementById("db-form-password").value,
    ignored_tables: parseTextareaList("db-form-ignored"),
    structure_only_tables: parseTextareaList("db-form-structure"),
  };
}

function validateDbForm(values, requirePassword = false) {
  if (!values.name) {
    showToast("Config name is required", "error");
    return false;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(values.name)) {
    showToast("Config name: only letters, numbers, and underscores allowed", "error");
    return false;
  }
  if (!values.db_host || !values.db_name || !values.db_user) {
    showToast("Host, database name, and user are required.", "error");
    return false;
  }
  if (requirePassword && !values.password) {
    showToast("Enter the password to test the connection.", "error");
    return false;
  }
  return true;
}

async function testDatabaseConnection() {
  if (authRequired && !getAuthToken()) {
    showToast("Enter the auth token above to test connection.", "error");
    return;
  }

  const values = getDbFormValues();
  if (!validateDbForm(values, true)) return;

  const button = document.getElementById("test-connection-btn");
  const originalText = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = "Testing...";
  }

  try {
    const result = await api("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        db_host: values.db_host,
        db_port: values.db_port,
        db_name: values.db_name,
        db_user: values.db_user,
        password: values.password,
      }),
    });
    showToast(result.message || "Connection successful");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || "Test connection";
    }
  }
}

async function saveDatabase(event) {
  event.preventDefault();
  if (!currentConfig) {
    if (authRequired && !getAuthToken()) {
      showToast("Enter the auth token above to load config first.", "error");
    } else {
      showToast("Config not loaded yet. Please try again.", "error");
    }
    return;
  }

  const originalName = document.getElementById("db-form-original-name").value;
  const values = getDbFormValues();
  if (!validateDbForm(values)) return;

  const name = values.name;
  const dbConfig = {
    db_host: values.db_host,
    db_port: values.db_port,
    db_name: values.db_name,
    db_user: values.db_user,
    ignored_tables: values.ignored_tables,
    structure_only_tables: values.structure_only_tables,
  };

  const password = values.password;

  const config = {
    ...currentConfig,
    schedules: Array.isArray(currentConfig.schedules) ? [...currentConfig.schedules] : [],
    databases: { ...currentConfig.databases },
  };

  if (originalName && originalName !== name) {
    delete config.databases[originalName];
    config.schedules = config.schedules.map((s) =>
      s.database === originalName ? { ...s, database: name } : s
    );
  }

  config.databases[name] = dbConfig;

  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    
    // Save password if provided
    if (password) {
      await savePassword(name, password);
      // Update password status
      if (!passwordConfigs.includes(name)) {
        passwordConfigs.push(name);
      }
    }
    
    currentConfig = config;
    renderDbCards();
    populateTriggerSelect();
    renderSchedules();
    hideDbForm();
    showToast("Database saved");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteDatabase(name) {
  if (!confirm(`Remove "${name}" and its schedules?`)) return;
  if (!currentConfig) return;

  const config = { ...currentConfig };
  config.databases = { ...config.databases };
  delete config.databases[name];
  config.schedules = config.schedules.filter((s) => s.database !== name);

  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    
    // Delete password as well
    await deletePassword(name);
    // Remove from password status
    passwordConfigs = passwordConfigs.filter((p) => p !== name);
    
    currentConfig = config;
    renderDbCards();
    populateTriggerSelect();
    renderSchedules();
    showToast("Database removed");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- Templates ---

let currentPreviewTemplate = null;
let currentPreviewTemplateName = null;

function showSaveTemplateModal() {
  const values = getDbFormValues();
  if (!validateDbForm(values)) return;
  document.getElementById("template-name").value = values.name;
  document.getElementById("save-template-modal").hidden = false;
}

function hideSaveTemplateModal() {
  document.getElementById("save-template-modal").hidden = true;
  document.getElementById("template-name").value = "";
}

async function saveAsTemplate() {
  if (authRequired && !getAuthToken()) {
    showToast("Enter the auth token above to save a template.", "error");
    return;
  }

  const templateName = document.getElementById("template-name").value.trim();
  
  if (!templateName) {
    showToast("Template name is required", "error");
    return;
  }
  
  if (!/^[a-zA-Z0-9_]+$/.test(templateName)) {
    showToast("Template name: only letters, numbers, and underscores allowed", "error");
    return;
  }
  
  const values = getDbFormValues();
  if (!validateDbForm(values)) return;
  
  const dbConfig = {
    db_host: values.db_host,
    db_port: values.db_port,
    db_name: values.db_name,
    db_user: values.db_user,
    ignored_tables: values.ignored_tables,
    structure_only_tables: values.structure_only_tables,
  };
  
  const includeSchedule = document.getElementById("template-include-schedule").checked;
  const schedules = includeSchedule 
    ? [{ database: values.name, cron: "0 */6 * * *" }]
    : [];
  
  const template = {
    databases: { [values.name]: dbConfig },
    schedules: schedules,
  };
  
  try {
    await api("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: templateName, template }),
    });
    hideSaveTemplateModal();
    showToast(`Template "${templateName}" saved`);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function showTemplatesModal() {
  const modal = document.getElementById("templates-modal");
  const list = document.getElementById("templates-list");

  try {
    const templates = await api("/api/templates");
    const names = Object.keys(templates);

    if (names.length === 0) {
      list.innerHTML = `
        <p class="empty-state">No templates available yet.</p>
        <p class="text-muted">Save a database configuration as a template to reuse it later.</p>
      `;
    } else {
      list.innerHTML = names.map((name) => {
        const t = templates[name] || {};
        const dbNames = Object.keys(t.databases || {});
        const dbCount = dbNames.length;
        const scheduleCount = Array.isArray(t.schedules) ? t.schedules.length : 0;
        
        return `<div class="template-card">
          <div class="template-card-header">
            <strong>${name}</strong>
            <div class="template-card-actions">
              <button class="small" onclick="previewTemplate('${name}')">Preview</button>
              <button class="small" onclick="applyTemplate('${name}')">Apply</button>
              <button class="small danger" onclick="deleteTemplate('${name}')">Delete</button>
            </div>
          </div>
          <div class="template-card-body">
            ${dbCount} database${dbCount !== 1 ? 's' : ''}${scheduleCount > 0 ? `, ${scheduleCount} schedule${scheduleCount !== 1 ? 's' : ''}` : ''}
            <div class="template-db-list">${dbNames.join(", ")}</div>
          </div>
        </div>`;
      }).join("");
    }
  } catch (err) {
    list.innerHTML = `<p class="empty-state">Could not load templates: ${err.message}</p>`;
  }

  modal.hidden = false;
}

function hideTemplatesModal() {
  document.getElementById("templates-modal").hidden = true;
}

async function previewTemplate(name) {
  try {
    const templates = await api("/api/templates");
    const template = templates[name];
    if (!template) {
      showToast("Template not found", "error");
      return;
    }
    
    currentPreviewTemplate = template;
    currentPreviewTemplateName = name;
    
    const content = document.getElementById("template-preview-content");
    
    let dbHtml = '';
    const templateDatabases = template.databases || {};
    for (const [dbName, dbCfg] of Object.entries(templateDatabases)) {
      const ignored = dbCfg.ignored_tables?.length > 0 ? dbCfg.ignored_tables.join(", ") : "none";
      const structureOnly = dbCfg.structure_only_tables?.length > 0 ? dbCfg.structure_only_tables.join(", ") : "none";
      
      dbHtml += `<div class="template-preview-db">
        <div class="db-name">${dbName}</div>
        <div class="db-details">${dbCfg.db_user}@${dbCfg.db_host}:${dbCfg.db_port}/${dbCfg.db_name}</div>
        <div class="db-details">Ignored tables: ${ignored}</div>
        <div class="db-details">Structure-only: ${structureOnly}</div>
      </div>`;
    }
    
    let scheduleHtml = '';
    const templateSchedules = Array.isArray(template.schedules) ? template.schedules : [];
    if (templateSchedules.length > 0) {
      scheduleHtml = templateSchedules.map(s => {
        const human = cronToHuman(s.cron) || s.cron;
        return `<div class="template-preview-schedule">
          <code>${s.cron}</code>
          <span class="text-muted">${human}</span>
          <span>for ${s.database}</span>
        </div>`;
      }).join("");
    } else {
      scheduleHtml = '<p class="text-muted">No schedules included</p>';
    }
    
    content.innerHTML = `
      <div class="template-preview-section">
        <h4>Databases (${Object.keys(templateDatabases).length})</h4>
        ${dbHtml}
      </div>
      <div class="template-preview-section">
        <h4>Schedules (${templateSchedules.length})</h4>
        ${scheduleHtml}
      </div>
    `;
    
    document.getElementById("template-preview-modal").hidden = false;
  } catch (err) {
    showToast(err.message, "error");
  }
}

function hideTemplatePreviewModal() {
  document.getElementById("template-preview-modal").hidden = true;
  currentPreviewTemplate = null;
  currentPreviewTemplateName = null;
}

async function applyPreviewedTemplate() {
  if (!currentPreviewTemplate || !currentPreviewTemplateName) return;
  await applyTemplate(currentPreviewTemplateName);
  hideTemplatePreviewModal();
}

async function applyTemplate(name) {
  try {
    if (!currentConfig) {
      if (authRequired && !getAuthToken()) {
        showToast("Enter the auth token above to load config first.", "error");
      } else {
        showToast("Config not loaded yet. Please try again.", "error");
      }
      return;
    }
    const templates = await api("/api/templates");
    const template = templates[name];
    if (!template) {
      showToast("Template not found", "error");
      return;
    }

    if (!template.databases || typeof template.databases !== "object") {
      showToast("Template is missing database definitions.", "error");
      return;
    }

    const config = {
      ...currentConfig,
      schedules: Array.isArray(currentConfig.schedules) ? [...currentConfig.schedules] : [],
      databases: { ...currentConfig.databases, ...template.databases },
    };

    const existingScheduleKeys = new Set(config.schedules.map((s) => `${s.database}:${s.cron}`));
    const templateSchedules = Array.isArray(template.schedules) ? template.schedules : [];
    for (const schedule of templateSchedules) {
      const key = `${schedule.database}:${schedule.cron}`;
      if (!existingScheduleKeys.has(key)) {
        config.schedules = [...config.schedules, schedule];
      }
    }

    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    currentConfig = config;
    renderDbCards();
    populateTriggerSelect();
    renderSchedules();
    hideTemplatesModal();
    showToast(`Applied "${name}"`);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteTemplate(name) {
  if (!confirm(`Delete template "${name}"?`)) return;
  
  try {
    await api(`/api/templates/${encodeURIComponent(name)}`, { method: "DELETE" });
    showToast(`Template "${name}" deleted`);
    showTemplatesModal();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- Schedules ---

function renderSchedules() {
  const tbody = document.getElementById("schedules-body");
  const schedules = currentConfig.schedules || [];

  if (schedules.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No scheduled backups. Add one below.</td></tr>';
    return;
  }

  tbody.innerHTML = schedules.map((s, i) => {
    const human = cronToHuman(s.cron) || s.cron;
    return `<tr>
      <td>${s.database}</td>
      <td><code>${s.cron}</code></td>
      <td class="text-muted">${human}</td>
      <td class="backup-actions"><button class="small danger" onclick="deleteSchedule(${i})">Delete</button></td>
    </tr>`;
  }).join("");
}

async function addSchedule() {
  const db = document.getElementById("schedule-db-select").value;
  const cron = document.getElementById("schedule-cron-input").value.trim();

  if (!db) {
    showToast("Pick a database", "error");
    return;
  }
  if (!cron) {
    showToast("Enter a cron expression", "error");
    return;
  }

  const cronErr = validateCron(cron);
  if (cronErr) {
    showToast(cronErr, "error");
    return;
  }

  const config = { ...currentConfig };
  config.schedules = [...config.schedules, { database: db, cron }];

  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    currentConfig = config;
    renderSchedules();
    document.getElementById("schedule-cron-input").value = "";
    document.getElementById("schedule-cron-preview").textContent = "";
    showToast("Schedule added");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteSchedule(index) {
  if (!confirm("Remove this schedule?")) return;

  const config = { ...currentConfig };
  config.schedules = config.schedules.filter((_, i) => i !== index);

  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    currentConfig = config;
    renderSchedules();
    showToast("Schedule removed");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- Retention ---

async function saveRetention(event) {
  event.preventDefault();
  if (!currentConfig) {
    if (authRequired && !getAuthToken()) {
      showToast("Enter the auth token above to load config first.", "error");
    } else {
      showToast("Config not loaded yet. Please try again.", "error");
    }
    return;
  }

  const retention = parseInt(document.getElementById("retention").value, 10) || 5;
  const config = { ...currentConfig, retention };

  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    currentConfig = config;
    showToast("Retention updated");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// --- Logs ---

async function loadLogs() {
  const viewer = document.getElementById("log-viewer");
  if (!isAuthReady()) {
    viewer.textContent = "Enter auth token above to load logs.";
    return;
  }
  try {
    const result = await api("/api/logs");
    viewer.textContent = result.text || "No log entries yet.";
    viewer.scrollTop = viewer.scrollHeight;
  } catch {
    viewer.textContent = "Could not load logs.";
  }
}

// --- Init ---

async function loadConfig() {
  if (!isAuthReady()) {
    setAuthHint(true, "Enter token to load config");
    return;
  }
  try {
    currentConfig = await api("/api/config");
    document.getElementById("retention").value = currentConfig.retention || 5;
    await loadPasswordStatus();
    renderDbCards();
    populateTriggerSelect();
    renderSchedules();
    setAuthHint(false);
  } catch (err) {
    if (authRequired && err.message === "Unauthorized") {
      setAuthHint(true, "Enter token to load config");
      showToast("Auth token required. Enter it above to load config.", "error");
    } else {
      showToast("Could not load config: " + err.message, "error");
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("/api/auth-required");
    const data = await res.json();
    if (data.required) {
      authRequired = true;
      document.getElementById("auth-field").hidden = false;
      restoreToken();
      const tokenInput = document.getElementById("auth-token");
      if (tokenInput) {
        tokenInput.addEventListener("change", handleAuthTokenUpdate);
        tokenInput.addEventListener("input", () => {
          if (!tokenInput.value.trim()) {
            setAuthHint(true, "Enter token to load config");
          }
        });
        tokenInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleAuthTokenUpdate();
          }
        });
      }
      if (!getAuthToken()) {
        setAuthHint(true, "Enter token to load config");
      }
    }
    // Check if decryption failed (shown in auth-required response)
    if (data.decryptionFailed) {
      document.getElementById("password-warning").hidden = false;
    }
  } catch {
    // not critical
  }

  loadBackups();
  loadConfig();
  loadLogs();
  pollStatus();
  statusPollInterval = setInterval(pollStatus, 5000);
  setInterval(loadBackups, 30000);
});
