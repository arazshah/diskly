import {
  existsSync, mkdirSync, renameSync, rmSync, statSync, lstatSync,
  appendFileSync, readFileSync, symlinkSync, readdirSync, unlinkSync,
} from "node:fs";
import { dirname, join, basename, resolve, relative } from "node:path";
import { QUARANTINE, JOURNAL, HOME, ensureDirs, tilde } from "./config.ts";
import { checkSafe } from "./protect.ts";
import { quickSize } from "./scan.ts";
import { fmtSize, DAY } from "./format.ts";

export type Op = "delete" | "quarantine" | "move" | "restore" | "cmd" | "undo";

export interface JournalEntry {
  ts: number;
  op: Op;
  src: string;
  dest?: string;
  size: number;
  rule?: string;
  linked?: boolean;
  ok: boolean;
  err?: string;
}

export interface ActionResult {
  ok: boolean;
  op: Op;
  src: string;
  dest?: string;
  size: number;
  freed: number;
  err?: string;
  dryRun: boolean;
  entry?: JournalEntry;
}

export interface ActOpts {
  dryRun?: boolean;
  allowSystem?: boolean;
  link?: boolean;
  rule?: string;
  sudo?: boolean;
}

export function logEntry(e: JournalEntry) {
  try {
    ensureDirs();
    appendFileSync(JOURNAL, JSON.stringify(e) + "\n", "utf8");
  } catch {}
}

export function readJournal(limit = 200): JournalEntry[] {
  try {
    if (!existsSync(JOURNAL)) return [];
    const lines = readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean);
    const out: JournalEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export function sizeOf(p: string): number {
  try {
    const st = lstatSync(p);
    if (st.isDirectory()) return quickSize(p).size;
    return st.size;
  } catch {
    return 0;
  }
}

function devOf(p: string): number {
  try {
    return statSync(p).dev;
  } catch {
    try { return statSync(dirname(p)).dev; } catch { return -1; }
  }
}

function ensureParent(p: string) {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const d = dirname(p), b = basename(p);
  const dot = b.lastIndexOf(".");
  const stem = dot > 0 ? b.slice(0, dot) : b;
  const ext = dot > 0 ? b.slice(dot) : "";
  for (let i = 1; i < 9999; i++) {
    const c = join(d, `${stem}.${i}${ext}`);
    if (!existsSync(c)) return c;
  }
  return `${p}.${Date.now()}`;
}

function run(cmd: string[], sudo = false): { ok: boolean; err?: string } {
  const full = sudo ? ["sudo", ...cmd] : cmd;
  try {
    const r = Bun.spawnSync(full, { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) return { ok: true };
    return { ok: false, err: (r.stderr?.toString() || "").trim().slice(0, 300) || `exit ${r.exitCode}` };
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e) };
  }
}

const HAS_RSYNC = (() => {
  try { return Bun.spawnSync(["which", "rsync"]).exitCode === 0; } catch { return false; }
})();

function statSyncDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

function movePhysical(src: string, dest: string, sudo = false): { ok: boolean; err?: string } {
  if (devOf(src) === devOf(dirname(dest))) {
    try { renameSync(src, dest); return { ok: true }; } catch {}
  }
  if (HAS_RSYNC) {
    const r = run(["rsync", "-aHAXq", "--remove-source-files", src + (statSyncDir(src) ? "/" : ""), dest + (statSyncDir(src) ? "/" : "")], sudo);
    if (r.ok) {
      if (statSyncDir(src)) run(["rm", "-rf", src], sudo);
      return { ok: true };
    }
    if (!statSyncDir(src)) return r;
  }
  const cp = run(["cp", "-a", src, dest], sudo);
  if (!cp.ok) return cp;
  return run(["rm", "-rf", src], sudo);
}

export function removePath(src: string, o: ActOpts = {}): ActionResult {
  const p = resolve(src);
  const base: ActionResult = { ok: false, op: "delete", src: p, size: 0, freed: 0, dryRun: !!o.dryRun };
  const v = checkSafe(p, { allowSystem: o.allowSystem });
  if (!v.ok) return { ...base, err: v.reason };
  if (!existsSync(p)) return { ...base, err: "does not exist" };

  const size = sizeOf(p);
  if (o.dryRun) return { ...base, ok: true, size, freed: size };

  let err: string | undefined;
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (e: any) {
    const r = run(["rm", "-rf", p], o.sudo);
    if (!r.ok) err = r.err || String(e?.code || e);
  }
  const ok = !err && !existsSync(p);
  logEntry({ ts: Date.now(), op: "delete", src: p, size, rule: o.rule, ok, err });
  return { ...base, ok, size, freed: ok ? size : 0, err };
}

