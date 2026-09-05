import { Screen, parseKeys, drawBar, drawList, drawConfirm, drawToast, wrap,
  spinnerFrame, strWidth, truncate, type ListState, type KeyEvent } from "./screen.ts";
import { scan } from "../core/scan.ts";
import { pathOf, type FsNode, type DirNode } from "../core/tree.ts";
import { realMounts, type Mount } from "../core/mounts.ts";
import { fmtSize, fmtAge, pct } from "../core/format.ts";
import { HOME, tilde } from "../core/config.ts";
import { findJunk, groupByRule, riskStats, type JunkHit, type RuleGroup } from "../core/rules.ts";
import { quarantinePath, readJournal, undoLast, summaryLine, type JournalEntry } from "../core/actions.ts";
import { findDupes, dropDupes, linkDupes, type DupeResult, type DupeGroup } from "../core/dupes.ts";
import { buildDigest, analyze, DiskChat } from "../llm/advisor.ts";
import { keyHint } from "../llm/avalai.ts";

const TABS = ["Disks", "Browser", "Junk", "Duplicates", "AI", "History"] as const;

interface Modal {
  text: string;
  danger?: boolean;
  hint?: string;
  onYes: () => void | Promise<void>;
}

interface State {
  tab: number;
  quit: boolean;
  toast: { text: string; kind: "info" | "ok" | "err"; until: number } | null;
  modal: Modal | null;
  busy: string | null;
  tick: number;

  // Main scan
  root: FsNode | null;
  scanPath: string;
  mounts: Mount[];
  mountList: ListState;

  // File tree browser
  browseDir: FsNode | null;
  browseStack: FsNode[];
  browseList: ListState;

  // Junk finder
  junkHits: JunkHit[];
  junkGroups: RuleGroup[];
  junkSel: Set<string>;
  junkList: ListState;
  junkGroupList: ListState;
  junkFocusGroups: boolean;

  // Duplicate files
  dupes: DupeResult | null;
  dupeGroupList: ListState;
  dupeItemList: ListState;
  dupeSel: Set<string>;
  dupeFocusGroups: boolean;

  // AI assistant
  aiDigest: string;
  aiChat: DiskChat | null;
  aiLog: { role: "user" | "assistant" | "sys"; text: string }[];
  aiInput: string;
  aiScroll: number;
  aiBusy: boolean;
  aiFocusInput: boolean;

  // Operation history
  journal: JournalEntry[];
  histList: ListState;
}

function initState(): State {
  return {
    tab: 0, quit: false, toast: null, modal: null, busy: "Scanning main disk …", tick: 0,
    root: null, scanPath: HOME, mounts: [], mountList: { cursor: 0, scroll: 0 },
    browseDir: null, browseStack: [], browseList: { cursor: 0, scroll: 0 },
    junkHits: [], junkGroups: [], junkSel: new Set(), junkList: { cursor: 0, scroll: 0 },
    junkGroupList: { cursor: 0, scroll: 0 }, junkFocusGroups: true,
    dupes: null, dupeGroupList: { cursor: 0, scroll: 0 }, dupeItemList: { cursor: 0, scroll: 0 },
    dupeSel: new Set(), dupeFocusGroups: true,
    aiDigest: "", aiChat: null, aiLog: [
      { role: "sys", text: "To start, press Enter so diskly explains the disk state to the model." },
    ], aiInput: "", aiScroll: 0, aiBusy: false, aiFocusInput: false,
    journal: readJournal(300), histList: { cursor: 0, scroll: 0 },
  };
}

