import { readdir, stat, unlink, readFile, writeFile, exists } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const PORT = parseInt(process.env.PORT || "3500", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const BACKUP_DIR = "/data/backups";
const CONFIG_FILE = "/data/config/config.json";
const LOG_FILE = "/data/logs/backup.log";
const STATUS_FILE = "/tmp/backup-status.json";
const STATIC_DIR = resolve(import.meta.dir, "static");

// --- SCONE templates for quick setup ---

const TEMPLATES: Record<string, { databases: Record<string, any>; schedules: any[] }> = {
  scone_production: {
    databases: {
      scone_production: {
        db_host: "icts-db-gbwdb1.icts.kuleuven.be",
        db_port: "3306",
        db_name: "scone_production",
        db_user: "scone_production",
        ignored_tables: [],
        structure_only_tables: [
          "cron_report",
          "cron_job",
          "DoctrineResultCache",
          "log__entries",
          "log__user_actions",
          "voucher",
          "voucher_backup",
          "Route",
          "messenger_messages",
        ],
      },
    },
    schedules: [{ database: "scone_production", cron: "0 */6 * * *" }],
  },
  scone_preview: {
    databases: {
      scone_preview: {
        db_host: "icts-db-gbwdb1.icts.kuleuven.be",
        db_port: "3306",
        db_name: "scone_preview",
        db_user: "scone_preview",
        ignored_tables: [],
        structure_only_tables: [
          "cron_report",
          "cron_job",
          "DoctrineResultCache",
          "log__entries",
          "log__user_actions",
          "voucher",
          "voucher_backup",
          "Route",
          "messenger_messages",
        ],
      },
    },
    schedules: [{ database: "scone_preview", cron: "0 */6 * * *" }],
  },
};

// --- Auth ---

function checkAuth(req: Request): Response | null {
  if (!AUTH_TOKEN) return null;
  const header = req.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== AUTH_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

// --- Config migration (old environments format -> new databases/schedules format) ---

function migrateConfig(config: any): { config: any; migrated: boolean } {
  if (!config.environments) return { config, migrated: false };

  const databases: Record<string, any> = {};
  const schedules: any[] = [];
  const schedule = config.schedule || "0 */6 * * *";

  for (const [env, envCfg] of Object.entries(config.environments) as [string, any][]) {
    const configName = `scone_${env}`;
    databases[configName] = {
      db_host: envCfg.db_host,
      db_port: envCfg.db_port || "3306",
      db_name: envCfg.db_name,
      db_user: envCfg.db_user,
      ignored_tables: [],
      structure_only_tables: [
        "cron_report",
        "cron_job",
        "DoctrineResultCache",
        "log__entries",
        "log__user_actions",
        "voucher",
        "voucher_backup",
        "Route",
        "messenger_messages",
      ],
    };

    if (envCfg.enabled) {
      schedules.push({ database: configName, cron: schedule });
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
    console.log("Config migrated from old environments format to new databases/schedules format");
  }
  return config;
}

async function writeConfig(config: any): Promise<void> {
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// --- Crontab generation ---

function regenerateCrontab(config: any): void {
  const lines: string[] = [
    "# DB Backup - auto-generated, do not edit manually",
    `SHELL=/bin/bash`,
    `PATH=/usr/local/bin:/usr/bin:/bin`,
    "",
  ];

  // Pass through all DB_PASS_* env vars dynamically
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("DB_PASS_") && value) {
      lines.push(`${key}=${value}`);
    }
  }
  lines.push("");

  for (const schedule of config.schedules || []) {
    const db = schedule.database;
    const cron = schedule.cron;
    if (db && cron) {
      lines.push(
        `${cron} root flock -n /tmp/backup-${db}.lock /app/scripts/backup.sh ${db} >> /data/logs/backup.log 2>&1`
      );
    }
  }

  lines.push("");
  Bun.write("/etc/cron.d/db-backup", lines.join("\n"));
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
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function resolveAlias(val: string, fieldIndex: number): number | null {
  const lower = val.toLowerCase();
  if (fieldIndex === 3 && MONTH_NAMES[lower] !== undefined) return MONTH_NAMES[lower];
  if (fieldIndex === 4 && DOW_NAMES_MAP[lower] !== undefined) return DOW_NAMES_MAP[lower];
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
      const resolved: number[] = [];
      for (const val of rangeParts) {
        const n = resolveAlias(val, i);
        if (n === null) {
          const hint = i === 3 ? " (use 1-12 or JAN-DEC)" : i === 4 ? " (use 0-7 or SUN-SAT)" : "";
          return `"${val}" is not valid in ${range.name}${hint}`;
        }
        if (n < range.min || n > range.max) return `${n} is out of range ${range.min}-${range.max} for ${range.name}`;
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
  return !name.includes("..") && !name.includes("/") && !name.includes("\\") && name.length > 0;
}

async function getBackupStatus(): Promise<any> {
  try {
    if (await exists(STATUS_FILE)) {
      const raw = await readFile(STATUS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // ignore parse errors
  }
  return { running: false };
}

interface BackupInfo {
  filename: string;
  size: number;
  sizeMB: string;
  date: string;
  database: string;
}

async function listBackups(): Promise<Record<string, BackupInfo[]>> {
  const files = await readdir(BACKUP_DIR);
  const backups: BackupInfo[] = [];

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

    backups.push({
      filename: file,
      size: fileStat.size,
      sizeMB: (fileStat.size / 1024 / 1024).toFixed(2),
      date: formattedDate,
      database,
    });
  }

  backups.sort((a, b) => b.date.localeCompare(a.date));

  const grouped: Record<string, BackupInfo[]> = {};
  for (const b of backups) {
    if (!grouped[b.database]) grouped[b.database] = [];
    grouped[b.database].push(b);
  }

  return grouped;
}

function triggerBackup(database: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const proc = spawn("/app/scripts/backup.sh", [database], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
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
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // GET /api/auth-required
    if (method === "GET" && path === "/api/auth-required") {
      return json({ required: !!AUTH_TOKEN });
    }

    // GET /api/templates
    if (method === "GET" && path === "/api/templates") {
      return json(TEMPLATES);
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
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return json({ error: "Backup not found" }, 404);
      }
      return new Response(file, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    // DELETE /api/backups/:filename
    if (method === "DELETE" && path.startsWith("/api/backups/")) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
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
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      const status = await getBackupStatus();
      if (status.running) {
        return json({ error: "A backup is already running", status }, 409);
      }

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
        return json({ error: `Database '${database}' not found in config` }, 400);
      }

      triggerBackup(database).then((result) => {
        console.log(`Backup ${database} finished:`, result.success ? "OK" : result.message);
      });

      return json({ success: true, message: `Backup triggered for ${database}` });
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
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      let newConfig: any;
      try {
        newConfig = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      // Validate required fields
      if (typeof newConfig.retention !== "number" || !newConfig.databases || typeof newConfig.databases !== "object") {
        return json({ error: "Missing required fields: retention (number), databases (object)" }, 400);
      }

      if (!Array.isArray(newConfig.schedules)) {
        return json({ error: "Missing required field: schedules (array)" }, 400);
      }

      // Validate each schedule
      for (const schedule of newConfig.schedules) {
        if (!schedule.database || !schedule.cron) {
          return json({ error: "Each schedule must have 'database' and 'cron' fields" }, 400);
        }
        if (!newConfig.databases[schedule.database]) {
          return json({ error: `Schedule references unknown database: '${schedule.database}'` }, 400);
        }
        const cronErr = validateCron(schedule.cron);
        if (cronErr) {
          return json({ error: `Invalid cron for '${schedule.database}': ${cronErr}` }, 400);
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
        const lines = logContent.split("\n");
        const tail = lines.slice(-200).join("\n");
        return new Response(tail, {
          headers: { "Content-Type": "text/plain" },
        });
      } catch {
        return new Response("No logs available yet.\n", {
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // --- Static Files ---
    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(join(STATIC_DIR, "index.html")));
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
readConfig().then((config) => {
  regenerateCrontab(config);
  console.log(`DB Backup server running on port ${PORT}`);
}).catch((err) => {
  console.error("Failed to read config on startup:", err);
  console.log(`DB Backup server running on port ${PORT}`);
});
