// ══════════════════════ Terminal render engine ══════════════════════
// No external dependencies — raw ANSI + double-buffered diff render

export interface RGB { r: number; g: number; b: number }
export const hex = (h: string): RGB => {
  const n = parseInt(h.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
export const lerp = (a: RGB, b: RGB, t: number): RGB => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t),
});

// ───────────── Theme (aligned with rsynx visual identity) ─────────────
export const THEME = {
  bg: hex("#0d1117"),
  bg2: hex("#141b24"),
  panel: hex("#101820"),
  border: hex("#24303d"),
  borderFocus: hex("#00d9a3"),
  text: hex("#e6edf3"),
  muted: hex("#6b7684"),
  green: hex("#00d9a3"),
  teal: hex("#22d3ee"),
  yellow: hex("#f5c451"),
  red: hex("#ef5a6f"),
  purple: hex("#a78bfa"),
  gradA: hex("#00d9a3"),
  gradB: hex("#22d3ee"),
};

export function gradientColor(t: number): RGB {
  return lerp(THEME.gradA, THEME.gradB, Math.max(0, Math.min(1, t)));
}

// ───────────── ANSI codes ─────────────
const ESC = "\x1b";
export const ansi = {
  hide: `${ESC}[?25l`,
  show: `${ESC}[?25h`,
  altOn: `${ESC}[?1049h`,
  altOff: `${ESC}[?1049l`,
  clear: `${ESC}[2J${ESC}[H`,
  home: `${ESC}[H`,
  mouseOn: `${ESC}[?1000h${ESC}[?1006h`,
  mouseOff: `${ESC}[?1000l${ESC}[?1006l`,
  goto: (x: number, y: number) => `${ESC}[${y + 1};${x + 1}H`,
  fg: (c: RGB) => `${ESC}[38;2;${c.r};${c.g};${c.b}m`,
  bg: (c: RGB) => `${ESC}[48;2;${c.r};${c.g};${c.b}m`,
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  underline: `${ESC}[4m`,
  reverse: `${ESC}[7m`,
};

// ───────────── Character width (Latin/Persian/Arabic = 1, emoji/CJK = 2) ─────────────
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;                 // combining
  if (cp >= 0x1100 && cp <= 0x115f) return 2;
  if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) return 2; // CJK
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;                  // Hangul
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2;
  if (cp >= 0x1f300 && cp <= 0x1fadf) return 2;                // emoji
  if (cp >= 0x2600 && cp <= 0x27bf) return 2;
  return 1; // Latin, Persian, Arabic, digits
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) || 0);
  return w;
}

/** Truncate a string to a given width (without breaking multi-byte characters) */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (strWidth(s) <= max) return s;
  if (max <= 1) return ellipsis.slice(0, max);
  let w = 0, out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) || 0);
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + ellipsis;
}

export function padEnd(s: string, w: number, ch = " "): string {
  const cur = strWidth(s);
  return cur >= w ? s : s + ch.repeat(w - cur);
}
export function padStart(s: string, w: number, ch = " "): string {
  const cur = strWidth(s);
  return cur >= w ? s : ch.repeat(w - cur) + s;
}
export function center(s: string, w: number, ch = " "): string {
  const cur = strWidth(s);
  if (cur >= w) return truncate(s, w);
  const left = Math.floor((w - cur) / 2), right = w - cur - left;
  return ch.repeat(left) + s + ch.repeat(right);
}

// ───────────── Cell & buffer ─────────────
export interface Cell { ch: string; fg?: RGB; bg?: RGB; bold?: boolean; dim?: boolean; ul?: boolean }
const BLANK: Cell = { ch: " " };

