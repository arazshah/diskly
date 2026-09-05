import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const HOME = homedir();
export const OS = platform();
export const CFG_DIR = join(HOME, ".config", "diskly");
export const DATA_DIR = join(HOME, ".local", "share", "diskly");
export const QUARANTINE = join(DATA_DIR, "quarantine");
export const JOURNAL = join(DATA_DIR, "journal.jsonl");
export const LOGFILE = join(DATA_DIR, "guard.log");
export const DBFILE = join(DATA_DIR, "history.sqlite");
export const CFG_FILE = join(CFG_DIR, "config.json");

export interface Config {
  avalai: { baseUrl: string; apiKey: string; model: string; maxItems: number; redactHome: boolean; timeoutMs: number };
  scan: { keepFileMin: number; crossDevice: boolean; excludes: string[]; maxDepth: number };
  guard: {
    enabled: boolean; intervalMin: number; warnPct: number; actPct: number;
    autoClean: boolean; quarantineTtlDays: number; watch: string[]; notify: boolean;
  };
  moveTargets: string[];
  coldDays: number;
  bigFileMin: number;
  dupeMin: number;
}

const DEFAULTS: Config = {
  avalai: {
    baseUrl: process.env.AVALAI_BASE_URL || "https://api.avalai.ir/v1",
    apiKey: process.env.AVALAI_API_KEY || "",
    model: process.env.AVALAI_MODEL || "gpt-4o-mini",
    maxItems: 60, redactHome: true, timeoutMs: 60_000,
  },
  scan: {
    keepFileMin: 1024 * 1024,
    crossDevice: false,
    maxDepth: 40,
    excludes: [
      "/proc", "/sys", "/dev", "/run", "/var/run", "/snap",
      "/System/Volumes", "/Volumes/Recovery", "/private/var/vm",
      join(HOME, ".local/share/diskly/quarantine"),
    ],
  },
  guard: {
    enabled: true, intervalMin: 15, warnPct: 85, actPct: 92,
    autoClean: true, quarantineTtlDays: 14, watch: ["/", HOME], notify: true,
  },
  moveTargets: [],
  coldDays: 180,
  bigFileMin: 100 * 1024 * 1024,
  dupeMin: 5 * 1024 * 1024,
};

export function ensureDirs() {
  for (const d of [CFG_DIR, DATA_DIR, QUARANTINE]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

let cache: Config | null = null;

export function loadConfig(force = false): Config {
  if (cache && !force) return cache;
  ensureDirs();
  let u: any = {};
  try { if (existsSync(CFG_FILE)) u = JSON.parse(readFileSync(CFG_FILE, "utf8")); } catch { u = {}; }
  const merged: Config = {
    ...DEFAULTS, ...u,
    avalai: { ...DEFAULTS.avalai, ...(u.avalai || {}) },
    scan: { ...DEFAULTS.scan, ...(u.scan || {}) },
    guard: { ...DEFAULTS.guard, ...(u.guard || {}) },
  };
  if (process.env.AVALAI_API_KEY) {
    merged.avalai.apiKey = process.env.AVALAI_API_KEY;
  }
  cache = merged;
  return merged;
}

export function saveConfig(c: Config) {
  ensureDirs();
  writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), "utf8");
  cache = c;
}

export function initConfigFile(): string {
  ensureDirs();
  if (!existsSync(CFG_FILE)) writeFileSync(CFG_FILE, JSON.stringify(DEFAULTS, null, 2), "utf8");
  return CFG_FILE;
}

export function tilde(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}
export function expand(p: string): string {
  return p.startsWith("~") ? join(HOME, p.slice(1)) : p;
}
