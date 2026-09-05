import { DAY } from "./format.ts";

export interface FsNode {
  name: string;
  parent: DirNode | null;
  isDir: boolean;
  size: number;      // apparent size (bytes)
  disk: number;      // real disk usage (blocks*512)
  mtime: number;     // last modification
  atime: number;     // last access
  birth: number;     // creation time
  nFiles: number;    // cumulative file count
  nDirs: number;     // cumulative directory count
  lastUsed: number;  // max atime in subtree
  newest: number;    // max mtime in subtree
  dev: number;
  link?: string;     // if it is a symlink
  err?: string;      // EACCES etc.
  tag?: string;      // junk rule id
}

export interface DirNode extends FsNode {
  isDir: true;
  children: FsNode[];
  smallCount: number;   // small files aggregated together
  smallSize: number;
  mountStub?: boolean;  // another filesystem; not entered
  loaded: boolean;
}

export function isDirNode(n: FsNode): n is DirNode { return n.isDir; }

export function pathOf(n: FsNode): string {
  const parts: string[] = [];
  let cur: FsNode | null = n;
  while (cur) { parts.push(cur.name); cur = cur.parent; }
  parts.reverse();
  let p = parts.join("/");
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/{2,}/g, "/");
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export function ancestors(n: FsNode): FsNode[] {
  const out: FsNode[] = [];
  let cur: FsNode | null = n;
  while (cur) { out.push(cur); cur = cur.parent; }
  return out.reverse();
}

export type SortKey = "size" | "disk" | "mtime" | "atime" | "name" | "count";
export const SORT_ORDER: SortKey[] = ["size", "disk", "mtime", "atime", "count", "name"];
export const SORT_LABELS: Record<SortKey, string> = {
  size: "size", disk: "on-disk", mtime: "modified",
  atime: "last-used", count: "files", name: "name",
};

export function sortNodes(list: FsNode[], key: SortKey, asc = false) {
  const d = asc ? 1 : -1;
  list.sort((a, b) => {
    switch (key) {
      case "name": return a.name.localeCompare(b.name) * (asc ? 1 : -1);
      case "mtime": return (a.newest - b.newest) * d;
      case "atime": return (a.lastUsed - b.lastUsed) * d;
      case "count": return (a.nFiles - b.nFiles) * d;
      case "disk": return (a.disk - b.disk) * d;
      default: return (a.size - b.size) * d;
    }
  });
}

/** Walk the whole tree. If the callback returns false, children are not entered. */
export function walkAll(root: FsNode, fn: (n: FsNode, depth: number) => void | false) {
  const stack: Array<[FsNode, number]> = [[root, 0]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (fn(n, d) === false) continue;
    if (n.isDir) {
      const ch = (n as DirNode).children;
      for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], d + 1]);
    }
  }
}

export function countNodes(root: FsNode): number {
  let c = 0; walkAll(root, () => { c++; }); return c;
}

export function topFiles(root: FsNode, limit = 200, minSize = 0): FsNode[] {
  const out: FsNode[] = [];
  walkAll(root, (n) => { if (!n.isDir && n.size >= minSize) out.push(n); });
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit);
}

export function topDirs(root: FsNode, limit = 200, minSize = 0): FsNode[] {
  const out: FsNode[] = [];
  walkAll(root, (n) => { if (n.isDir && n !== root && n.size >= minSize) out.push(n); });
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit);
}

/** Large "cold" items: not read or modified for a long time */
export function coldItems(root: FsNode, days: number, minSize: number, limit = 200): FsNode[] {
  const cut = Date.now() - days * DAY;
  const out: FsNode[] = [];
  walkAll(root, (n) => {
    if (n === root) return;
    const used = Math.max(n.lastUsed || 0, n.newest || 0);
    if (n.size >= minSize && used > 0 && used < cut) { out.push(n); return false; }
  });
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit);
}

/** Overall tree statistics */
export function summarize(root: FsNode) {
  let files = 0, dirs = 0, errs = 0;
  walkAll(root, (n) => { if (n.isDir) { dirs++; if (n.err) errs++; } else files++; });
  return { files, dirs, errs, size: root.size, disk: root.disk };
}

/** Find a node by absolute path (in the scanned tree) */
export function findNode(root: DirNode, target: string): FsNode | null {
  const rp = pathOf(root);
  if (target === rp) return root;
  if (!target.startsWith(rp)) return null;
  const rest = target.slice(rp === "/" ? 1 : rp.length + 1).split("/").filter(Boolean);
  let cur: FsNode = root;
  for (const seg of rest) {
    if (!cur.isDir) return null;
    const nx = (cur as DirNode).children.find((c) => c.name === seg);
    if (!nx) return null;
    cur = nx;
  }
  return cur;
}

/** Detach a node from its parent and fix the totals up to the root (after delete/move) */
export function detachNode(n: FsNode) {
  const p = n.parent;
  if (!p) return;
  const i = p.children.indexOf(n);
  if (i >= 0) p.children.splice(i, 1);
  let cur: DirNode | null = p;
  while (cur) {
    cur.size -= n.size;
    cur.disk -= n.disk;
    cur.nFiles -= n.isDir ? n.nFiles : 1;
    cur.nDirs -= n.isDir ? n.nDirs + 1 : 0;
    cur = cur.parent;
  }
}