export class Buffer {
  cells: Cell[];
  constructor(public w: number, public h: number) {
    this.cells = new Array(w * h).fill(null).map(() => ({ ...BLANK }));
  }
  clear(bg?: RGB) {
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = { ch: " ", bg };
  }
  get(x: number, y: number): Cell | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.cells[y * this.w + x];
  }
  set(x: number, y: number, c: Cell) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.cells[y * this.w + x] = c;
  }
  /** Write text from x,y — respects multi-byte width */
  text(x: number, y: number, s: string, style: Omit<Cell, "ch"> = {}) {
    let cx = x;
    for (const ch of s) {
      const cw = charWidth(ch.codePointAt(0) || 0);
      if (cw === 0) continue;
      this.set(cx, y, { ch, ...style });
      for (let k = 1; k < cw; k++) this.set(cx + k, y, { ch: "", ...style });
      cx += cw;
    }
  }
  fillRect(x: number, y: number, w: number, h: number, style: Omit<Cell, "ch"> & { ch?: string } = {}) {
    const ch = style.ch ?? " ";
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, { ch, ...style });
  }
  hline(x: number, y: number, w: number, ch = "─", style: Omit<Cell, "ch"> = {}) {
    for (let i = 0; i < w; i++) this.set(x + i, y, { ch, ...style });
  }
  vline(x: number, y: number, h: number, ch = "│", style: Omit<Cell, "ch"> = {}) {
    for (let j = 0; j < h; j++) this.set(x, y + j, { ch, ...style });
  }
  /** Box with rounded neon corners — exactly the panel style you like */
  box(x: number, y: number, w: number, h: number, o: { title?: string; focus?: boolean; color?: RGB } = {}) {
    const c = o.color ?? (o.focus ? THEME.borderFocus : THEME.border);
    const s = { fg: c };
    this.set(x, y, { ch: "╭", ...s }); this.set(x + w - 1, y, { ch: "╮", ...s });
    this.set(x, y + h - 1, { ch: "╰", ...s }); this.set(x + w - 1, y + h - 1, { ch: "╯", ...s });
    this.hline(x + 1, y, w - 2, "─", s);
    this.hline(x + 1, y + h - 1, w - 2, "─", s);
    this.vline(x, y + 1, h - 2, "│", s);
    this.vline(x + w - 1, y + 1, h - 2, "│", s);
    if (o.title) {
      const t = ` ${o.title} `;
      this.text(x + 2, y, t, { fg: o.focus ? THEME.text : THEME.muted, bold: o.focus });
    }
  }
}

// ───────────── Display ─────────────
export type KeyHandler = (k: Key) => void;
export interface Key { name: string; ch: string; ctrl: boolean; shift: boolean; raw: Buffer }

export class Screen {
  w = 80; h = 24;
  buf!: Buffer;
  prev!: Buffer;
  private out = process.stdout;
  private started = false;
  onKey?: KeyHandler;
  onResize?: () => void;

  constructor() { this.resizeTo(this.out.columns || 80, this.out.rows || 24); }

  private resizeTo(w: number, h: number) {
    this.w = Math.max(20, w); this.h = Math.max(10, h);
    this.buf = new Buffer(this.w, this.h);
    this.prev = new Buffer(this.w, this.h);
    this.prev.clear({ r: -1, g: -1, b: -1 } as any); // force full render on first frame
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.out.write(ansi.altOn + ansi.hide + ansi.clear + ansi.mouseOn);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.handleInput);
    this.out.on("resize", this.handleResize);
    process.on("SIGWINCH", this.handleResize);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    process.stdin.off("data", this.handleInput);
    this.out.off("resize", this.handleResize);
    process.stdin.setRawMode?.(false);
    this.out.write(ansi.mouseOff + ansi.show + ansi.altOff);
  }

  private handleResize = () => {
    this.resizeTo(this.out.columns || 80, this.out.rows || 24);
    this.onResize?.();
  };

  private handleInput = (data: string) => {
    const k = decodeKey(data);
    if (k) this.onKey?.(k);
  };

  /** Differential render — only changed cells are printed (no flicker) */
  render() {
    let out = "";
    let curFg: RGB | undefined, curBg: RGB | undefined, curBold = false, curDim = false, curUl = false;
    let lastX = -2, lastY = -2;

    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const a = this.buf.cells[i], b = this.prev.cells[i];
        if (a.ch === b.ch && sameC(a.fg, b.fg) && sameC(a.bg, b.bg) && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.ul === !!b.ul) continue;

        if (x !== lastX || y !== lastY) out += ansi.goto(x, y);
        if (!sameC(a.fg, curFg)) { out += a.fg ? ansi.fg(a.fg) : ansi.fg(THEME.text); curFg = a.fg; }
        if (!sameC(a.bg, curBg)) { out += a.bg ? ansi.bg(a.bg) : `${ESC}[49m`; curBg = a.bg; }
        if (!!a.bold !== curBold) { out += a.bold ? ansi.bold : `${ESC}[22m`; curBold = !!a.bold; }
        if (!!a.dim !== curDim) { out += a.dim ? ansi.dim : `${ESC}[22m`; curDim = !!a.dim; curBold = false; }
        if (!!a.ul !== curUl) { out += a.ul ? ansi.underline : `${ESC}[24m`; curUl = !!a.ul; }

        out += a.ch || " ";
        lastX = x + 1; lastY = y;
        this.prev.cells[i] = { ...a };
      }
    }
    if (out) this.out.write(out + ansi.reset);
  }
}

