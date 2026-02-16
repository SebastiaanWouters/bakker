import {
  readdir,
  stat,
  unlink,
  readFile,
  writeFile,
  exists,
  chmod,
  mkdir,
  appendFile,
} from "node:fs/promises";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from "node:crypto";

const PORT = parseInt(process.env.PORT || "3500", 10);
const HOST = process.env.HOST || "::";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || "";
const DEV = process.env.DEV === "1";
const BACKUP_DIR = "/data/backups";
const CONFIG_FILE = "/data/config/config.json";
const TEMPLATES_FILE = "/data/config/templates.json";
const PASSWORDS_FILE = "/data/config/passwords.enc";
const BACKUP_IDS_FILE = "/data/config/backup-ids.json";
const LOG_FILE = "/data/logs/backup.log";
const STATUS_DIR = "/tmp";
const STATUS_PREFIX = "backup-status-";
const STATUS_SUFFIX = ".json";
const STATIC_DIR = resolve(import.meta.dir, "static");

const ALGORITHM = "aes-256-gcm";

if (!DEV && !AUTH_TOKEN) {
  console.error(
    "[startup] AUTH_TOKEN is required in production. Refusing to start.",
  );
  process.exit(1);
}

// --- Dev Live Reload ---

const devReloadClients = new Set<{ write: (chunk: string) => Promise<void> }>();
let devReloadWatching = false;
let devReloadTimer: ReturnType<typeof setTimeout> | null = null;

function devReloadBroadcast(): void {
  for (const writer of devReloadClients) {
    try {
      writer.write(`event: reload\ndata: ${Date.now()}\n\n`).catch(() => {
        devReloadClients.delete(writer);
      });
    } catch {
      devReloadClients.delete(writer);
    }
  }
}

function ensureDevReloadWatcher(): void {
  if (!DEV || devReloadWatching) return;
  devReloadWatching = true;
  try {
    watch(STATIC_DIR, (_event, _filename) => {
      if (devReloadTimer !== null) return;
      devReloadTimer = setTimeout(() => {
        devReloadTimer = null;
        devReloadBroadcast();
      }, 150);
    });
  } catch (err) {
    console.warn("[dev-reload] Failed to start watcher:", err);
  }
}

async function serveIndexHtml(): Promise<Response> {
  if (!DEV) {
    return new Response(Bun.file(join(STATIC_DIR, "index.html")));
  }
  try {
    const html = await readFile(join(STATIC_DIR, "index.html"), "utf-8");
    const injected = html.includes("dev-reload.js")
      ? html
      : html.replace(
          "</body>",
          '  <script src="/dev-reload.js"></script>\n</body>',
        );
    return new Response(injected, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.warn("[dev-reload] Failed to read index.html:", err);
    return new Response(Bun.file(join(STATIC_DIR, "index.html")));
  }
}

// --- Auth ---

function checkAuth(req: Request, allowCookieAuth = false): Response | null {
  if (!AUTH_TOKEN) return null;
  const header = req.headers.get("Authorization") || "";
  const bearerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearerToken === AUTH_TOKEN) return null;
  if (!allowCookieAuth) return json({ error: "Unauthorized" }, 401);

  const cookieHeader = req.headers.get("Cookie") || "";
  const cookieToken = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("bakker_auth_token="))
    ?.slice("bakker_auth_token=".length);

  if (cookieToken) {
    try {
      if (decodeURIComponent(cookieToken) === AUTH_TOKEN) return null;
    } catch {
      // Ignore malformed cookie values.
    }
  }

  return json({ error: "Unauthorized" }, 401);
}

// --- Password Encryption ---

