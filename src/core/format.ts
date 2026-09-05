const UNITS = ["B", "K", "M", "G", "T", "P"];
export const DAY = 86_400_000;

export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  let v = bytes, i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${UNITS[i]}`;
}

export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([bkmgtp]?)/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const idx = UNITS.indexOf((m[2] || "B").toUpperCase());
  return Math.round(n * Math.pow(1024, idx < 0 ? 0 : idx));
}

export function fmtDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return "    -     ";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ms: number): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${fmtDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ageDays(ms: number): number {
  if (!ms || !Number.isFinite(ms)) return Infinity;
  return Math.floor((Date.now() - ms) / DAY);
}

export function fmtAge(ms: number): string {
  const d = ageDays(ms);
  if (!Number.isFinite(d)) return "?";
  if (d <= 0) return "today";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x0300 && c <= 0x036f) continue;
    if (c >= 0x0610 && c <= 0x061a) continue;
    if (c >= 0x064b && c <= 0x065f) continue;
    if (c === 0x0670) continue;
    if (
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff)
    ) { w += 2; continue; }
    w += 1;
  }
  return w;
}

export function padEnd(s: string, w: number): string {
  const d = w - strWidth(s);
  return d > 0 ? s + " ".repeat(d) : s;
}
export function padStart(s: string, w: number): string {
  const d = w - strWidth(s);
  return d > 0 ? " ".repeat(d) + s : s;
}
export function clip(s: string, w: number): string {
  if (strWidth(s) <= w) return s;
  let out = "", acc = 0;
  for (const ch of s) {
    const cw = strWidth(ch);
    if (acc + cw > w - 1) break;
    out += ch; acc += cw;
  }
  return out + "…";
}
export function trunc(s: string, w: number): string {
  if (strWidth(s) <= w) return s;
  if (w <= 2) return "…";
  const keep = w - 1;
  const head = Math.ceil(keep * 0.42), tail = keep - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

export function bar(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, frac || 0));
  const full = Math.round(f * width);
  return "█".repeat(full) + "░".repeat(Math.max(0, width - full));
}

export function pct(frac: number): string {
  return `${Math.round((frac || 0) * 100)}%`.padStart(4);
}

const ON = !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (ON ? `\x1b[${code}m${s}\x1b[0m` : s);
export const C = {
  raw: ON,
  dim: c("2"), bold: c("1"), under: c("4"), inv: c("7"),
  red: c("31"), green: c("32"), yellow: c("33"),
  blue: c("34"), magenta: c("35"), cyan: c("36"),
  gray: c("90"), white: c("97"),
  bgBlue: c("48;5;24;97"), bgRed: c("41;97"),
  bgGreen: c("42;30"), bgYellow: c("43;30"), bgGray: c("100;97"),
};

export function heat(frac: number) {
  return frac > 0.5 ? C.red : frac > 0.2 ? C.yellow : frac > 0.05 ? C.cyan : C.gray;
}
export function riskColor(r: string) {
  return r === "safe" ? C.green : r === "review" ? C.yellow : C.red;
}