export function quarantinePath(src: string, o: ActOpts = {}): ActionResult {
  const p = resolve(src);
  const base: ActionResult = { ok: false, op: "quarantine", src: p, size: 0, freed: 0, dryRun: !!o.dryRun };
  const v = checkSafe(p, { allowSystem: o.allowSystem });
  if (!v.ok) return { ...base, err: v.reason };
  if (!existsSync(p)) return { ...base, err: "does not exist" };

  const size = sizeOf(p);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const dest = join(QUARANTINE, `${stamp}__${basename(p)}`);
  if (o.dryRun) return { ...base, ok: true, size, freed: size, dest };

  ensureDirs();
  ensureParent(dest);
  const r = movePhysical(p, dest, o.sudo);
  const ok = r.ok;
  logEntry({ ts: Date.now(), op: "quarantine", src: p, dest, size, rule: o.rule, ok, err: r.err });
  return { ...base, ok, size, freed: ok ? size : 0, dest, err: r.err };
}

export function movePath(src: string, destRoot: string, o: ActOpts = {}): ActionResult {
  const p = resolve(src);
  const base: ActionResult = { ok: false, op: "move", src: p, size: 0, freed: 0, dryRun: !!o.dryRun };
  const v = checkSafe(p, { allowSystem: o.allowSystem });
  if (!v.ok) return { ...base, err: v.reason };
  if (!existsSync(p)) return { ...base, err: "does not exist" };

  const root = resolve(destRoot);
  if (p === root || root.startsWith(p + "/")) return { ...base, err: "destination is inside the source" };

  const rel = p.startsWith(HOME + "/") ? join("home", relative(HOME, p)) : p.replace(/^\//, "");
  let dest = join(root, rel);
  const size = sizeOf(p);

  if (o.dryRun) return { ...base, ok: true, size, freed: size, dest };

  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  } catch (e: any) {
    return { ...base, err: `destination could not be created: ${e?.code}` };
  }
  dest = uniquePath(dest);
  ensureParent(dest);

  const r = movePhysical(p, dest, o.sudo);
  let linked = false;
  if (r.ok && o.link) {
    try { symlinkSync(dest, p); linked = true; } catch {}
  }
  logEntry({ ts: Date.now(), op: "move", src: p, dest, size, rule: o.rule, linked, ok: r.ok, err: r.err });
  return { ...base, ok: r.ok, size, freed: r.ok ? size : 0, dest, err: r.err };
}

export function restore(e: JournalEntry, o: ActOpts = {}): ActionResult {
  const base: ActionResult = { ok: false, op: "restore", src: e.dest || "", dest: e.src, size: e.size, freed: 0, dryRun: !!o.dryRun };
  if (!e.dest) return { ...base, err: "this operation cannot be undone (permanent delete)" };
  if (!existsSync(e.dest)) return { ...base, err: "saved copy not found" };
  if (o.dryRun) return { ...base, ok: true };

  if (e.linked) {
    try { if (lstatSync(e.src).isSymbolicLink()) unlinkSync(e.src); } catch {}
  }
  if (existsSync(e.src)) return { ...base, err: "original path is occupied" };

  ensureParent(e.src);
  const r = movePhysical(e.dest, e.src, o.sudo);
  logEntry({ ts: Date.now(), op: "restore", src: e.dest, dest: e.src, size: e.size, ok: r.ok, err: r.err });
  return { ...base, ok: r.ok, freed: 0, entry: e, err: r.err };
}

export function undoLast(): ActionResult {
  for (const e of readJournal(50)) {
    if ((e.op === "move" || e.op === "quarantine") && e.ok && e.dest) {
      return restore(e);
    }
  }
  return { ok: false, op: "undo", src: "", size: 0, freed: 0, dryRun: false, err: "nothing to undo" };
}

export function quarantineList(): Array<{ path: string; size: number; ts: number }> {
  ensureDirs();
  const out: Array<{ path: string; size: number; ts: number }> = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(QUARANTINE); } catch { return out; }
  for (const d of dirs) {
    const full = join(QUARANTINE, d);
    let st: any;
    try { st = lstatSync(full); } catch { continue; }
    out.push({ path: full, size: sizeOf(full), ts: +st.mtimeMs });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export function quarantineSize(): { bytes: number; count: number } {
  const list = quarantineList();
  return {
    bytes: list.reduce((s, x) => s + x.size, 0),
    count: list.length,
  };
}

export function summaryLine(e: JournalEntry): string {
  const icon = e.op === "delete" ? "🗑" : e.op === "quarantine" ? "📥" : e.op === "move" ? "📦" : e.op === "restore" ? "↩" : "•";
  const okMark = e.ok ? "" : " ⚠ failed";
  const extra = e.dest ? ` → ${basename(e.dest)}` : "";
  return `${icon} ${fmtSize(e.size).padStart(8)}  ${tilde(e.src)}${extra}${okMark}`;
}
