import { Buffer as Buf, THEME, truncate, padEnd, strWidth, drawBar, type RGB } from "./screen.ts";

// ───────────── Scrollable selectable list ─────────────
export interface ListItem { label: string; sub?: string; color?: RGB; tag?: string; checked?: boolean; disabled?: boolean }

export class ListView {
  items: ListItem[] = [];
  sel = 0;
  top = 0;
  multi = false;
  checkedSet = new Set<number>();

  setItems(items: ListItem[]) {
    this.items = items;
    this.sel = Math.min(this.sel, Math.max(0, items.length - 1));
  }

  move(d: number) {
    if (!this.items.length) return;
    this.sel = (this.sel + d + this.items.length) % this.items.length;
  }
  toggle() { if (this.multi) { this.checkedSet.has(this.sel) ? this.checkedSet.delete(this.sel) : this.checkedSet.add(this.sel); } }
  toggleAll(on: boolean) { this.checkedSet = on ? new Set(this.items.map((_, i) => i)) : new Set(); }
  isChecked(i: number) { return this.checkedSet.has(i); }
  checkedItems() { return [...this.checkedSet].map((i) => this.items[i]); }

  render(b: Buf, x: number, y: number, w: number, h: number) {
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + h) this.top = this.sel - h + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.items.length - h)));

    for (let row = 0; row < h; row++) {
      const idx = this.top + row;
      const it = this.items[idx];
      const py = y + row;
      if (!it) { b.fillRect(x, py, w, 1, {}); continue; }
      const active = idx === this.sel;
      const bg = active ? THEME.bg2 : undefined;
      const fg = it.disabled ? THEME.muted : (it.color ?? THEME.text);

      b.fillRect(x, py, w, 1, { bg });
      let cx = x;
      if (active) { b.text(cx, py, "▌", { fg: THEME.green, bg }); }
      cx += 1;
      if (this.multi) { b.text(cx, py, this.isChecked(idx) ? "◉" : "○", { fg: this.isChecked(idx) ? THEME.green : THEME.muted, bg }); cx += 2; }
      const tagW = it.tag ? strWidth(it.tag) + 1 : 0;
      const labelW = w - (cx - x) - tagW - 1;
      b.text(cx, py, truncate(it.label, Math.max(1, labelW)), { fg, bg, bold: active });
      if (it.tag) b.text(x + w - tagW, py, it.tag, { fg: THEME.muted, bg });
      if (it.sub && !it.tag) {
        const subX = x + w - strWidth(it.sub) - 1;
        if (subX > cx + strWidth(it.label) + 1) b.text(subX, py, it.sub, { fg: THEME.muted, bg, dim: true });
      }
    }
  }
}

// ───────────── Multi-line scrollable text (for AI responses / log) ─────────────
export class ScrollText {
  lines: string[] = [];
  top = 0;
  setText(t: string) { this.lines = t.split("\n"); this.top = 0; }
  append(t: string) { this.lines.push(...t.split("\n")); }
  scroll(d: number, viewH: number) { this.top = Math.max(0, Math.min(this.top + d, Math.max(0, this.lines.length - viewH))); }
  toBottom(viewH: number) { this.top = Math.max(0, this.lines.length - viewH); }

  render(b: Buf, x: number, y: number, w: number, h: number) {
    for (let row = 0; row < h; row++) {
      const line = this.lines[this.top + row] ?? "";
      b.fillRect(x, y + row, w, 1, {});
      let fg: RGB = THEME.text, dim = false, bold = false;
      if (line.startsWith("# ")) { fg = THEME.teal; bold = true; }
      else if (line.startsWith("## ")) { fg = THEME.green; bold = true; }
      else if (/^\s*[-•]/.test(line)) fg = THEME.text;
      else if (/^\s*\$/.test(line)) fg = THEME.yellow;
      else if (line.trim() === "") dim = true;
      b.text(x, y + row, truncate(line, w), { fg, dim, bold });
    }
    // scroll indicator
    if (this.lines.length > h) {
      const barH = Math.max(1, Math.round((h * h) / this.lines.length));
      const barY = Math.round((y) + (this.top / Math.max(1, this.lines.length - h)) * (h - barH));
      for (let i = 0; i < h; i++) b.set(x + w, y + i, { ch: (i >= (barY - y) && i < (barY - y) + barH) ? "┃" : "│", fg: THEME.border });
    }
  }
}