function dirChildren(node: FsNode | null): FsNode[] {
  return node?.isDir ? (node as DirNode).children : [];
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function moveList(st: ListState, delta: number, total: number) {
  if (total <= 0) { st.cursor = 0; st.scroll = 0; return; }
  st.cursor = Math.max(0, Math.min(total - 1, st.cursor + delta));
}

function toast(st: State, text: string, kind: "info" | "ok" | "err" = "info") {
  st.toast = { text, kind, until: Date.now() + 2600 };
}

function confirm(st: State, text: string, onYes: () => void | Promise<void>, danger = false, hint?: string) {
  st.modal = { text, danger, hint, onYes };
}

// ══════════════════════ Background operations (async) ══════════════════════

async function doScan(st: State, path: string) {
  st.busy = `Scanning ${tilde(path)} …`;
  try {
    const r = await Promise.resolve(scan(path, { maxDepth: 12 }));
    st.root = r.root;
    st.scanPath = path;
    st.browseDir = r.root;
    st.browseStack = [];
    st.browseList = { cursor: 0, scroll: 0 };
    st.mounts = realMounts();
    st.mountList = { cursor: 0, scroll: 0 };
    toast(st, `Scan complete — ${fmtSize(r.root.size)}`, "ok");
  } catch (e: any) {
    toast(st, `Scan error: ${e?.message ?? e}`, "err");
  } finally {
    st.busy = null;
  }
}

async function doJunkScan(st: State) {
  if (!st.root) { toast(st, "A scan must be performed first", "err"); return; }
  st.busy = "Searching for junk files …";
  try {
    const hits = await Promise.resolve(findJunk(st.root));
    st.junkHits = hits;
    st.junkGroups = groupByRule(hits);
    st.junkSel = new Set();
    st.junkGroupList = { cursor: 0, scroll: 0 };
    st.junkList = { cursor: 0, scroll: 0 };
    toast(st, `${hits.length} items found`, "ok");
  } catch (e: any) {
    toast(st, `Error: ${e?.message ?? e}`, "err");
  } finally {
    st.busy = null;
  }
}

async function doDupeScan(st: State) {
  if (!st.root) { toast(st, "A scan must be performed first", "err"); return; }
  st.busy = "Finding duplicate files (hashing) …";
  try {
    const res = await Promise.resolve(findDupes(st.root));
    st.dupes = res;
    st.dupeGroupList = { cursor: 0, scroll: 0 };
    st.dupeItemList = { cursor: 0, scroll: 0 };
    st.dupeSel = new Set();
    toast(st, `${res.groups.length} duplicate groups — reclaimable: ${fmtSize(res.wasted)}`, "ok");
  } catch (e: any) {
    toast(st, `Error: ${e?.message ?? e}`, "err");
  } finally {
    st.busy = null;
  }
}

async function doAIAnalyze(st: State) {
  if (!st.root) { toast(st, "A scan must be performed first", "err"); return; }
  st.aiBusy = true;
  st.aiLog.push({ role: "user", text: "Analyze the current disk state and suggest next steps." });
  try {
    if (!st.aiDigest) st.aiDigest = buildDigest(st.root, { hits: st.junkHits, dupes: st.dupes });
    const res = await analyze(st.aiDigest);
    if (res.ok) {
      st.aiLog.push({ role: "assistant", text: res.text });
      if (!st.aiChat) st.aiChat = new DiskChat(st.aiDigest);
    } else {
      st.aiLog.push({ role: "sys", text: `⚠ Model connection failed: ${res.err}\n${keyHint()}` });
    }
  } catch (e: any) {
    st.aiLog.push({ role: "sys", text: `⚠ Model connection failed: ${e?.message ?? e}\n${keyHint()}` });
  } finally {
    st.aiBusy = false;
  }
}

async function doAISend(st: State) {
  const msg = st.aiInput.trim();
  if (!msg) return;
  st.aiInput = "";
  st.aiLog.push({ role: "user", text: msg });
  st.aiBusy = true;
  try {
    if (!st.aiChat && st.root) st.aiChat = new DiskChat(st.aiDigest || buildDigest(st.root, { hits: st.junkHits, dupes: st.dupes }));
    if (st.aiChat) {
      const reply = await st.aiChat.ask(msg);
      if (reply.ok) st.aiLog.push({ role: "assistant", text: reply.text });
      else st.aiLog.push({ role: "sys", text: `⚠ Error: ${reply.err}` });
    }
  } catch (e: any) {
    st.aiLog.push({ role: "sys", text: `⚠ Error: ${e?.message ?? e}` });
  } finally {
    st.aiBusy = false;
  }
}

async function applyJunkDelete(st: State) {
  const targets = st.junkHits.filter((h) => st.junkSel.has(h.path));
  if (!targets.length) { toast(st, "Nothing selected", "err"); return; }
  const totalSize = targets.reduce((a, b) => a + b.size, 0);
  confirm(
    st,
    `Move ${targets.length} items (${fmtSize(totalSize)}) to quarantine? Revertible later from the "History" tab.`,
    async () => {
      st.busy = "Moving to quarantine …";
      let freed = 0, fail = 0;
      for (const t of targets) {
        const r = quarantinePath(t.path, { rule: t.rule.id });
        if (r.ok) freed += r.freed; else fail++;
      }
      st.junkHits = st.junkHits.filter((h) => !st.junkSel.has(h.path));
      st.junkGroups = groupByRule(st.junkHits);
      st.junkSel = new Set();
      st.journal = readJournal(300);
      st.busy = null;
      toast(st, fail ? `${fmtSize(freed)} freed — ${fail} failed` : `${fmtSize(freed)} freed ✅`, fail ? "err" : "ok");
    },
    false,
    "Enter=Quarantine   Esc=Cancel"
  );
}

async function applyDupeDrop(st: State) {
  if (!st.dupes) return;
  const groupsToAct: DupeGroup[] = [];
  for (const g of st.dupes.groups) {
    const selectedInGroup = g.files.filter((f) => st.dupeSel.has(f.path));
    if (selectedInGroup.length > 0) {
      groupsToAct.push({
        ...g,
        files: [g.files[0], ...selectedInGroup],
      });
    }
  }

  if (!groupsToAct.length) { toast(st, "Nothing selected", "err"); return; }
  confirm(
    st,
    `Delete ${st.dupeSel.size} duplicate files?`,
    async () => {
      st.busy = "Removing duplicate copies …";
      const results = dropDupes(groupsToAct, false);
      const freed = results.filter((r) => r.ok).reduce((s, r) => s + r.freed, 0);
      st.dupeSel = new Set();
      if (st.root) st.dupes = await Promise.resolve(findDupes(st.root));
      st.journal = readJournal(300);
      st.busy = null;
      toast(st, `${fmtSize(freed)} freed ✅`, "ok");
    },
    true,
    "Enter=Delete duplicates   Esc=Cancel"
  );
}

async function doUndo(st: State) {
  const r = await Promise.resolve(undoLast());
  st.journal = readJournal(300);
  toast(st, r.ok ? "Last operation reverted ✅" : (r.err || "Nothing to revert"), r.ok ? "ok" : "err");
}

// ══════════════════════ Render ══════════════════════

function renderHeader(s: Screen, st: State) {
  s.fillRect(0, 0, s.cols, 1, " ", { bg: "panel" });
  s.text(2, 0, " diskly ", { fg: "accent", bold: true, bg: "panel" });
  let x = 12;
  TABS.forEach((t, i) => {
    const on = i === st.tab;
    const label = ` ${i + 1}·${t} `;
    s.text(x, 0, label, on ? { fg: "black", bg: "accent", bold: true } : { fg: "gray", bg: "panel" });
    x += strWidth(label) + 1;
  });
  const info = tilde(st.scanPath);
  s.text(Math.max(x, s.cols - strWidth(info) - 2), 0, info, { fg: "cyan", bg: "panel" });
}

function renderFooter(s: Screen, st: State, hint: string) {
  s.fillRect(0, s.rows - 1, s.cols, 1, " ", { bg: "panel" });
  s.text(2, s.rows - 1, hint, { fg: "gray", bg: "panel" });
  if (st.busy) {
    const txt = `${spinnerFrame(st.tick)} ${st.busy}`;
    s.text(Math.max(2, s.cols - strWidth(txt) - 2), s.rows - 1, txt, { fg: "warn", bg: "panel" });
  }
}

function renderDisks(s: Screen, st: State) {
  const x = 2, y = 2, w = s.cols - 4;
  if (!st.root) { s.text(x, y, "Scanning …", { fg: "gray" }); return; }

  s.text(x, y, "Mounted disks:", { fg: "white", bold: true });
  drawList(s, x, y + 1, w, Math.min(6, st.mounts.length), st.mounts, st.mountList, [
    { w: 20, get: (m) => m.mount },
    { w: 14, get: (m) => fmtSize(m.used) + " / " + fmtSize(m.total) },
    { w: 30, get: () => "" },
  ], { empty: "No disks detected." });

  st.mounts.forEach((m, i) => {
    if (i < st.mountList.scroll || i >= st.mountList.scroll + 6) return;
    const row = y + 1 + (i - st.mountList.scroll);
    drawBar(s.buf, x + 35, row, Math.max(4, w - 40), m.usePct);
  });

  const by = y + 8;
  s.text(x, by, "Scanned path summary:", { fg: "white", bold: true });
  s.text(x, by + 1, `📁 ${tilde(st.scanPath)}   —   total size: ${fmtSize(st.root.size)}   —   ${dirChildren(st.root).length} direct items`, { fg: "cyan" });

  const top = [...dirChildren(st.root)].sort((a, b) => b.size - a.size).slice(0, 8);
  s.text(x, by + 3, "Largest folders/files:", { fg: "white", bold: true });
  top.forEach((n, i) => {
    const row = by + 4 + i;
    if (row >= s.rows - 2) return;
    s.text(x, row, truncate(n.name, 40), { fg: n.isDir ? "blue" : "white" });
    s.text(x + 42, row, fmtSize(n.size), { fg: "accent" });
    drawBar(s.buf, x + 55, row, Math.max(4, Math.min(20, w - 60)), ratio(n.size, st.root!.size));
  });
}

function renderBrowser(s: Screen, st: State) {
  const x = 2, y = 2, w = s.cols - 4, h = s.rows - 6;
  if (!st.browseDir) { s.text(x, y, "Not scanned — start from the \"Disks\" tab.", { fg: "gray" }); return; }

  const crumbs = [...st.browseStack.map((n) => n.name), st.browseDir.name].join(" / ");
  s.text(x, y, `📂 ${crumbs}`, { fg: "cyan", bold: true });

  const children = [...dirChildren(st.browseDir)].sort((a, b) => b.size - a.size);
  drawList(s, x, y + 2, w, h, children, st.browseList, [
    { w: 3, get: (n) => (n.isDir ? "📁" : "📄") },
    { w: 42, get: (n) => n.name },
    { w: 11, get: (n) => fmtSize(n.size), style: () => ({ fg: "accent" }) },
    { w: 10, get: (n) => fmtAge(n.mtime) },
    { w: 6, get: (n) => `${Math.round(ratio(n.size, st.browseDir!.size) * 100)}%` },
  ], { empty: "Empty folder." });
}

function renderJunk(s: Screen, st: State) {
  const x = 2, y = 2, w = s.cols - 4, h = s.rows - 8;
  if (!st.junkGroups.length) {
    s.text(x, y, "Nothing scanned — press r to start the junk search.", { fg: "gray" });
    return;
  }
  const gw = 26;
  s.text(x, y, "Categories:", { fg: "white", bold: true });
  drawList(s, x, y + 1, gw, h, st.junkGroups, st.junkGroupList, [
    { w: gw - 10, get: (g) => g.rule.label },
    { w: 8, get: (g) => fmtSize(g.size), style: () => ({ fg: "accent" }) },
  ], { focused: st.junkFocusGroups });

  const group = st.junkGroups[st.junkGroupList.cursor];
  const ix = x + gw + 2;
  s.text(ix, y, `Items in "${group?.rule.label ?? ""}"  —  Space=toggle  a=all  d=clean`, { fg: "white", bold: true });
  const items = group ? group.hits : [];
  drawList(s, ix, y + 1, w - gw - 4, h, items, st.junkList, [
    { w: 4, get: (it) => (st.junkSel.has(it.path) ? "[✔]" : "[ ]") },
    { w: 48, get: (it) => tilde(it.path) },
    { w: 10, get: (it) => fmtSize(it.size), style: () => ({ fg: "accent" }) },
    { w: 10, get: (it) => fmtAge(it.node.mtime) },
  ], { focused: !st.junkFocusGroups, empty: "No items." });

  const stats = riskStats(st.junkHits.filter((h) => st.junkSel.has(h.path)));
  const by = y + h + 2;
  s.text(x, by, `Selected: ${st.junkSel.size} items — ${fmtSize(stats.safe + stats.review + stats.danger)}   |   total reclaimable: ${fmtSize(st.junkGroups.reduce((a, g) => a + g.size, 0))}`, { fg: "warn" });
}

function renderDupes(s: Screen, st: State) {
  const x = 2, y = 2, w = s.cols - 4, h = s.rows - 8;
  if (!st.dupes) {
    s.text(x, y, "Nothing scanned — press r to search for duplicate files.", { fg: "gray" });
    return;
  }
  const gw = 30;
  s.text(x, y, `${st.dupes.groups.length} groups — reclaimable: ${fmtSize(st.dupes.wasted)}`, { fg: "white", bold: true });
  drawList(s, x, y + 1, gw, h, st.dupes.groups, st.dupeGroupList, [
    { w: 10, get: (g) => fmtSize(g.size) },
    { w: gw - 12, get: (g) => `${g.files.length} copies` },
  ], { focused: st.dupeFocusGroups, empty: "No duplicates found." });

  const grp = st.dupes.groups[st.dupeGroupList.cursor];
  const ix = x + gw + 2;
  const files = grp?.files.slice(1) ?? [];
  s.text(ix, y, `Duplicate copies (original: ${grp?.files[0]?.path ? tilde(grp.files[0].path) : "-"})`, { fg: "white", bold: true });
  drawList(s, ix, y + 1, w - gw - 4, h, files, st.dupeItemList, [
    { w: 4, get: (f) => (st.dupeSel.has(f.path) ? "[✔]" : "[ ]") },
    { w: w - gw - 16, get: (f) => tilde(f.path) },
  ], { focused: !st.dupeFocusGroups, empty: "No other duplicate copies." });
}

function renderAI(s: Screen, st: State) {
  const x = 2, y = 2, w = s.cols - 4, h = s.rows - 6;
  s.text(x, y, `AvalAI Assistant  (i = type a message   Enter = analyze / send)`, { fg: "white", bold: true });

  const chatH = h - 3;
  s.fillRect(x, y + 2, w, chatH, " ", { bg: "panel" });
  let cy = y + 2;

  st.aiLog.forEach((m) => {
    if (cy >= y + 2 + chatH) return;
    const prefix = m.role === "user" ? "👤 You: " : m.role === "assistant" ? "🤖 AI: " : "⚙ System: ";
    const fg = m.role === "user" ? "cyan" : m.role === "assistant" ? "green" : "gray";
    s.text(x + 1, cy, prefix, { fg, bold: true });
    const lines = wrap(m.text, w - 4);
    for (const l of lines) {
      if (cy >= y + 2 + chatH) break;
      s.text(x + 3, cy + 1, l, { fg: "white" });
      cy++;
    }
    cy += 2;
  });

  const iy = y + h;
  s.text(x, iy, st.aiFocusInput ? "💬 Your message: " : "💬 (press i to type): ", { fg: "accent", bold: true });
  s.text(x + 20, iy, st.aiInput + (st.aiFocusInput ? "█" : ""), { fg: "white" });
}

function renderHistory(s: Screen, st: State) {
  const x = 2, y = 2, w = s.cols - 4, h = s.rows - 6;
  s.text(x, y, "Recent operations — press u to undo:", { fg: "white", bold: true });
  drawList(s, x, y + 2, w, h, st.journal, st.histList, [
    { w: 10, get: (j) => fmtAge(j.ts) },
    { w: w - 14, get: (j) => summaryLine(j) },
  ], { empty: "History is empty." });
}

function render(s: Screen, st: State) {
  s.clear();
  renderHeader(s, st);

  switch (st.tab) {
    case 0: renderDisks(s, st); break;
    case 1: renderBrowser(s, st); break;
    case 2: renderJunk(s, st); break;
    case 3: renderDupes(s, st); break;
    case 4: renderAI(s, st); break;
    case 5: renderHistory(s, st); break;
  }

  const hints: Record<number, string> = {
    0: "Enter=Scan path   r=Rescan   Tab=Next tab   q=Quit",
    1: "Enter=Open folder   Backspace=Back   d=Quarantine   Tab=Next tab",
    2: "←/→=Switch column   Space=Toggle   a=All   d=Delete selection   r=Rescan",
    3: "←/→=Switch column   Space=Toggle   d=Delete duplicates   r=Rescan",
    4: "Enter=Analyze scan   i=Type question   Esc=Exit typing",
    5: "u=Undo last op   ↑/↓=Navigate",
  };
  renderFooter(s, st, hints[st.tab] ?? "");

  if (st.toast) drawToast(s, st.toast.text, st.toast.kind);
  if (st.modal) drawConfirm(s, st.modal.text, st.modal.danger, st.modal.hint);

  s.render();
}

// ══════════════════════ User input ══════════════════════

function handleGlobalKey(st: State, k: KeyEvent): boolean {
  if (st.modal) {
    if (k.name === "enter") { const fn = st.modal.onYes; st.modal = null; void fn(); }
    else if (k.name === "esc") st.modal = null;
    return true;
  }
  if (st.tab === 4 && st.aiFocusInput) return false;
  if (k.name === "tab") { st.tab = (st.tab + 1) % TABS.length; return true; }
  if (k.name === "backtab") { st.tab = (st.tab - 1 + TABS.length) % TABS.length; return true; }
  if (k.name === "char" && /^[1-6]$/.test(k.ch || "")) { st.tab = Number(k.ch) - 1; return true; }
  return false;
}

async function handleDisksKey(st: State, k: KeyEvent) {
  if (k.name === "up") moveList(st.mountList, -1, st.mounts.length);
  if (k.name === "down") moveList(st.mountList, 1, st.mounts.length);
  if (k.name === "enter" && st.mounts[st.mountList.cursor]) await doScan(st, st.mounts[st.mountList.cursor].mount);
  if (k.name === "char" && k.ch === "r") await doScan(st, st.scanPath);
}

async function handleBrowserKey(st: State, k: KeyEvent) {
  if (!st.browseDir) return;
  const children = [...dirChildren(st.browseDir)].sort((a, b) => b.size - a.size);
  if (k.name === "up") moveList(st.browseList, -1, children.length);
  if (k.name === "down") moveList(st.browseList, 1, children.length);
  if (k.name === "enter") {
    const sel = children[st.browseList.cursor];
    if (sel?.isDir) {
      st.browseStack.push(st.browseDir);
      st.browseDir = sel;
      st.browseList = { cursor: 0, scroll: 0 };
    }
  }
  if (k.name === "backspace") {
    const prev = st.browseStack.pop();
    if (prev) { st.browseDir = prev; st.browseList = { cursor: 0, scroll: 0 }; }
  }
  if (k.name === "char" && k.ch === "d") {
    const sel = children[st.browseList.cursor];
    if (sel) confirm(st, `Move "${sel.name}" (${fmtSize(sel.size)}) to quarantine?`, async () => {
      const r = quarantinePath(pathOf(sel), { rule: "manual" });
      if (r.ok) {
        (st.browseDir as DirNode).children = dirChildren(st.browseDir).filter((c: FsNode) => c !== sel);
        st.journal = readJournal(300);
        toast(st, `${fmtSize(r.freed)} freed ✅`, "ok");
      } else toast(st, `Failed: ${r.err}`, "err");
    });
  }
}

async function handleJunkKey(st: State, k: KeyEvent) {
  if (!st.junkGroups.length) { if (k.name === "char" && k.ch === "r") await doJunkScan(st); return; }
  const group = st.junkGroups[st.junkGroupList.cursor];
  const items = group ? group.hits : [];
  if (k.name === "left") st.junkFocusGroups = true;
  if (k.name === "right") st.junkFocusGroups = false;
  if (k.name === "up") st.junkFocusGroups ? moveList(st.junkGroupList, -1, st.junkGroups.length) : moveList(st.junkList, -1, items.length);
  if (k.name === "down") st.junkFocusGroups ? moveList(st.junkGroupList, 1, st.junkGroups.length) : moveList(st.junkList, 1, items.length);
  if (k.name === "space" && !st.junkFocusGroups) {
    const it = items[st.junkList.cursor];
    if (it) { st.junkSel.has(it.path) ? st.junkSel.delete(it.path) : st.junkSel.add(it.path); }
  }
  if (k.name === "char" && k.ch === "a") items.forEach((it) => st.junkSel.add(it.path));
  if (k.name === "char" && k.ch === "d") await applyJunkDelete(st);
  if (k.name === "char" && k.ch === "r") await doJunkScan(st);
}

async function handleDupeKey(st: State, k: KeyEvent) {
  if (!st.dupes) { if (k.name === "char" && k.ch === "r") await doDupeScan(st); return; }
  const grp = st.dupes.groups[st.dupeGroupList.cursor];
  const files = grp?.files.slice(1) ?? [];
  if (k.name === "left") st.dupeFocusGroups = true;
  if (k.name === "right") st.dupeFocusGroups = false;
  if (k.name === "up") st.dupeFocusGroups ? moveList(st.dupeGroupList, -1, st.dupes.groups.length) : moveList(st.dupeItemList, -1, files.length);
  if (k.name === "down") st.dupeFocusGroups ? moveList(st.dupeGroupList, 1, st.dupes.groups.length) : moveList(st.dupeItemList, 1, files.length);
  if (k.name === "space" && !st.dupeFocusGroups) {
    const f = files[st.dupeItemList.cursor];
    if (f) { st.dupeSel.has(f.path) ? st.dupeSel.delete(f.path) : st.dupeSel.add(f.path); }
  }
  if (k.name === "char" && k.ch === "d") await applyDupeDrop(st);
  if (k.name === "char" && k.ch === "r") await doDupeScan(st);
}

async function handleAIKey(st: State, k: KeyEvent) {
  if (st.aiFocusInput) {
    if (k.name === "esc") st.aiFocusInput = false;
    else if (k.name === "enter") { st.aiFocusInput = false; await doAISend(st); }
    else if (k.name === "backspace") st.aiInput = st.aiInput.slice(0, -1);
    else if (k.name === "char" || k.name === "space") st.aiInput += k.ch ?? " ";
    return;
  }
  if (k.name === "char" && k.ch === "i") st.aiFocusInput = true;
  if (k.name === "enter" && st.aiLog.length <= 1) await doAIAnalyze(st);
}

async function handleHistoryKey(st: State, k: KeyEvent) {
  if (k.name === "up") moveList(st.histList, -1, st.journal.length);
  if (k.name === "down") moveList(st.histList, 1, st.journal.length);
  if (k.name === "char" && k.ch === "u") await doUndo(st);
}

async function handleKey(st: State, k: KeyEvent) {
  if (handleGlobalKey(st, k)) return;
  if (k.name === "char" && k.ch === "q" && !(st.tab === 4 && st.aiFocusInput)) { st.quit = true; return; }
  switch (st.tab) {
    case 0: await handleDisksKey(st, k); break;
    case 1: await handleBrowserKey(st, k); break;
    case 2: await handleJunkKey(st, k); break;
    case 3: await handleDupeKey(st, k); break;
    case 4: await handleAIKey(st, k); break;
    case 5: await handleHistoryKey(st, k); break;
  }
}

// ══════════════════════ Entry point ══════════════════════

export async function runApp() {
  const s = new Screen();
  const st = initState();
  s.init();

  let queue: KeyEvent[] = [];
  let processing = false;

  process.stdin.on("data", (chunk: string) => {
    queue.push(...parseKeys(chunk));
  });

  const drainQueue = async () => {
    if (processing) return;
    processing = true;
    while (queue.length && !st.quit) {
      const k = queue.shift()!;
      try { await handleKey(st, k); } catch (e: any) { toast(st, `Internal error: ${e?.message ?? e}`, "err"); }
    }
    processing = false;
  };

  const loop = setInterval(async () => {
    st.tick++;
    if (st.toast && st.toast.until <= Date.now()) st.toast = null;
    await drainQueue();
    render(s, st);
    if (st.quit) {
      clearInterval(loop);
      s.destroy();
      process.exit(0);
    }
  }, 90);

  void doScan(st, st.scanPath).then(() => render(s, st));
  render(s, st);

  process.on("exit", () => { try { s.destroy(); } catch {} });
}