function sameC(a?: RGB | any, b?: RGB | any) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

// ───────────── Key decoder (arrows, enter, esc, function keys…) ─────────────
function decodeKey(s: string): Key | null {
  const buf = null as any;
  const mk = (name: string, ch = "", ctrl = false, shift = false): Key => ({ name, ch, ctrl, shift, raw: buf });

  if (s === "\r" || s === "\n") return mk("return");
  if (s === "\t") return mk("tab");
  if (s === "\x7f" || s === "\b") return mk("backspace");
  if (s === "\x1b") return mk("escape");
  if (s === "\x03") return mk("c", "c", true);       // Ctrl+C
  if (s === "\x04") return mk("d", "d", true);       // Ctrl+D
  if (s === "\x15") return mk("u", "u", true);       // Ctrl+U
  if (s === " ") return mk("space", " ");

  if (s.startsWith("\x1b[") || s.startsWith("\x1bO")) {
    const map: Record<string, string> = {
      "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
      "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
      "\x1b[H": "home", "\x1b[F": "end", "\x1b[1~": "home", "\x1b[4~": "end",
      "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[3~": "delete",
      "\x1b[Z": "shift-tab",
    };
    if (map[s]) return mk(map[s], "", false, map[s] === "shift-tab");
    const m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/); // SGR mouse
    if (m) return mk("mouse", `${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
    return mk("unknown");
  }
  if (s.length === 1) return mk(s, s);
  return mk("text", s); // paste / multi-char (e.g. Persian input)
}

// ───────────── Drawing helpers ─────────────
export function drawGradientLine(b: Buffer, x: number, y: number, w: number, ch = "▔") {
  for (let i = 0; i < w; i++) b.set(x + i, y, { ch, fg: gradientColor(i / Math.max(1, w - 1)) });
}

export function drawBar(b: Buffer, x: number, y: number, w: number, pct: number, o: { danger?: number; warn?: number } = {}) {
  const filled = Math.round(w * Math.max(0, Math.min(1, pct)));
  const color = pct >= (o.danger ?? 0.9) ? THEME.red : pct >= (o.warn ?? 0.75) ? THEME.yellow : THEME.green;
  for (let i = 0; i < w; i++) {
    if (i < filled) b.set(x + i, y, { ch: "█", fg: i < filled ? color : undefined });
    else b.set(x + i, y, { ch: "░", fg: THEME.border });
  }
}

// ═══════════════════════════════════════════════════════════════
// Compatibility API for app.ts
// ═══════════════════════════════════════════════════════════════

export interface KeyEvent {
  name: string;
  ch?: string;
  ctrl?: boolean;
  shift?: boolean;
  raw?: unknown;
}

export interface ListState {
  cursor: number;
  scroll: number;
}

type CompatColor =
  | RGB
  | "black"
  | "white"
  | "accent"
  | "gray"
  | "cyan"
  | "blue"
  | "yellow"
  | "warn"
  | "green"
  | "red"
  | "purple"
  | "panel";

type CompatStyle = {
  fg?: CompatColor;
  bg?: CompatColor;
  bold?: boolean;
  dim?: boolean;
  ul?: boolean;
};

function compatColor(c?: CompatColor): RGB | undefined {
  if (!c) return undefined;
  if (typeof c !== "string") return c;

  switch (c) {
    case "black":  return THEME.bg;
    case "white":  return THEME.text;
    case "accent": return THEME.green;
    case "gray":   return THEME.muted;
    case "cyan":   return THEME.teal;
    case "blue":   return THEME.teal;
    case "yellow": return THEME.yellow;
    case "warn":   return THEME.yellow;
    case "green":  return THEME.green;
    case "red":    return THEME.red;
    case "purple": return THEME.purple;
    case "panel":  return THEME.panel;
    default:       return THEME.text;
  }
}

function compatStyle(style: CompatStyle = {}): Omit<Cell, "ch"> {
  return {
    fg: compatColor(style.fg),
    bg: compatColor(style.bg),
    bold: style.bold,
    dim: style.dim,
    ul: style.ul,
  };
}

/*
 * app.ts uses the cols/rows names and direct Screen methods,
 * while the core engine uses w/h and screen.buf.
 */
export interface Screen {
  readonly cols: number;
  readonly rows: number;

  init(): void;
  destroy(): void;
  clear(): void;

  get(x: number, y: number): Cell | null;
  set(x: number, y: number, c: Cell | ({ ch: string } & CompatStyle)): void;

  text(x: number, y: number, text: string, style?: CompatStyle): void;

  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    chOrStyle?: string | CompatStyle,
    style?: CompatStyle,
  ): void;
}

Object.defineProperty(Screen.prototype, "cols", {
  configurable: true,
  get(this: Screen) {
    return this.w;
  },
});

Object.defineProperty(Screen.prototype, "rows", {
  configurable: true,
  get(this: Screen) {
    return this.h;
  },
});

Screen.prototype.init = function init(this: Screen) {
  this.start();
};

Screen.prototype.destroy = function destroy(this: Screen) {
  this.stop();
};

Screen.prototype.clear = function clear(this: Screen) {
  this.buf.clear(THEME.bg);
};

Screen.prototype.get = function get(this: Screen, x: number, y: number) {
  return this.buf.get(x, y);
};

Screen.prototype.set = function set(
  this: Screen,
  x: number,
  y: number,
  c: Cell | ({ ch: string } & CompatStyle),
) {
  const item: any = c || { ch: " " };
  this.buf.set(x, y, {
    ch: item.ch ?? " ",
    ...compatStyle(item),
  });
};

Screen.prototype.text = function text(
  this: Screen,
  x: number,
  y: number,
  value: string,
  style: CompatStyle = {},
) {
  this.buf.text(x, y, String(value), compatStyle(style));
};

Screen.prototype.fillRect = function fillRect(
  this: Screen,
  x: number,
  y: number,
  w: number,
  h: number,
  chOrStyle: string | CompatStyle = " ",
  style: CompatStyle = {},
) {
  const ch = typeof chOrStyle === "string" ? chOrStyle : " ";
  const finalStyle =
    typeof chOrStyle === "string"
      ? style
      : chOrStyle;

  this.buf.fillRect(x, y, w, h, {
    ch,
    ...compatStyle(finalStyle),
  });
};

// ─────────────────────── Keyboard input ───────────────────────

function compatKey(
  name: string,
  ch = "",
  ctrl = false,
  shift = false,
): KeyEvent {
  return { name, ch, ctrl, shift };
}

function parseOneKey(s: string): KeyEvent {
  if (s === "\r" || s === "\n") return compatKey("enter");
  if (s === "\t") return compatKey("tab");
  if (s === "\x1b[Z") return compatKey("backtab", "", false, true);
  if (s === "\x7f" || s === "\b") return compatKey("backspace");
  if (s === "\x1b") return compatKey("esc");
  if (s === " ") return compatKey("space", " ");

  // Ctrl+C exits the program just like q.
  if (s === "\x03") return compatKey("char", "q", true);
  if (s === "\x04") return compatKey("char", "d", true);
  if (s === "\x15") return compatKey("char", "u", true);

  const map: Record<string, string> = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1bOC": "right",
    "\x1bOD": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[1~": "home",
    "\x1b[4~": "end",
    "\x1b[5~": "pageup",
    "\x1b[6~": "pagedown",
    "\x1b[3~": "delete",
  };

  if (map[s]) return compatKey(map[s]);

  if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(s)) {
    return compatKey("mouse", s);
  }

  return compatKey("char", s);
}

/**
 * Convert a chunk of terminal input into KeyEvents usable by app.ts.
 * Also supports paste and multi-byte text.
 */
export function parseKeys(input: string | Uint8Array): KeyEvent[] {
  const data =
    typeof input === "string"
      ? input
      : new TextDecoder().decode(input);

  const result: KeyEvent[] = [];
  let i = 0;

  const sequences = [
    "\x1b[Z",
    "\x1b[A",
    "\x1b[B",
    "\x1b[C",
    "\x1b[D",
    "\x1bOA",
    "\x1bOB",
    "\x1bOC",
    "\x1bOD",
    "\x1b[H",
    "\x1b[F",
    "\x1b[1~",
    "\x1b[4~",
    "\x1b[5~",
    "\x1b[6~",
    "\x1b[3~",
  ];

  while (i < data.length) {
    const rest = data.slice(i);

    const mouse = rest.match(/^\x1b\[<\d+;\d+;\d+[mM]/);
    if (mouse) {
      result.push(parseOneKey(mouse[0]));
      i += mouse[0].length;
      continue;
    }

    const seq = sequences.find((candidate) => rest.startsWith(candidate));
    if (seq) {
      result.push(parseOneKey(seq));
      i += seq.length;
      continue;
    }

    const cp = data.codePointAt(i);
    if (cp === undefined) break;

    const ch = String.fromCodePoint(cp);
    result.push(parseOneKey(ch));
    i += ch.length;
  }

  return result;
}

// ─────────────────────── UI utilities ───────────────────────

export function wrap(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const output: string[] = [];

  for (const paragraph of String(text).split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }

    const words = paragraph.split(/\s+/);
    let line = "";

    for (const word of words) {
      if (strWidth(word) > maxWidth) {
        if (line) {
          output.push(line);
          line = "";
        }

        let part = "";
        for (const ch of word) {
          if (strWidth(part + ch) > maxWidth) {
            output.push(part);
            part = ch;
          } else {
            part += ch;
          }
        }
        line = part;
        continue;
      }

      const candidate = line ? `${line} ${word}` : word;
      if (strWidth(candidate) > maxWidth) {
        if (line) output.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }

    if (line) output.push(line);
  }

  return output.length ? output : [""];
}

const COMPAT_SPINNER = [
  "⠋", "⠙", "⠹", "⠸", "⠼",
  "⠴", "⠦", "⠧", "⠇", "⠏",
];

export function spinnerFrame(tick: number): string {
  return COMPAT_SPINNER[Math.abs(tick) % COMPAT_SPINNER.length];
}

export interface DrawColumn<T> {
  w: number;
  get: (item: T, index: number) => unknown;
  style?: (item: T, index: number) => CompatStyle;
}

export interface DrawListOptions<T> {
  focused?: boolean;
  empty?: string;
  selected?: Set<T> | Set<string>;
}

export function drawList<T>(
  screen: Screen,
  x: number,
  y: number,
  width: number,
  height: number,
  items: T[],
  state: ListState,
  columns: DrawColumn<T>[],
  options: DrawListOptions<T> = {},
) {
  const h = Math.max(0, height);
  const w = Math.max(1, width);

  if (!items.length) {
    state.cursor = 0;
    state.scroll = 0;
    screen.fillRect(x, y, w, h, " ", {});
    if (options.empty) {
      screen.text(x + 1, y, truncate(options.empty, w - 2), {
        fg: "gray",
        dim: true,
      });
    }
    return;
  }

  state.cursor = Math.max(0, Math.min(items.length - 1, state.cursor));

  if (state.cursor < state.scroll) {
    state.scroll = state.cursor;
  }

  if (state.cursor >= state.scroll + h) {
    state.scroll = state.cursor - h + 1;
  }

  state.scroll = Math.max(
    0,
    Math.min(state.scroll, Math.max(0, items.length - h)),
  );

  for (let row = 0; row < h; row++) {
    const index = state.scroll + row;
    const item = items[index];
    const py = y + row;

    screen.fillRect(x, py, w, 1, " ", {});

    if (item === undefined) continue;

    const active = index === state.cursor;
    const focused = options.focused !== false;
    const bg = active
      ? focused
        ? THEME.bg2
        : THEME.panel
      : undefined;

    if (bg) screen.fillRect(x, py, w, 1, " ", { bg });

    let cx = x;

    if (active) {
      screen.text(cx, py, "▌", {
        fg: focused ? "accent" : "gray",
        bg,
      });
      cx += 1;
    } else {
      cx += 1;
    }

    for (const column of columns) {
      if (cx >= x + w) break;

      const colWidth = Math.max(0, Math.min(column.w, x + w - cx));
      if (colWidth <= 0) continue;

      const value = String(column.get(item, index) ?? "");
      const style = column.style?.(item, index) ?? {};

      screen.text(
        cx,
        py,
        padEnd(truncate(value, colWidth), colWidth),
        {
          fg: style.fg ?? (active ? "white" : "gray"),
          bg,
          bold: active && focused,
          dim: style.dim,
          ul: style.ul,
        },
      );

      cx += colWidth;
    }
  }
}

export function drawToast(
  screen: Screen,
  text: string,
  kind: "info" | "ok" | "err" = "info",
) {
  const maxWidth = Math.max(10, screen.cols - 8);
  const message = truncate(text, maxWidth - 4);
  const width = Math.min(maxWidth, strWidth(message) + 4);
  const x = Math.max(2, Math.floor((screen.cols - width) / 2));
  const y = Math.max(1, screen.rows - 4);

  const color: CompatColor =
    kind === "ok"
      ? "green"
      : kind === "err"
        ? "red"
        : "cyan";

  screen.fillRect(x, y, width, 3, " ", { bg: "panel" });
  screen.text(x, y, "╭" + "─".repeat(Math.max(0, width - 2)) + "╮", {
    fg: color,
    bg: "panel",
  });
  screen.text(x, y + 1, "│", { fg: color, bg: "panel" });
  screen.text(x + 2, y + 1, message, {
    fg: "white",
    bg: "panel",
    bold: true,
  });
  screen.text(x + width - 1, y + 1, "│", {
    fg: color,
    bg: "panel",
  });
  screen.text(x, y + 2, "╰" + "─".repeat(Math.max(0, width - 2)) + "╯", {
    fg: color,
    bg: "panel",
  });
}

export function drawConfirm(
  screen: Screen,
  text: string,
  danger = false,
  hint = "Enter=Confirm   Esc=Cancel",
) {
  const width = Math.min(68, Math.max(36, screen.cols - 8));
  const lines = wrap(text, width - 6).slice(0, 5);
  const height = Math.max(8, lines.length + 6);
  const x = Math.max(1, Math.floor((screen.cols - width) / 2));
  const y = Math.max(1, Math.floor((screen.rows - height) / 2));
  const color: CompatColor = danger ? "red" : "accent";

  screen.fillRect(x, y, width, height, " ", { bg: "panel" });

  screen.text(x, y, "╭" + "─".repeat(width - 2) + "╮", {
    fg: color,
    bg: "panel",
  });

  for (let row = 1; row < height - 1; row++) {
    screen.text(x, y + row, "│", { fg: color, bg: "panel" });
    screen.text(x + width - 1, y + row, "│", {
      fg: color,
      bg: "panel",
    });
  }

  screen.text(x, y + height - 1, "╰" + "─".repeat(width - 2) + "╯", {
    fg: color,
    bg: "panel",
  });

  screen.text(
    x + 3,
    y,
    danger ? " Confirm dangerous action " : " Confirm action ",
    { fg: color, bg: "panel", bold: true },
  );

  lines.forEach((line, index) => {
    screen.text(x + 3, y + 2 + index, truncate(line, width - 6), {
      fg: "white",
      bg: "panel",
    });
  });

  screen.text(
    x + 3,
    y + height - 2,
    truncate(hint, width - 6),
    { fg: "gray", bg: "panel" },
  );
}