// ───────────── Text input field ─────────────
export class TextInput {
  value = "";
  cursor = 0;
  placeholder = "";
  put(ch: string) { this.value = this.value.slice(0, this.cursor) + ch + this.value.slice(this.cursor); this.cursor += ch.length; }
  backspace() { if (this.cursor > 0) { this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor); this.cursor--; } }
  del() { this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1); }
  left() { this.cursor = Math.max(0, this.cursor - 1); }
  right() { this.cursor = Math.min(this.value.length, this.cursor + 1); }
  home() { this.cursor = 0; }
  end() { this.cursor = this.value.length; }
  clearAll() { this.value = ""; this.cursor = 0; }

  render(b: Buf, x: number, y: number, w: number, focus: boolean) {
    b.fillRect(x, y, w, 1, { bg: THEME.bg2 });
    const text = this.value || this.placeholder;
    const color = this.value ? THEME.text : THEME.muted;
    b.text(x + 1, y, truncate(text, w - 2), { fg: color, dim: !this.value });
    if (focus) {
      const cx = Math.min(x + 1 + this.cursor, x + w - 2);
      const cell = b.get(cx, y);
      b.set(cx, y, { ch: cell?.ch || " ", fg: THEME.bg, bg: THEME.green });
    }
  }
}

// ───────────── Confirmation dialog ─────────────
export interface ConfirmState { open: boolean; title: string; body: string; danger?: boolean; yes: string; no: string; sel: 0 | 1 }
export function confirmDialog(): ConfirmState { return { open: false, title: "", body: "", yes: "Yes", no: "Cancel", sel: 1 }; }

export function renderConfirm(b: Buf, c: ConfirmState, screenW: number, screenH: number) {
  const w = Math.min(64, screenW - 6), h = 8;
  const x = Math.floor((screenW - w) / 2), y = Math.floor((screenH - h) / 2);
  b.fillRect(x, y, w, h, { bg: THEME.panel });
  b.box(x, y, w, h, { title: c.title, focus: true, color: c.danger ? THEME.red : THEME.green });
  const bodyLines = wrap(c.body, w - 4);
  bodyLines.slice(0, 3).forEach((l, i) => b.text(x + 2, y + 2 + i, l, { fg: THEME.text }));
  const by = y + h - 2;
  const bYesX = x + w - 12, bNoX = x + w - 26;
  drawBtn(b, bNoX, by, c.no, c.sel === 1);
  drawBtn(b, bYesX, by, c.yes, c.sel === 0, c.danger);
}
function drawBtn(b: Buf, x: number, y: number, label: string, active: boolean, danger = false) {
  const w = label.length + 4;
  const fg = active ? THEME.bg : (danger ? THEME.red : THEME.text);
  const bg = active ? (danger ? THEME.red : THEME.green) : THEME.bg2;
  b.fillRect(x, y, w, 1, { bg });
  b.text(x + 2, y, label, { fg, bg, bold: active });
}
function wrap(s: string, w: number): string[] {
  const words = s.split(" "); const out: string[] = []; let line = "";
  for (const wd of words) {
    if (strWidth(line + " " + wd) > w) { if (line) out.push(line); line = wd; }
    else line = line ? line + " " + wd : wd;
  }
  if (line) out.push(line);
  return out;
}

// ───────────── Spinner for in-flight requests ─────────────
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export class Spinner {
  i = 0;
  tick() { this.i = (this.i + 1) % FRAMES.length; return FRAMES[this.i]; }
  frame() { return FRAMES[this.i]; }
}

// ───────────── Progress bar with percent ─────────────
export function progressRow(b: Buf, x: number, y: number, w: number, label: string, pct: number, extra = "") {
  const barW = w - strWidth(label) - strWidth(extra) - 8;
  b.text(x, y, label, { fg: THEME.text });
  drawBar(b, x + strWidth(label) + 1, y, Math.max(4, barW), pct);
  b.text(x + w - strWidth(extra) - Math.round(pct * 100).toString().length - 3, y, `${Math.round(pct * 100)}% ${extra}`, { fg: THEME.muted });
}

// ───────────── Tabs ─────────────
export function renderTabs(b: Buf, x: number, y: number, w: number, tabs: string[], active: number) {
  let cx = x;
  for (let i = 0; i < tabs.length; i++) {
    const label = ` ${tabs[i]} `;
    const on = i === active;
    b.text(cx, y, label, { fg: on ? THEME.bg : THEME.muted, bg: on ? THEME.green : undefined, bold: on });
    cx += strWidth(label) + 1;
  }
}