function deriveKey(secret: string, saltHex: string): Buffer {
  return scryptSync(secret, Buffer.from(saltHex, "hex"), 32);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

interface EncryptedData {
  secretHash: string;
  salt: string;
  iv: string;
  authTag: string;
  encrypted: string;
}

function encrypt(text: string, secret: string): EncryptedData {
  const salt = randomBytes(16);
  const key = deriveKey(secret, salt.toString("hex"));
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return {
    secretHash: hashSecret(secret),
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    encrypted,
  };
}

function decrypt(data: EncryptedData, secret: string): string | null {
  try {
    // Verify secret hash first
    if (data.secretHash !== hashSecret(secret)) {
      return null;
    }
    const saltHex =
      typeof data.salt === "string" && data.salt.length > 0
        ? data.salt
        : "64622d6261636b75702d73616c74";
    const key = deriveKey(secret, saltHex);
    const iv = Buffer.from(data.iv, "hex");
    const authTag = Buffer.from(data.authTag, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(data.encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

// --- Password Store ---

let decryptionFailed = false;

async function readPasswords(): Promise<Map<string, string>> {
  const passwords = new Map<string, string>();

  if (!ENCRYPTION_SECRET) {
    decryptionFailed = false;
    return passwords;
  }

  try {
    const raw = await readFile(PASSWORDS_FILE, "utf-8");
    if (!raw.trim()) {
      return passwords;
    }
    const data: EncryptedData = JSON.parse(raw);
    const decrypted = decrypt(data, ENCRYPTION_SECRET);

    if (decrypted === null) {
      decryptionFailed = true;
      console.warn(
        "[passwords] Decryption failed - cannot decrypt stored passwords",
      );
      return passwords;
    }

    const parsed = JSON.parse(decrypted);
    for (const [key, value] of Object.entries(parsed)) {
      passwords.set(key, value as string);
    }
    decryptionFailed = false;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      decryptionFailed = false;
      return passwords;
    }

    // Parse errors, corrupt file, etc.
    decryptionFailed = true;
    console.error("[passwords] Error reading passwords:", err.message);
  }

  return passwords;
}

async function writePasswords(passwords: Map<string, string>): Promise<void> {
  if (!ENCRYPTION_SECRET) {
    throw new Error("ENCRYPTION_SECRET not configured");
  }

  const obj: Record<string, string> = {};
  for (const [key, value] of passwords) {
    obj[key] = value;
  }

  const encrypted = encrypt(JSON.stringify(obj), ENCRYPTION_SECRET);
  await writeFile(
    PASSWORDS_FILE,
    JSON.stringify(encrypted, null, 2) + "\n",
    "utf-8",
  );
  await chmod(PASSWORDS_FILE, 0o600);
}

async function setPassword(
  configName: string,
  password: string,
): Promise<void> {
  const passwords = await readPasswords();
  passwords.set(configName, password);
  await writePasswords(passwords);
}

async function deletePassword(configName: string): Promise<void> {
  const passwords = await readPasswords();
  if (passwords.has(configName)) {
    passwords.delete(configName);
    await writePasswords(passwords);
  }
}

async function getPassword(configName: string): Promise<string | null> {
  const passwords = await readPasswords();
  return passwords.get(configName) || null;
}

async function listPasswordConfigs(): Promise<string[]> {
  const passwords = await readPasswords();
  return Array.from(passwords.keys());
}

// --- Config migration (old environments format -> new databases/schedules format) ---

function migrateConfig(config: any): { config: any; migrated: boolean } {
  if (!config.environments) return { config, migrated: false };

  const databases: Record<string, any> = {};
  const schedules: any[] = [];
  const schedule = config.schedule || "0 */6 * * *";

  for (const [env, envCfg] of Object.entries(config.environments) as [
    string,
    any,
  ][]) {
    databases[env] = {
      db_host: envCfg.db_host,
      db_port: envCfg.db_port || "3306",
      db_name: envCfg.db_name,
      db_user: envCfg.db_user,
      ignored_tables: [],
      structure_only_tables: [],
    };

    if (envCfg.enabled) {
      schedules.push({ database: env, cron: schedule });
    }
  }

  const migrated = {
    retention: config.retention || 5,
    databases,
    schedules,
  };

  return { config: migrated, migrated: true };
}

async function readConfig(): Promise<any> {
  const raw = await readFile(CONFIG_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  const { config, migrated } = migrateConfig(parsed);
  if (migrated) {
    await writeConfig(config);
    console.log(
      "Config migrated from old environments format to new databases/schedules format",
    );
  }
  return config;
}

async function writeConfig(config: any): Promise<void> {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// --- Template storage ---

async function readTemplates(): Promise<
  Record<string, { databases: Record<string, any>; schedules: any[] }>
> {
  try {
    const raw = await readFile(TEMPLATES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeTemplates(
  templates: Record<
    string,
    { databases: Record<string, any>; schedules: any[] }
  >,
): Promise<void> {
  await writeFile(
    TEMPLATES_FILE,
    JSON.stringify(templates, null, 2) + "\n",
    "utf-8",
  );
}

// --- Crontab generation ---

function regenerateCrontab(config: any): void {
  const lines: string[] = [
    "# DB Backup - auto-generated, do not edit manually",
    `SHELL=/bin/bash`,
    `PATH=/usr/local/bin:/usr/bin:/bin`,
    "",
  ];

  // Pass AUTH_TOKEN for backup script to retrieve passwords
  if (AUTH_TOKEN) {
    lines.push(`AUTH_TOKEN=${AUTH_TOKEN}`);
  }
  lines.push(`PORT=${PORT}`);
  lines.push("");

  for (const schedule of config.schedules || []) {
    const db = schedule.database;
    const cron = schedule.cron;
    if (db && cron) {
      lines.push(
        `${cron} root /app/scripts/backup.sh ${db} >> /data/logs/backup.log 2>&1`,
      );
    }
  }

  lines.push("");
  Bun.write("/etc/cron.d/db-backup", lines.join("\n"));
  try {
    Bun.spawnSync(["chmod", "0644", "/etc/cron.d/db-backup"]);
  } catch {
    // ignore chmod errors
  }
}

// --- Cron validation ---

const CRON_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function resolveAlias(val: string, fieldIndex: number): number | null {
  const lower = val.toLowerCase();
  if (fieldIndex === 3 && MONTH_NAMES[lower] !== undefined)
    return MONTH_NAMES[lower];
  if (fieldIndex === 4 && DOW_NAMES_MAP[lower] !== undefined)
    return DOW_NAMES_MAP[lower];
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function validateCron(expr: string): string | null {
  if (!expr || !expr.trim()) return "Cron expression is required";
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  for (let i = 0; i < 5; i++) {
    const range = CRON_RANGES[i];
    const fieldSpan = range.max - range.min + 1;
    const parts = fields[i].split(",");
    for (const part of parts) {
      if (!part) return `Empty value in list for ${range.name}`;
      const stepParts = part.split("/");
      if (stepParts.length > 2)
        return `Invalid step in ${range.name}: "${part}"`;
      if (stepParts.length === 2) {
        const step = parseInt(stepParts[1], 10);
        if (isNaN(step) || step < 1)
          return `Invalid step value "${stepParts[1]}" in ${range.name}`;
        if (step > fieldSpan)
          return `Step ${step} exceeds range of ${range.name} (max ${fieldSpan})`;
      }
      const base = stepParts[0];
      if (base === "*") continue;
      const rangeParts = base.split("-");
      if (rangeParts.length > 2)
        return `Invalid range in ${range.name}: "${base}"`;
      const resolved: number[] = [];
      for (const val of rangeParts) {
        const n = resolveAlias(val, i);
        if (n === null) {
          const hint =
            i === 3
              ? " (use 1-12 or JAN-DEC)"
              : i === 4
                ? " (use 0-7 or SUN-SAT)"
                : "";
          return `"${val}" is not valid in ${range.name}${hint}`;
        }
        if (n < range.min || n > range.max)
          return `${n} is out of range ${range.min}-${range.max} for ${range.name}`;
        resolved.push(n);
      }
      if (resolved.length === 2 && resolved[0] > resolved[1]) {
        return `Invalid range ${resolved[0]}-${resolved[1]} in ${range.name} (start must be <= end)`;
      }
    }
  }
  return null;
}

// --- Helpers ---

function isValidFilename(name: string): boolean {
  return (
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name.length > 0
  );
}

interface BackupStatusEntry {
  database: string;
  started?: string;
  pid?: number;
}

async function listRunningStatuses(): Promise<BackupStatusEntry[]> {
  try {
    const files = await readdir(STATUS_DIR);
    const statusFiles = files.filter(
      (file) => file.startsWith(STATUS_PREFIX) && file.endsWith(STATUS_SUFFIX),
    );
    const entries: BackupStatusEntry[] = [];

    for (const file of statusFiles) {
      const filePath = join(STATUS_DIR, file);
      try {
        const raw = await readFile(filePath, "utf-8");
        const data = JSON.parse(raw) as BackupStatusEntry & {
          running?: boolean;
        };
        const database =
          typeof data.database === "string" && data.database.length > 0
            ? data.database
            : file.slice(STATUS_PREFIX.length, -STATUS_SUFFIX.length);
        if (!database) continue;

        if (typeof data.pid === "number") {
          try {
            process.kill(data.pid, 0);
          } catch {
            await unlink(filePath);
            continue;
          }
        }

        entries.push({ database, started: data.started, pid: data.pid });
      } catch {
        // ignore parse errors
      }
    }

    return entries;
  } catch {
    return [];
  }
}

async function getBackupStatus(): Promise<any> {
  const entries = await listRunningStatuses();
  return {
    running: entries.length > 0,
    databases: entries.map((entry) => entry.database),
    items: entries,
  };
}

interface BackupInfo {
  id: number;
  filename: string;
  size: number;
  sizeMB: string;
  sizeHuman: string;
  date: string;
  database: string;
}

interface BackupIdStore {
  nextId: number;
  byFilename: Record<string, number>;
}

function sanitizeBackupIdStore(raw: any): BackupIdStore {
  const byFilename: Record<string, number> = {};
  let maxId = 0;

  if (raw && typeof raw.byFilename === "object" && raw.byFilename !== null) {
    for (const [filename, value] of Object.entries(raw.byFilename)) {
      const id = Number(value);
      if (!Number.isInteger(id) || id < 1) continue;
      byFilename[filename] = id;
      if (id > maxId) maxId = id;
    }
  }

  const rawNext = Number(raw?.nextId);
  const nextId = Number.isInteger(rawNext) && rawNext > 0 ? rawNext : maxId + 1;
  return {
    nextId: Math.max(nextId, maxId + 1),
    byFilename,
  };
}

async function readBackupIdStore(): Promise<BackupIdStore> {
  try {
    const raw = await readFile(BACKUP_IDS_FILE, "utf-8");
    if (!raw.trim()) {
      return { nextId: 1, byFilename: {} };
    }
    return sanitizeBackupIdStore(JSON.parse(raw));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { nextId: 1, byFilename: {} };
    }
    console.warn("[backup-ids] Failed to read store, using defaults:", err);
    return { nextId: 1, byFilename: {} };
  }
}

async function writeBackupIdStore(store: BackupIdStore): Promise<void> {
  await mkdir("/data/config", { recursive: true });
  await writeFile(BACKUP_IDS_FILE, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

let backupIdLock: Promise<void> = Promise.resolve();

async function withBackupIdLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = backupIdLock;
  let release!: () => void;
  backupIdLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function assignBackupIds(
  backups: Omit<BackupInfo, "id">[],
): Promise<BackupInfo[]> {
  return withBackupIdLock(async () => {
    const idStore = await readBackupIdStore();
    const usedIds = new Set<number>();
    let idStoreChanged = false;

    const sortedForAssignment = [...backups].sort((a, b) =>
      a.filename.localeCompare(b.filename),
    );
    const withIds: BackupInfo[] = [];

    for (const backup of sortedForAssignment) {
      let id = Number(idStore.byFilename[backup.filename]);
      const idIsValid = Number.isInteger(id) && id > 0;

      if (!idIsValid || usedIds.has(id)) {
        while (usedIds.has(idStore.nextId)) {
          idStore.nextId += 1;
        }
        id = idStore.nextId;
        idStore.nextId += 1;
        idStore.byFilename[backup.filename] = id;
        idStoreChanged = true;
      } else if (id >= idStore.nextId) {
        idStore.nextId = id + 1;
        idStoreChanged = true;
      }

      usedIds.add(id);
      withIds.push({ id, ...backup });
    }

    if (idStoreChanged) {
      await writeBackupIdStore(idStore);
    }

    return withIds;
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function listBackups(): Promise<Record<string, BackupInfo[]>> {
  const files = await readdir(BACKUP_DIR);
  files.sort();
  const backupsWithoutIds: Omit<BackupInfo, "id">[] = [];

  for (const file of files) {
    if (!file.endsWith(".sql.gz")) continue;

    const filePath = join(BACKUP_DIR, file);
    const fileStat = await stat(filePath);

    // Parse filename: {config_name}_{YYYYMMDD_HHMMSS}.sql.gz
    // Greedy match handles underscores in config names
    const match = file.match(/^(.+)_(\d{8}_\d{6})\.sql\.gz$/);
    if (!match) continue;

    const database = match[1];
    const dateStr = match[2];
    const formattedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)} ${dateStr.slice(9, 11)}:${dateStr.slice(11, 13)}:${dateStr.slice(13, 15)}`;

    backupsWithoutIds.push({
      filename: file,
      size: fileStat.size,
      sizeMB: (fileStat.size / 1024 / 1024).toFixed(2),
      sizeHuman: formatBytes(fileStat.size),
      date: formattedDate,
      database,
    });
  }

  const backups = await assignBackupIds(backupsWithoutIds);

  backups.sort((a, b) => b.date.localeCompare(a.date));

  const grouped: Record<string, BackupInfo[]> = {};
  for (const b of backups) {
    if (!grouped[b.database]) grouped[b.database] = [];
    grouped[b.database].push(b);
  }

  return grouped;
}

function triggerBackup(
  database: string,
  password?: string,
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (password) {
      env.DB_PASSWORD = password;
    }

    const proc = spawn("/app/scripts/backup.sh", [database], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (output) {
        mkdir("/data/logs", { recursive: true })
          .then(() => appendFile(LOG_FILE, output + "\n"))
          .catch(() => {
            // ignore log append errors
          });
      }

      if (code === 0) {
        resolve({ success: true, message: stdout.trim() });
      } else {
        resolve({ success: false, message: (stderr || stdout).trim() });
      }
    });

    proc.on("error", (err: Error) => {
      resolve({ success: false, message: err.message });
    });
  });
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (
      path.startsWith("/api/") &&
      path !== "/api/auth-required" &&
      path !== "/api/dev-reload"
    ) {
      const allowCookieAuth =
        method === "GET" && path.startsWith("/api/backups/");
      const authErr = checkAuth(req, allowCookieAuth);
      if (authErr) return authErr;
    }

    // GET /api/auth-required
    if (method === "GET" && path === "/api/auth-required") {
      if (ENCRYPTION_SECRET) {
        await readPasswords();
      }
      return json({
        required: !!AUTH_TOKEN,
        decryptionFailed,
        encryptionConfigured: !!ENCRYPTION_SECRET,
      });
    }

    // GET /api/templates
    if (method === "GET" && path === "/api/templates") {
      const templates = await readTemplates();
      return json(templates);
    }

    // POST /api/test-connection
    if (method === "POST" && path === "/api/test-connection") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const { db_host, db_port, db_name, db_user, password } = body || {};
      if (!db_host || !db_name || !db_user || !password) {
        return json(
          {
            error:
              "Missing required fields: db_host, db_name, db_user, password",
          },
          400,
        );
      }

      const port =
        typeof db_port === "string" && db_port.trim().length > 0
          ? db_port.trim()
          : "3306";
      const args = ["-h", db_host, "-P", port, "-u", db_user, "-D", db_name, "-e", "SELECT 1;"];

      try {
        const result = await new Promise<{ code: number | null }>(
          (resolve, reject) => {
            const child = spawn("mysql", args, {
              stdio: "ignore",
              env: { ...process.env, MYSQL_PWD: password },
            });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code }));
          },
        );

        if (result.code !== 0) {
          return json(
            {
              error:
                "Failed to connect. Check host, user, password, and database name.",
            },
            400,
          );
        }

        return json({ success: true, message: "Connection successful" });
      } catch (err: any) {
        return json(
          { error: err?.message || "Failed to run connection test" },
          500,
        );
      }
    }

    // POST /api/templates - create new template
    if (method === "POST" && path === "/api/templates") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const { name, template } = body;
      if (!name || typeof name !== "string") {
        return json({ error: "Missing or invalid 'name' field" }, 400);
      }
      if (!template || typeof template !== "object") {
        return json({ error: "Missing or invalid 'template' field" }, 400);
      }
      if (!template.databases || typeof template.databases !== "object") {
        return json({ error: "Template must have 'databases' object" }, 400);
      }
      if ("schedules" in template) {
        return json(
          { error: "Templates do not support schedules. Remove 'schedules'." },
          400,
        );
      }

      const templates = await readTemplates();
      if (templates[name]) {
        return json({ error: `Template '${name}' already exists` }, 409);
      }

      templates[name] = template;
      await writeTemplates(templates);
      return json({ success: true, name });
    }

    // PUT /api/templates/:name - update template
    if (method === "PUT" && path.startsWith("/api/templates/")) {
      const name = decodeURIComponent(path.slice("/api/templates/".length));
      if (!name) {
        return json({ error: "Template name required" }, 400);
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      if (!body.template || typeof body.template !== "object") {
        return json({ error: "Missing or invalid 'template' field" }, 400);
      }
      if (
        !body.template.databases ||
        typeof body.template.databases !== "object"
      ) {
        return json({ error: "Template must have 'databases' object" }, 400);
      }
      if ("schedules" in body.template) {
        return json(
          { error: "Templates do not support schedules. Remove 'schedules'." },
          400,
        );
      }

      const templates = await readTemplates();
      if (!templates[name]) {
        return json({ error: `Template '${name}' not found` }, 404);
      }

      templates[name] = body.template;
      await writeTemplates(templates);
      return json({ success: true, name });
    }

    // DELETE /api/templates/:name - delete template
    if (method === "DELETE" && path.startsWith("/api/templates/")) {
      const name = decodeURIComponent(path.slice("/api/templates/".length));
      if (!name) {
        return json({ error: "Template name required" }, 400);
      }

      const templates = await readTemplates();
      if (!templates[name]) {
        return json({ error: `Template '${name}' not found` }, 404);
      }

      delete templates[name];
      await writeTemplates(templates);
      return json({ success: true });
    }

    // GET /api/passwords - list configs with passwords
    if (method === "GET" && path === "/api/passwords") {
      const config = await readConfig();
      const configured = new Set(Object.keys(config.databases || {}));
      const configs = (await listPasswordConfigs()).filter((name) =>
        configured.has(name),
      );
      return json({ configs, decryptionFailed });
    }

    // GET /api/passwords/:configName - get password (internal use by backup script)
    if (method === "GET" && path.startsWith("/api/passwords/")) {
      const configName = decodeURIComponent(
        path.slice("/api/passwords/".length),
      );
      if (!configName) {
        return json({ error: "Config name required" }, 400);
      }

      const config = await readConfig();
      if (!config.databases?.[configName]) {
        return json(
          { error: `Database '${configName}' not found in config` },
          404,
        );
      }

      const password = await getPassword(configName);
      if (!password) {
        return json({ error: "Password not found" }, 404);
      }
      return json({ password });
    }

    // POST /api/passwords/:configName - save password
    if (method === "POST" && path.startsWith("/api/passwords/")) {
      const configName = decodeURIComponent(
        path.slice("/api/passwords/".length),
      );
      if (!configName) {
        return json({ error: "Config name required" }, 400);
      }

      const config = await readConfig();
      if (!config.databases?.[configName]) {
        return json(
          { error: `Database '${configName}' not found in config` },
          400,
        );
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!body.password || typeof body.password !== "string") {
        return json({ error: "Missing or invalid 'password' field" }, 400);
      }
      try {
        await setPassword(configName, body.password);
        return json({ success: true });
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }
    }

    // DELETE /api/passwords/:configName - delete password
    if (method === "DELETE" && path.startsWith("/api/passwords/")) {
      const configName = decodeURIComponent(
        path.slice("/api/passwords/".length),
      );
      if (!configName) {
        return json({ error: "Config name required" }, 400);
      }

      const config = await readConfig();
      if (!config.databases?.[configName]) {
        return json(
          { error: `Database '${configName}' not found in config` },
          400,
        );
      }

      await deletePassword(configName);
      return json({ success: true });
    }

    // GET /api/backups
    if (method === "GET" && path === "/api/backups") {
      const backups = await listBackups();
      return json(backups);
    }

    // GET /api/backups/:filename - download
    if (method === "GET" && path.startsWith("/api/backups/")) {
      const filename = decodeURIComponent(path.slice("/api/backups/".length));
      if (!isValidFilename(filename)) {
        return json({ error: "Invalid filename" }, 400);
      }
      const filePath = join(BACKUP_DIR, filename);
      let fileInfo: Awaited<ReturnType<typeof stat>>;
      try {
        fileInfo = await stat(filePath);
      } catch {
        return json({ error: "Backup not found" }, 404);
      }
      if (!fileInfo.isFile()) {
        return json({ error: "Backup not found" }, 404);
      }
      const file = Bun.file(filePath);
      return new Response(file.stream(), {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(fileInfo.size),
          "Cache-Control": "no-store, no-transform",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // DELETE /api/backups/:filename
    if (method === "DELETE" && path.startsWith("/api/backups/")) {
      const filename = decodeURIComponent(path.slice("/api/backups/".length));
      if (!isValidFilename(filename)) {
        return json({ error: "Invalid filename" }, 400);
      }
      const filePath = join(BACKUP_DIR, filename);
      try {
        await unlink(filePath);
        return json({ success: true });
      } catch {
        return json({ error: "Backup not found" }, 404);
      }
    }

    // POST /api/backups/trigger
    if (method === "POST" && path === "/api/backups/trigger") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const database = body.database;
      if (!database || typeof database !== "string") {
        return json({ error: "Missing or invalid 'database' field" }, 400);
      }

      // Verify database exists in config
      const config = await readConfig();
      if (!config.databases[database]) {
        return json(
          { error: `Database '${database}' not found in config` },
          400,
        );
      }

      const running = await listRunningStatuses();
      if (running.some((entry) => entry.database === database)) {
        return json(
          {
            error: `Backup already running for '${database}'`,
            status: running,
          },
          409,
        );
      }

      // Get password for this database
      const password = await getPassword(database);
      if (!password) {
        return json(
          {
            error: `No password configured for '${database}'. Please set the password in the database configuration.`,
          },
          400,
        );
      }

      triggerBackup(database, password).then((result) => {
        console.log(
          `Backup ${database} finished:`,
          result.success ? "OK" : result.message,
        );
      });

      return json({
        success: true,
        message: `Backup triggered for ${database}`,
      });
    }

    // GET /api/status
    if (method === "GET" && path === "/api/status") {
      const status = await getBackupStatus();
      return json(status);
    }

    // GET /api/config
    if (method === "GET" && path === "/api/config") {
      const config = await readConfig();
      return json(config);
    }

    // PUT /api/config
    if (method === "PUT" && path === "/api/config") {
      let newConfig: any;
      try {
        newConfig = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      // Validate required fields
      if (
        typeof newConfig.retention !== "number" ||
        !newConfig.databases ||
        typeof newConfig.databases !== "object"
      ) {
        return json(
          {
            error:
              "Missing required fields: retention (number), databases (object)",
          },
          400,
        );
      }

      if (!Array.isArray(newConfig.schedules)) {
        return json(
          { error: "Missing required field: schedules (array)" },
          400,
        );
      }

      // Validate each schedule
      for (const schedule of newConfig.schedules) {
        if (!schedule.database || !schedule.cron) {
          return json(
            { error: "Each schedule must have 'database' and 'cron' fields" },
            400,
          );
        }
        if (!newConfig.databases[schedule.database]) {
          return json(
            {
              error: `Schedule references unknown database: '${schedule.database}'`,
            },
            400,
          );
        }
        const cronErr = validateCron(schedule.cron);
        if (cronErr) {
          return json(
            { error: `Invalid cron for '${schedule.database}': ${cronErr}` },
            400,
          );
        }
      }

      await writeConfig(newConfig);
      regenerateCrontab(newConfig);
      return json({ success: true });
    }

    // GET /api/logs
    if (method === "GET" && path === "/api/logs") {
      try {
        const logContent = await readFile(LOG_FILE, "utf-8");
        const cleaned = logContent.trimEnd();
        if (!cleaned) {
          return new Response("No logs available yet.\n", {
            headers: { "Content-Type": "text/plain" },
          });
        }
        const lines = cleaned.split("\n");
        const tailLines = lines.slice(-200).reverse();
        const tail = `${tailLines.join("\n")}\n`;
        return new Response(tail, {
          headers: { "Content-Type": "text/plain" },
        });
      } catch {
        return new Response("No logs available yet.\n", {
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // GET /api/dev-reload (dev only)
    if (method === "GET" && path === "/api/dev-reload") {
      if (!DEV) return json({ error: "Not found" }, 404);

      ensureDevReloadWatcher();
      let clientRef: { write: (chunk: string) => Promise<void> } | null = null;
      const stream = new ReadableStream({
        start(controller) {
          const client = {
            write: async (chunk: string) => {
              controller.enqueue(chunk);
            },
          };
          clientRef = client;
          devReloadClients.add(client);
          controller.enqueue("event: ready\ndata: connected\n\n");
        },
        cancel() {
          if (clientRef) {
            devReloadClients.delete(clientRef);
            clientRef = null;
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // GET /llms.txt
    if (method === "GET" && path === "/llms.txt") {
      try {
        const content = await readFile(join(STATIC_DIR, "llms.txt"), "utf-8");
        return new Response(content, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch {
        return json({ error: "Not found" }, 404);
      }
    }

    // --- Static Files ---
    if (path === "/" || path === "/index.html") {
      return await serveIndexHtml();
    }

    const staticPath = join(STATIC_DIR, path.slice(1));
    const resolvedStatic = resolve(staticPath);
    if (resolvedStatic.startsWith(STATIC_DIR)) {
      const file = Bun.file(resolvedStatic);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    return json({ error: "Not found" }, 404);
  },
});

// Run config migration on startup
readConfig()
  .then((config) => {
    regenerateCrontab(config);
    console.log(`DB Backup server running on ${HOST}:${PORT}`);
  })
  .catch((err) => {
    console.error("Failed to read config on startup:", err);
    console.log(`DB Backup server running on ${HOST}:${PORT}`);
  });
