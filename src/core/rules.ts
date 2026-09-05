import { pathOf, walkAll, type FsNode } from "./tree.ts";
import { HOME, OS } from "./config.ts";
import { ageDays } from "./format.ts";
import { isProtected } from "./protect.ts";

export type Risk = "safe" | "review" | "danger";
export type Act = "delete" | "move" | "cmd" | "hint";

export interface JunkRule {
  id: string;
  label: string;
  why: string;
  risk: Risk;
  act: Act;
  cmd?: string;
  dirOnly?: boolean;
  fileOnly?: boolean;
  minAge?: number;
  minSize?: number;
  stop?: boolean;                 // do not enter children
  match(name: string, path: string, n: FsNode): boolean;
}

const MB = 1024 * 1024, GB = 1024 * MB;
const H = HOME;
const inHome = (p: string) => p.startsWith(H + "/");
const nameIs = (...xs: string[]) => (n: string) => xs.includes(n);
const isOne = (...xs: string[]) => (p: string) => xs.includes(p);

export const RULES: JunkRule[] = [
  // ═══ General caches ═══
  { id: "cache-home", label: "~/.cache", why: "app cache; rebuilt automatically", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => p === `${H}/.cache` },
  { id: "cache-mac", label: "~/Library/Caches", why: "macOS app cache", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => p === `${H}/Library/Caches` },
  { id: "logs-mac", label: "~/Library/Logs", why: "app logs", risk: "safe", act: "delete", dirOnly: true, stop: true, minAge: 14,
    match: (_n, p) => p === `${H}/Library/Logs` },
  { id: "thumbs", label: "thumbnails", why: "image thumbnails; rebuilt automatically", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => /\/(\.thumbnails|thumbnails)$/.test(p) },
  { id: "trash", label: "Trash", why: "trash bin; emptying it is safe", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne(`${H}/.local/share/Trash`, `${H}/.Trash`)(p) || /\/\.Trashe?s?$/.test(p) },

  // ═══ tmp ═══
  { id: "tmp-sys", label: "/tmp", why: "system temp files (worthless after reboot)", risk: "review", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne("/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp")(p) },
  { id: "tmp-name", label: "tmp/ temp/", why: "temp folder inside a project", risk: "review", act: "delete", dirOnly: true, stop: true, minAge: 14, minSize: 10 * MB,
    match: (n, p) => nameIs("tmp", "temp", ".tmp", "Temp")(n) && inHome(p) },

  // ═══ JS / Node ═══
  { id: "node_modules", label: "node_modules", why: "rebuilt with npm/bun install", risk: "review", act: "delete", dirOnly: true, stop: true, minSize: 20 * MB,
    match: (n) => n === "node_modules" },
  { id: "js-build", label: "build output", why: "build output; rebuilt with build", risk: "review", act: "delete", dirOnly: true, stop: true, minSize: 20 * MB,
    match: (n, p) => nameIs(".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".angular", "dist", "build", "out", ".output")(n) && inHome(p) },
  { id: "pkg-cache", label: "package manager cache", why: "npm/yarn/pnpm/bun cache", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne(`${H}/.npm/_cacache`, `${H}/.yarn/cache`, `${H}/.cache/yarn`,
      `${H}/.bun/install/cache`, `${H}/.local/share/pnpm/store`, `${H}/.pnpm-store`, `${H}/.deno/cache`)(p) },

  // ═══ Python ═══
  { id: "pycache", label: "__pycache__ & co", why: "Python cache", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (n) => nameIs("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".ipynb_checkpoints")(n) },
  { id: "venv", label: "venv / .venv", why: "rebuilt from requirements.txt", risk: "review", act: "delete", dirOnly: true, stop: true, minSize: 50 * MB,
    match: (n, p) => nameIs("venv", ".venv", "env", ".env-venv")(n) && inHome(p) },
  { id: "pip-cache", label: "pip cache", why: "pip install cache", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne(`${H}/.cache/pip`, `${H}/Library/Caches/pip`)(p) },
  { id: "hf-cache", label: "HuggingFace / torch cache", why: "downloaded model weights (re-downloadable)", risk: "review", act: "move", dirOnly: true, stop: true, minSize: 500 * MB,
    match: (_n, p) => isOne(`${H}/.cache/huggingface`, `${H}/.cache/torch`, `${H}/.cache/whisper`, `${H}/.ollama/models`)(p) },

  // ═══ Rust / Go / Java / C ═══
  { id: "cargo-cache", label: "cargo cache", why: "Rust crate cache", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne(`${H}/.cargo/registry/cache`, `${H}/.cargo/registry/src`, `${H}/.cargo/git/checkouts`)(p) },
  { id: "rust-target", label: "target/ (Rust)", why: "Rust compile output", risk: "review", act: "delete", dirOnly: true, stop: true, minSize: 100 * MB,
    match: (n, p) => n === "target" && inHome(p) },
  { id: "gradle", label: "Gradle caches", why: "Gradle dependency/daemon cache", risk: "review", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne(`${H}/.gradle/caches`, `${H}/.gradle/daemon`, `${H}/.kotlin`)(p) },
  { id: "maven", label: ".m2/repository", why: "local Maven repository", risk: "review", act: "move", dirOnly: true, stop: true, minSize: 200 * MB,
    match: (_n, p) => p === `${H}/.m2/repository` },
  { id: "go-mod", label: "go modcache", why: "Go module cache", risk: "safe", act: "cmd", cmd: "go clean -modcache", dirOnly: true, stop: true,
    match: (_n, p) => p === `${H}/go/pkg/mod` },
  { id: "ccache", label: "ccache", why: "C/C++ compiler cache", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => isOne(`${H}/.ccache`, `${H}/.cache/ccache`)(p) },

  // ═══ Xcode / Android ═══
  { id: "derived", label: "Xcode DerivedData", why: "Xcode build output", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => p === `${H}/Library/Developer/Xcode/DerivedData` },
  { id: "devsupport", label: "iOS DeviceSupport", why: "symbols of old devices", risk: "review", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => p === `${H}/Library/Developer/Xcode/iOS DeviceSupport` },
  { id: "simulators", label: "CoreSimulator", why: "unused simulators", risk: "review", act: "cmd", cmd: "xcrun simctl delete unavailable", dirOnly: true, stop: true,
    match: (_n, p) => p === `${H}/Library/Developer/CoreSimulator/Devices` },
  { id: "xc-archives", label: "Xcode Archives", why: "archives of old builds", risk: "review", act: "move", dirOnly: true, stop: true, minAge: 60,
    match: (_n, p) => p === `${H}/Library/Developer/Xcode/Archives` },
  { id: "avd", label: "Android AVD", why: "Android emulator image", risk: "review", act: "move", dirOnly: true, stop: true, minSize: 500 * MB,
    match: (_n, p) => p === `${H}/.android/avd` },
  { id: "sdk-images", label: "Android system-images", why: "unused SDK image", risk: "review", act: "move", dirOnly: true, stop: true, minSize: GB,
    match: (_n, p) => /\/(Android\/[Ss]dk|Android)\/system-images$/.test(p) },

  // ═══ Docker / VM ═══
  { id: "docker", label: "docker data", why: "docker images and layers — clean with `docker system prune -af`", risk: "danger", act: "cmd", cmd: "docker system prune -af --volumes", dirOnly: true, stop: true, minSize: GB,
    match: (_n, p) => isOne(`${H}/.docker`, `${H}/.local/share/docker`, "/var/lib/docker", `${H}/.docker/desktop`)(p) },
  { id: "podman", label: "podman storage", why: "podman images", risk: "danger", act: "cmd", cmd: "podman system prune -af", dirOnly: true, stop: true, minSize: GB,
    match: (_n, p) => p === `${H}/.local/share/containers` },
  { id: "vm-images", label: "VM disks", why: "virtual machine disks — better moved than deleted", risk: "review", act: "move", dirOnly: true, stop: true, minSize: GB,
    match: (_n, p) => isOne(`${H}/VirtualBox VMs`, `${H}/.local/share/libvirt/images`, `${H}/Virtual Machines.localized`, `${H}/.lima`, `${H}/.colima`)(p) },

  // ═══ Desktop apps ═══
  { id: "browser-cache", label: "browser cache", why: "browser cache", risk: "safe", act: "delete", dirOnly: true, stop: true, minSize: 50 * MB,
    match: (n, p) => nameIs("Cache", "Code Cache", "GPUCache", "ShaderCache", "CacheStorage", "Service Worker")(n) &&
      /(google-chrome|chromium|Firefox|BraveSoftware|Microsoft Edge|Vivaldi|Opera)/i.test(p) },
  { id: "electron-cache", label: "Electron app cache", why: "Electron app cache (VSCode/Slack/Discord…)", risk: "safe", act: "delete", dirOnly: true, stop: true, minSize: 50 * MB,
    match: (n, p) => nameIs("CachedData", "Cache", "Code Cache", "GPUCache", "logs", "Crashpad")(n) &&
      /(Code|VSCodium|Cursor|Slack|discord|Signal|Postman|Notion|obsidian)/i.test(p) },
  { id: "snap-flat", label: "snap/flatpak revisions", why: "old package revisions", risk: "review", act: "cmd", cmd: "flatpak uninstall --unused -y", dirOnly: true, stop: true, minSize: 500 * MB,
    match: (_n, p) => isOne(`${H}/.var/app`, `${H}/snap`)(p) },
  { id: "steam", label: "Steam / games shader", why: "game shader and download cache", risk: "safe", act: "delete", dirOnly: true, stop: true, minSize: 200 * MB,
    match: (_n, p) => /steamapps\/(shadercache|downloading|temp)$/.test(p) },
  { id: "crashdump", label: "crash reports", why: "app crash reports", risk: "safe", act: "delete", dirOnly: true, stop: true,
    match: (_n, p) => /(Crash(Reporter|es|pad)|DiagnosticReports|core_dumps|apport)$/i.test(p) },

  // ═══ Single files ═══
  { id: "f-partial", label: "incomplete downloads", why: "unfinished download", risk: "safe", act: "delete", fileOnly: true, minAge: 7,
    match: (n) => /\.(part|crdownload|download|!ut|aria2|partial)$/i.test(n) },
  { id: "f-dsstore", label: ".DS_Store / Thumbs.db", why: "file manager metadata", risk: "safe", act: "delete", fileOnly: true,
    match: (n) => nameIs(".DS_Store", "Thumbs.db", "desktop.ini", ".localized")(n) },
  { id: "f-oldlog", label: "old log", why: "rotated / old log", risk: "safe", act: "delete", fileOnly: true, minAge: 30, minSize: 5 * MB,
    match: (n) => /\.log(\.\d+)?(\.(gz|xz|bz2|old|1))?$/i.test(n) },
  { id: "f-core", label: "core dump", why: "memory dump of a crashed app", risk: "safe", act: "delete", fileOnly: true, minSize: 10 * MB,
    match: (n) => /^(core|core\.\d+|vgcore\.\d+)$/.test(n) },
  { id: "f-installer", label: "installer/image", why: "old installer file; can be re-downloaded", risk: "review", act: "move", fileOnly: true, minAge: 45, minSize: 100 * MB,
    match: (n) => /\.(iso|img|dmg|pkg|deb|rpm|msi|exe|appimage|apk|vmdk|vdi|qcow2)$/i.test(n) },
  { id: "f-archive", label: "old archive", why: "compressed file untouched for a long time", risk: "review", act: "move", fileOnly: true, minAge: 90, minSize: 100 * MB,
    match: (n) => /\.(zip|tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|rar|7z|gz|xz|zst)$/i.test(n) },
  { id: "f-media", label: "cold heavy video/media", why: "large unused media file", risk: "review", act: "move", fileOnly: true, minAge: 120, minSize: 300 * MB,
    match: (n) => /\.(mp4|mkv|avi|mov|wmv|flv|webm|ts|m4v|raw|arw|cr2|nef|psd|ai|sketch)$/i.test(n) },
  { id: "f-backup", label: "backup/snapshot", why: "old backup file", risk: "review", act: "move", fileOnly: true, minAge: 60, minSize: 50 * MB,
    match: (n) => /(\.bak|\.old|~|\.backup|\.sql|\.dump|\.dmp)$/i.test(n) },
];

export const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
export const RULE_COUNT = RULES.length;

// ══════════════════════ Detection engine ══════════════════════

export interface JunkHit {
  path: string;
  node: FsNode;
  rule: JunkRule;
  size: number;
  disk: number;
  age: number;          // days since last use
  isDir: boolean;
  selected: boolean;
}

export interface FindOpts {
  minSize?: number;
  risks?: Risk[];
  ruleIds?: string[];
  limit?: number;
  includeProtected?: boolean;
}

function ruleFits(r: JunkRule, n: FsNode, path: string, used: number): boolean {
  if (r.dirOnly && !n.isDir) return false;
  if (r.fileOnly && n.isDir) return false;
  if (r.minSize && n.size < r.minSize) return false;
  if (r.minAge) { const a = ageDays(used); if (!Number.isFinite(a) || a < r.minAge) return false; }
  try { return r.match(n.name, path, n); } catch { return false; }
}

/** Returns the first matching rule */
export function matchRule(n: FsNode, path: string): JunkRule | null {
  const used = Math.max(n.lastUsed || 0, n.newest || 0, n.mtime || 0);
  for (const r of RULES) if (ruleFits(r, n, path, used)) return r;
  return null;
}

/** Walk the tree and find all junk/movable items */
export function findJunk(root: FsNode, opts: FindOpts = {}): JunkHit[] {
  const minSize = opts.minSize ?? 1024 * 1024;
  const risks = opts.risks ? new Set(opts.risks) : null;
  const ids = opts.ruleIds ? new Set(opts.ruleIds) : null;
  const hits: JunkHit[] = [];

  walkAll(root, (n) => {
    if (n === root) return;
    const path = pathOf(n);
    const rule = matchRule(n, path);
    if (!rule) return;
    if (ids && !ids.has(rule.id)) return rule.stop ? false : undefined;
    if (risks && !risks.has(rule.risk)) return rule.stop ? false : undefined;
    if (n.size < minSize) return rule.stop ? false : undefined;
    if (!opts.includeProtected && isProtected(path)) return false;

    const used = Math.max(n.lastUsed || 0, n.newest || 0, n.mtime || 0);
    n.tag = rule.id;
    hits.push({
      path, node: n, rule, size: n.size, disk: n.disk,
      age: ageDays(used), isDir: n.isDir,
      selected: rule.risk === "safe",
    });
    if (rule.stop) return false;   // do not enter it
  });

  hits.sort((a, b) => b.size - a.size);
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

export interface RuleGroup {
  rule: JunkRule;
  hits: JunkHit[];
  size: number;
  disk: number;
  count: number;
}

export function groupByRule(hits: JunkHit[]): RuleGroup[] {
  const m = new Map<string, RuleGroup>();
  for (const h of hits) {
    let g = m.get(h.rule.id);
    if (!g) { g = { rule: h.rule, hits: [], size: 0, disk: 0, count: 0 }; m.set(h.rule.id, g); }
    g.hits.push(h); g.size += h.size; g.disk += h.disk; g.count++;
  }
  return [...m.values()].sort((a, b) => b.size - a.size);
}

export function totalSize(hits: JunkHit[]): number {
  return hits.reduce((s, h) => s + h.size, 0);
}
export function selectedHits(hits: JunkHit[]): JunkHit[] {
  return hits.filter((h) => h.selected);
}

/** Only low-risk items for automatic cleanup (guard) */
export function autoPlan(hits: JunkHit[], needBytes = Infinity): JunkHit[] {
  const safe = hits
    .filter((h) => h.rule.risk === "safe" && h.rule.act === "delete")
    .sort((a, b) => b.size - a.size);
  if (!Number.isFinite(needBytes)) return safe;
  const out: JunkHit[] = [];
  let acc = 0;
  for (const h of safe) { if (acc >= needBytes) break; out.push(h); acc += h.size; }
  return out;
}

export function riskStats(hits: JunkHit[]) {
  const s = { safe: 0, review: 0, danger: 0 };
  for (const h of hits) s[h.rule.risk] += h.size;
  return s;
}
