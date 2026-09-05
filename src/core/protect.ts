import { resolve, sep } from "node:path";
import { HOME, QUARANTINE } from "./config.ts";

const HARD_BLOCK = new Set([
  "/", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/usr", "/etc",
  "/boot", "/dev", "/proc", "/sys", "/var", "/var/lib", "/var/lib/dpkg",
  "/var/lib/rpm", "/opt", "/srv", "/root", "/home", "/Users", "/Applications",
  "/System", "/Library", "/private", "/Volumes", "/mnt", "/media",
  HOME,
  `${HOME}/.ssh`, `${HOME}/.gnupg`, `${HOME}/.config`, `${HOME}/.local`,
  `${HOME}/.local/share`, `${HOME}/Documents`, `${HOME}/Desktop`,
  `${HOME}/Pictures`, `${HOME}/.password-store`, `${HOME}/Library`,
  QUARANTINE,
]);

const DANGEROUS_RE = /^\/(etc|boot|dev|proc|sys|bin|sbin|lib|lib64|usr\/(bin|lib|sbin))(\/|$)/;
const CRED_RE = /(\.ssh|\.gnupg|\.aws|\.kube|keyring|\.password-store|Keychains)(\/|$)/i;

export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkSafe(p: string, opts: { allowSystem?: boolean } = {}): Verdict {
  const path = resolve(p);
  if (HARD_BLOCK.has(path)) return { ok: false, reason: `critical/protected path: ${path}` };
  if (path.split(sep).filter(Boolean).length < 2)
    return { ok: false, reason: "path depth is too shallow (risk of wiping the whole disk)" };
  if (CRED_RE.test(path)) return { ok: false, reason: "path is related to keys/credentials" };
  if (DANGEROUS_RE.test(path) && !opts.allowSystem)
    return { ok: false, reason: "system subtree; requires --allow-system" };
  if (!path.startsWith(HOME) && !opts.allowSystem)
    return { ok: false, reason: "outside HOME; run with --allow-system (and sudo if needed)" };
  return { ok: true };
}

export function isProtected(p: string): boolean {
  return !checkSafe(p, { allowSystem: true }).ok;
}
