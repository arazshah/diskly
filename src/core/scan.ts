import { readdirSync, lstatSync, statSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { DirNode, FsNode } from "./tree.ts";
import { loadConfig } from "./config.ts";

export interface Progress {
  path: string; files: number; dirs: number; bytes: number; errors: number; done: boolean;
}
export interface ScanOpts {
  keepFileMin?: number;
  crossDevice?: boolean;
  excludes?: string[];
  maxDepth?: number;
  onProgress?: (p: Progress) => void;
  signal?: { aborted: boolean };
}
export interface ScanResult { root: DirNode; progress: Progress; ms: number; aborted: boolean }

function mkDir(name: string, parent: DirNode | null, st: any): DirNode {
  return {
    name, parent, isDir: true, size: 0, disk: 0,
    mtime: +st.mtimeMs, atime: +st.atimeMs,
    birth: +st.birthtimeMs || +st.ctimeMs || +st.mtimeMs,
    nFiles: 0, nDirs: 0, lastUsed: +st.atimeMs, newest: +st.mtimeMs,
    dev: st.dev, children: [], smallCount: 0, smallSize: 0, loaded: false,
  };
}

function mkFile(name: string, parent: DirNode, st: any, size: number, disk: number): FsNode {
  return {
    name, parent, isDir: false, size, disk,
    mtime: +st.mtimeMs, atime: +st.atimeMs,
    birth: +st.birthtimeMs || +st.ctimeMs || +st.mtimeMs,
    nFiles: 1, nDirs: 0, lastUsed: +st.atimeMs, newest: +st.mtimeMs, dev: st.dev,
  };
}

export function scan(rootPath: string, opts: ScanOpts = {}): ScanResult {
  const cfg = loadConfig();
  const keepMin = opts.keepFileMin ?? cfg.scan.keepFileMin;
  const cross = opts.crossDevice ?? cfg.scan.crossDevice;
  const maxDepth = opts.maxDepth ?? cfg.scan.maxDepth;
  const excl = new Set((opts.excludes ?? cfg.scan.excludes).map((e) => resolve(e)));

  const abs = resolve(rootPath);
  const t0 = performance.now();
  const prog: Progress = { path: abs, files: 0, dirs: 0, bytes: 0, errors: 0, done: false };

  let rst: any;
  try { rst = statSync(abs); }
  catch (e: any) { throw new Error(`path is not readable: ${abs} (${e?.code || e})`); }

  const rootDev = rst.dev;
  const seenLinks = new Set<string>();   // hardlink dedupe
  let counter = 0;

  const root = mkDir(abs === "/" ? "" : abs, null, rst);
  if (!rst.isDirectory()) {
    const f = mkFile(abs, root, rst, rst.size, (rst.blocks || 0) * 512);
    root.children.push(f); root.size = f.size; root.disk = f.disk; root.nFiles = 1;
    prog.done = true;
    return { root, progress: prog, ms: performance.now() - t0, aborted: false };
  }

  function bump(p: string) {
    if ((++counter & 0x1ff) === 0) { prog.path = p; opts.onProgress?.(prog); }
  }

  function walk(dirPath: string, node: DirNode, depth: number) {
    if (opts.signal?.aborted) return;
    let entries: any[];
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch (e: any) { node.err = e?.code || "EACCES"; prog.errors++; return; }
    node.loaded = true;
    prog.dirs++;

    for (const ent of entries) {
      if (opts.signal?.aborted) return;
      const full = dirPath === "/" ? `/${ent.name}` : `${dirPath}/${ent.name}`;
      if (excl.has(full)) continue;
      bump(full);

      let st: any;
      try { st = lstatSync(full); } catch { prog.errors++; continue; }

      // ---- symlink: never followed ----
      if (ent.isSymbolicLink()) {
        let tgt = "";
        try { tgt = readlinkSync(full); } catch {}
        const f = mkFile(ent.name, node, st, st.size, (st.blocks || 0) * 512);
        f.link = tgt;
        node.children.push(f);
        node.size += f.size; node.disk += f.disk; node.nFiles++;
        prog.files++;
        continue;
      }

      // ---- directory ----
      if (ent.isDirectory()) {
        const child = mkDir(ent.name, node, st);
        node.children.push(child);
        node.nDirs++;

        if (!cross && st.dev !== rootDev) { child.mountStub = true; continue; }
        if (depth + 1 > maxDepth) { child.err = "MAXDEPTH"; continue; }

        walk(full, child, depth + 1);

        node.size += child.size;
        node.disk += child.disk;
        node.nFiles += child.nFiles;
        node.nDirs += child.nDirs;
        if (child.lastUsed > node.lastUsed) node.lastUsed = child.lastUsed;
        if (child.newest > node.newest) node.newest = child.newest;
        continue;
      }

      // ---- regular file ----
      if (!ent.isFile()) continue;   // ignore socket/fifo/device

      let sz = st.size;
      let dk = (st.blocks || 0) * 512;
      if (st.nlink > 1) {
        const key = `${st.dev}:${st.ino}`;
        if (seenLinks.has(key)) { sz = 0; dk = 0; } else seenLinks.add(key);
      }

      prog.files++; prog.bytes += sz;
      node.size += sz; node.disk += dk; node.nFiles++;
      if (+st.atimeMs > node.lastUsed) node.lastUsed = +st.atimeMs;
      if (+st.mtimeMs > node.newest) node.newest = +st.mtimeMs;

      if (sz >= keepMin) node.children.push(mkFile(ent.name, node, st, sz, dk));
      else { node.smallCount++; node.smallSize += sz; }
    }
  }

  walk(abs, root, 0);
  prog.done = true;
  opts.onProgress?.(prog);
  return {
    root, progress: prog,
    ms: performance.now() - t0,
    aborted: !!opts.signal?.aborted,
  };
}

/** Quick size of a path without building a tree (for ad-hoc du) */
export function quickSize(p: string): { size: number; disk: number; files: number } {
  let size = 0, disk = 0, files = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop()!;
    let ents: any[];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = d === "/" ? `/${e.name}` : `${d}/${e.name}`;
      let st: any; try { st = lstatSync(f); } catch { continue; }
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(f);
      else { size += st.size; disk += (st.blocks || 0) * 512; files++; }
    }
  }
  return { size, disk, files };
}
