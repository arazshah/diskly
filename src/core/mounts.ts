import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { OS, HOME } from "./config.ts";

export interface Mount {
  fs: string; type: string; mount: string;
  total: number; used: number; free: number; usePct: number;
  writable: boolean; removable: boolean; pseudo: boolean;
}

const PSEUDO_FS = /^(devfs|tmpfs|devtmpfs|proc|sysfs|overlay|squashfs|autofs|cgroup|efivarfs|fuse\.portal|map |none)/i;
const PSEUDO_MNT = /^(\/dev|\/proc|\/sys|\/run|\/snap|\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware))/;

function sh(cmd: string[]): string {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    return r.stdout ? r.stdout.toString() : "";
  } catch { return ""; }
}

export function listMounts(): Mount[] {
  let out = OS === "linux" ? sh(["df", "-kPT"]) : "";
  let hasType = !!out.trim();
  if (!hasType) out = sh(["df", "-kP"]);
  if (!out.trim()) return [];

  const lines = out.trim().split("\n").slice(1);
  const seen = new Set<string>();
  const res: Mount[] = [];

  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    let fs: string, type: string, k: string[], mount: string;
    if (hasType) { fs = p[0]; type = p[1]; k = p.slice(2, 6); mount = p.slice(6).join(" "); }
    else { fs = p[0]; type = ""; k = p.slice(1, 5); mount = p.slice(5).join(" "); }
    if (!mount) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);

    const total = (+k[0] || 0) * 1024;
    const used = (+k[1] || 0) * 1024;
    const free = (+k[2] || 0) * 1024;
    if (total <= 0) continue;

    const pseudo = PSEUDO_FS.test(fs) || PSEUDO_FS.test(type) || PSEUDO_MNT.test(mount);
    let writable = false;
    try { accessSync(mount, constants.W_OK); writable = true; } catch {}

    res.push({
      fs, type: type || "-", mount, total, used, free,
      usePct: total > 0 ? used / (used + free || total) : 0,
      writable,
      removable: /^\/(media|mnt|run\/media|Volumes)\//.test(mount) || /^\/Volumes\//.test(mount),
      pseudo,
    });
  }
  res.sort((a, b) => a.mount.length - b.mount.length);
  return res;
}

export function realMounts(): Mount[] {
  return listMounts().filter((m) => !m.pseudo && m.total > 64 * 1024 * 1024);
}

export function mountOf(p: string, mounts = listMounts()): Mount | null {
  const path = resolve(p);
  let best: Mount | null = null;
  for (const m of mounts) {
    if (path === m.mount || path.startsWith(m.mount === "/" ? "/" : m.mount + "/")) {
      if (!best || m.mount.length > best.mount.length) best = m;
    }
  }
  return best;
}

export function freeOf(p: string): number { return mountOf(p)?.free ?? 0; }

export function sameDevice(a: string, b: string): boolean {
  const ma = mountOf(a), mb = mountOf(b);
  return !!ma && !!mb && ma.mount === mb.mount;
}

/** Suggested move targets: another disk, writable, with enough free space */
export function suggestTargets(needBytes = 0, extra: string[] = []): Mount[] {
  const home = mountOf(HOME);
  const list = realMounts().filter((m) =>
    m.writable && m.free > needBytes * 1.1 + 512 * 1024 * 1024 &&
    (!home || m.mount !== home.mount)
  );
  for (const e of extra) {
    const m = mountOf(e);
    if (m && !list.find((x) => x.mount === m.mount)) list.push(m);
  }
  return list.sort((a, b) => b.free - a.free);
}

export function healthOf(m: Mount): "ok" | "warn" | "crit" {
  const p = m.usePct;
  return p >= 0.92 ? "crit" : p >= 0.85 ? "warn" : "ok";
}
