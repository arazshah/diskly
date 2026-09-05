import { openSync, readSync, closeSync, lstatSync, existsSync, linkSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { walkAll, pathOf, type FsNode } from "./tree.ts";
import { fmtSize } from "./format.ts";
import { isProtected } from "./protect.ts";
import { logEntry } from "./actions.ts";

const HEAD = 16 * 1024;   // first bytes used for pre-filter
const CHUNK = 256 * 1024;

export interface DupeFile {
  path: string;
  size: number;
  mtime: number;
  dev: number;
  ino: number;
  nlink: number;
  keep: boolean;      // the copy we keep
}

export interface DupeGroup {
  hash: string;
  size: number;          // size of each copy
  files: DupeFile[];
  wasted: number;        // wasted space = size * (n-1)
  sameDevice: boolean;   // all on one filesystem? (for hardlink)
}

export interface DupeOpts {
  minSize?: number;
  maxFiles?: number;              // cap on files to hash-scan
  limit?: number;                 // cap on output groups
  sameNameOnly?: boolean;         // only same-named files
  onProgress?: (done: number, total: number, path: string) => void;
  signal?: { aborted: boolean };
}

export interface DupeResult {
  groups: DupeGroup[];
  wasted: number;
  candidates: number;   // files that were hashed
  hashed: number;       // bytes read
  ms: number;
  aborted: boolean;
}

// ───────────── Hashing ─────────────
function hashPart(path: string, bytes: number): string | null {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const h = createHash("sha1");
    const buf = Buffer.allocUnsafe(Math.min(bytes, CHUNK));
    let left = bytes;
    while (left > 0) {
      const n = readSync(fd, buf, 0, Math.min(left, buf.length), null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      left -= n;
    }
    return h.digest("hex");
  } catch { return null; }
  finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}

function hashFull(path: string): string | null {
  return hashPart(path, Number.MAX_SAFE_INTEGER);
}

// ───────────── Choosing the copy to keep ─────────────
/** Oldest + shortest path wins (likely the original copy) */
function pickKeeper(files: DupeFile[]) {
  const score = (f: DupeFile) => {
    let s = 0;
    if (/\/(Downloads|Desktop|tmp|temp|Trash)\//i.test(f.path)) s += 100;
    if (/(copy|\(\d+\)|_\d+|\bduplicate\b)/i.test(basename(f.path))) s += 60;
    s += f.path.split("/").length;                 // deeper = less valuable
    s += f.path.length / 200;
    s += f.mtime / 1e13;                           // newer = less valuable
    return s;
  };
  const sorted = [...files].sort((a, b) => score(a) - score(b));
  for (const f of files) f.keep = false;
  sorted[0].keep = true;
  return sorted;
}

// ───────────── Main engine ─────────────
export function findDupes(root: FsNode, opts: DupeOpts = {}): DupeResult {
  const t0 = performance.now();
  const minSize = opts.minSize ?? 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 200_000;
  let hashedBytes = 0;

  // 1) Collect and group by size
  const bySize = new Map<number, FsNode[]>();
  const seenInode = new Set<string>();
  let count = 0;

  walkAll(root, (n) => {
    if (n.isDir || n.link || n.size < minSize) return;
    if (count >= maxFiles) return false;
    const key = `${n.dev}:${n.name}`;
    void key;
    let arr = bySize.get(n.size);
    if (!arr) { arr = []; bySize.set(n.size, arr); }
    arr.push(n); count++;
  });

  // 2) Pre-filter: hash the file head
  const candidates: FsNode[] = [];
  for (const [, arr] of bySize) if (arr.length > 1) candidates.push(...arr);
  const total = candidates.length;

  const byHead = new Map<string, DupeFile[]>();
  let done = 0;

  for (const [size, arr] of bySize) {
    if (opts.signal?.aborted) break;
    if (arr.length < 2) continue;

    // Optional grouping by name
    const buckets = opts.sameNameOnly
      ? [...arr.reduce((m, n) => { const k = n.name.toLowerCase(); (m.get(k) ?? m.set(k, []).get(k)!).push(n); return m; }, new Map<string, FsNode[]>()).values()]
      : [arr];

    for (const bucket of buckets) {
      if (bucket.length < 2) continue;
      for (const n of bucket) {
        if (opts.signal?.aborted) break;
        const p = pathOf(n);
        done++;
        if ((done & 0x3f) === 0) opts.onProgress?.(done, total, p);

        let st: any;
        try { st = lstatSync(p); } catch { continue; }
        if (!st.isFile()) continue;

        // hardlink: count only once
        const ik = `${st.dev}:${st.ino}`;
        if (st.nlink > 1 && seenInode.has(ik)) continue;
        seenInode.add(ik);

        const head = hashPart(p, Math.min(size, HEAD));
        if (!head) continue;
        hashedBytes += Math.min(size, HEAD);

        const k = `${size}:${head}`;
        let g = byHead.get(k);
        if (!g) { g = []; byHead.set(k, g); }
        g.push({ path: p, size, mtime: +st.mtimeMs, dev: st.dev, ino: st.ino, nlink: st.nlink, keep: false });
      }
    }
  }

  // 3) Full hash for suspicious groups
  const groups: DupeGroup[] = [];
  for (const [k, files] of byHead) {
    if (opts.signal?.aborted) break;
    if (files.length < 2) continue;
    const size = files[0].size;

    // If the file is smaller than HEAD, head hash == full hash
    if (size <= HEAD) {
      groups.push(mkGroup(k.split(":")[1], size, files));
      continue;
    }

    const byFull = new Map<string, DupeFile[]>();
    for (const f of files) {
      opts.onProgress?.(done, total, f.path);
      const h = hashFull(f.path);
      if (!h) continue;
      hashedBytes += size;
      let g = byFull.get(h);
      if (!g) { g = []; byFull.set(h, g); }
      g.push(f);
    }
    for (const [h, g] of byFull) if (g.length > 1) groups.push(mkGroup(h, size, g));
  }

  groups.sort((a, b) => b.wasted - a.wasted);
  const out = opts.limit ? groups.slice(0, opts.limit) : groups;

  return {
    groups: out,
    wasted: out.reduce((s, g) => s + g.wasted, 0),
    candidates: total,
    hashed: hashedBytes,
    ms: performance.now() - t0,
    aborted: !!opts.signal?.aborted,
  };
}

function mkGroup(hash: string, size: number, files: DupeFile[]): DupeGroup {
  const sorted = pickKeeper(files);
  const dev = files[0].dev;
  return {
    hash: hash.slice(0, 12),
    size,
    files: sorted,
    wasted: size * (files.length - 1),
    sameDevice: files.every((f) => f.dev === dev),
  };
}

// ───────────── Operations on duplicates ─────────────
export interface DupeAction { path: string; ok: boolean; freed: number; err?: string }

/** Delete duplicate copies (the keep copy stays untouched) */
export function dropDupes(groups: DupeGroup[], dryRun = true): DupeAction[] {
  const out: DupeAction[] = [];
  for (const g of groups) {
    for (const f of g.files) {
      if (f.keep) continue;
      if (isProtected(f.path)) { out.push({ path: f.path, ok: false, freed: 0, err: "protected" }); continue; }
      if (dryRun) { out.push({ path: f.path, ok: true, freed: f.size }); continue; }
      try {
        unlinkSync(f.path);
        logEntry({ ts: Date.now(), op: "delete", src: f.path, size: f.size, rule: "dupe", ok: true });
        out.push({ path: f.path, ok: true, freed: f.size });
      } catch (e: any) {
        out.push({ path: f.path, ok: false, freed: 0, err: e?.code || String(e) });
      }
    }
  }
  return out;
}

/** Replace duplicates with hardlinks — content stays, space is freed */
export function linkDupes(groups: DupeGroup[], dryRun = true): DupeAction[] {
  const out: DupeAction[] = [];
  for (const g of groups) {
    if (!g.sameDevice) continue;
    const keeper = g.files.find((f) => f.keep);
    if (!keeper || !existsSync(keeper.path)) continue;
    for (const f of g.files) {
      if (f.keep) continue;
      if (f.ino === keeper.ino) continue;                    // already linked
      if (isProtected(f.path)) { out.push({ path: f.path, ok: false, freed: 0, err: "protected" }); continue; }
      if (dryRun) { out.push({ path: f.path, ok: true, freed: f.size }); continue; }
      const bak = f.path + ".diskly-bak";
      try {
        renameSync(f.path, bak);
        linkSync(keeper.path, f.path);
        unlinkSync(bak);
        logEntry({ ts: Date.now(), op: "delete", src: f.path, dest: keeper.path, size: f.size, rule: "dupe-link", ok: true });
        out.push({ path: f.path, ok: true, freed: f.size });
      } catch (e: any) {
        try { if (existsSync(bak) && !existsSync(f.path)) renameSync(bak, f.path); } catch {}
        out.push({ path: f.path, ok: false, freed: 0, err: e?.code || String(e) });
      }
    }
  }
  return out;
}

export function dupeReport(r: DupeResult, top = 15): string {
  const L: string[] = [];
  L.push(`duplicate groups: ${r.groups.length} • wasted: ${fmtSize(r.wasted)} • read: ${fmtSize(r.hashed)} • ${(r.ms / 1000).toFixed(1)}s`);
  for (const g of r.groups.slice(0, top)) {
    L.push(`\n  ${fmtSize(g.size)} × ${g.files.length}  → wasted ${fmtSize(g.wasted)}${g.sameDevice ? "" : " (multi-disk)"}`);
    for (const f of g.files) L.push(`    ${f.keep ? "✔ keep      " : "✗ duplicate"}  ${f.path}`);
  }
  return L.join("\n");
}
