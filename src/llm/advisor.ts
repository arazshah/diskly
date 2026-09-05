import { chat, parseJson, redact, llmConfig, type Msg } from "./avalai.ts";
import { fmtSize, fmtAge, pct } from "../core/format.ts";
import { HOME } from "../core/config.ts";
import { pathOf, topDirs, topFiles, coldItems, type FsNode } from "../core/tree.ts";
import { findJunk, groupByRule, riskStats, type JunkHit } from "../core/rules.ts";
import { realMounts, mountOf } from "../core/mounts.ts";
import type { DupeResult } from "../core/dupes.ts";

// ═════════ Building a compact digest for the model ═════════
export interface DigestOpts { hits?: JunkHit[]; dupes?: DupeResult | null; maxItems?: number }

export function buildDigest(root: FsNode, o: DigestOpts = {}): string {
  const N = o.maxItems ?? 18;
  const L: string[] = [];
  const rp = pathOf(root);

  L.push(`# Disk status`);
  for (const m of realMounts()) {
    L.push(`- ${m.mount} (${m.type}) total=${fmtSize(m.total)} free=${fmtSize(m.free)} used=${pct(m.usePct)}`);
  }

  L.push(`\n# Scan root: ${rp}`);
  L.push(`size=${fmtSize(root.size)} on-disk=${fmtSize(root.disk)} files=${root.nFiles} dirs=${root.nDirs}`);

  L.push(`\n# Heaviest directories`);
  for (const d of topDirs(root, N)) {
    L.push(`- ${pathOf(d)} | ${fmtSize(d.size)} | ${d.nFiles} files | last-used ${fmtAge(d.lastUsed)}`);
  }

  L.push(`\n# Heaviest files`);
  for (const f of topFiles(root, N, 20 * 1024 * 1024)) {
    L.push(`- ${pathOf(f)} | ${fmtSize(f.size)} | ${fmtAge(f.mtime)}`);
  }

  const cold = coldItems(root, 120, 200 * 1024 * 1024, N);
  if (cold.length) {
    L.push(`\n# Large cold items (unused >120 days)`);
    for (const c of cold) L.push(`- ${pathOf(c)} | ${fmtSize(c.size)} | ${fmtAge(Math.max(c.lastUsed, c.newest))}`);
  }

  const hits = o.hits ?? findJunk(root, { minSize: 5 * 1024 * 1024 });
  const groups = groupByRule(hits);
  const rs = riskStats(hits);
  L.push(`\n# Cleanable categories (detected by local rules)`);
  L.push(`total: ${fmtSize(rs.safe + rs.review + rs.danger)} → safe=${fmtSize(rs.safe)} needs-review=${fmtSize(rs.review)} dangerous=${fmtSize(rs.danger)}`);
  for (const g of groups.slice(0, 20)) {
    L.push(`- [${g.rule.id}] ${g.rule.label} | ${g.count} items | ${fmtSize(g.size)} | risk=${g.rule.risk} | action=${g.rule.act}`);
  }

  if (o.dupes && o.dupes.groups.length) {
    L.push(`\n# Duplicate files`);
    L.push(`groups=${o.dupes.groups.length} wasted=${fmtSize(o.dupes.wasted)}`);
    for (const g of o.dupes.groups.slice(0, 8)) {
      L.push(`- ${fmtSize(g.size)} ×${g.files.length} → ${g.files.map((f) => f.path).join(" | ")}`);
    }
  }

  return redact(L.join("\n")).slice(0, 14_000);
}

// ═════════ Base prompt ═════════
const SYS = `You are a Linux/macOS and disk-space management expert who replies in fluent English.
Hard rules:
1. Never suggest deleting: /, /boot, /etc, /usr, /bin, /lib, /var/lib (except caches), ~/.ssh, ~/.gnupg, ~/.config, git repositories, personal documents and photos.
2. For rebuildable items (cache, node_modules, build, target, DerivedData) consider deletion "safe".
3. For valuable but heavy data (VMs, SDK images, AI models, archives) suggest "moving to another disk", not deletion.
4. Only use paths that exactly appear in the input data; do not invent new paths.
5. Write concisely, actionable and prioritized. Mention numbers and sizes.`;

// ═════════ 1) Text analysis ═════════
export interface AdviceResult { ok: boolean; text: string; tokens: number; ms: number; err?: string }

export async function analyze(digest: string, question?: string): Promise<AdviceResult> {
  const msgs: Msg[] = [
    { role: "system", content: SYS },
    { role: "user", content:
`Here is my disk scan data:

${digest}

${question ? `My question: ${question}` : `Please analyze:
- What are the top three reasons my disk is full?
- What can I safely delete right now and how much would be freed?
- What is better moved to another disk?
- Two habits or settings to prevent the problem from recurring.
Write with headings and bullets.`}` },
  ];
  const r = await chat(msgs, { maxTokens: 1400 });
  return { ok: r.ok, text: r.text, tokens: r.promptTokens + r.completionTokens, ms: r.ms, err: r.err };
}

// ═════════ 2) Actionable JSON plan ═════════
export type PlanAct = "delete" | "move" | "cmd" | "keep";
export interface PlanItem {
  path: string; action: PlanAct; reason: string;
  risk: "safe" | "review" | "danger"; estimate: number; cmd?: string;
  valid: boolean; note?: string;
}
export interface Plan {
  ok: boolean; summary: string; items: PlanItem[];
  freeSafe: number; freeAll: number; dropped: string[]; raw: string; err?: string; ms: number;
}

const PLAN_SCHEMA = `{
  "summary": "one English paragraph",
  "items": [
    { "path": "path exactly from the input data", "action": "delete|move|cmd|keep",
      "reason": "short English reason", "risk": "safe|review|danger",
      "estimate_bytes": 123456, "cmd": "optional" }
  ]
}`;

export async function makePlan(root: FsNode, opts: { hits?: JunkHit[]; dupes?: DupeResult | null; goalBytes?: number; digest?: string } = {}): Promise<Plan> {
  const digest = opts.digest ?? buildDigest(root, { hits: opts.hits, dupes: opts.dupes });
  const goal = opts.goalBytes ? `Goal: free at least ${fmtSize(opts.goalBytes)}.` : "Goal: free as much space as possible with minimal risk.";

  const r = await chat([
    { role: "system", content: SYS + `\nOutput only valid JSON with this structure:\n${PLAN_SCHEMA}` },
    { role: "user", content: `${digest}\n\n${goal}\nAt most 25 items, sorted by highest gain.` },
  ], { json: true, maxTokens: 1800 });

  const base: Plan = { ok: false, summary: "", items: [], freeSafe: 0, freeAll: 0, dropped: [], raw: r.text, ms: r.ms };
  if (!r.ok) return { ...base, err: r.err };

  const j = parseJson<any>(r.text);
  if (!j || !Array.isArray(j.items)) return { ...base, err: "model response was not valid JSON" };

  // ── Local validation: paths must actually exist in the tree ──
  const allowed = new Map<string, FsNode>();
  const collect = (n: FsNode) => allowed.set(pathOf(n), n);
  topDirs(root, 400).forEach(collect);
  topFiles(root, 400).forEach(collect);
  coldItems(root, 60, 1024 * 1024, 400).forEach(collect);
  (opts.hits ?? []).forEach((h) => allowed.set(h.path, h.node));

  const items: PlanItem[] = [];
  const dropped: string[] = [];

  for (const it of j.items.slice(0, 40)) {
    const raw = String(it?.path ?? "").trim();
    if (!raw) continue;
    const p = raw.startsWith("~") ? HOME + raw.slice(1) : raw;
    const node = allowed.get(p);
    const action: PlanAct = ["delete", "move", "cmd", "keep"].includes(it?.action) ? it.action : "review" as any;
    if (!node && action !== "cmd") { dropped.push(p); continue; }
    const est = Number(it?.estimate_bytes) || node?.size || 0;
    items.push({
      path: p,
      action: (action === "keep" ? "keep" : action) as PlanAct,
      reason: String(it?.reason ?? "").slice(0, 220),
      risk: ["safe", "review", "danger"].includes(it?.risk) ? it.risk : "review",
      estimate: est,
      cmd: it?.cmd ? String(it.cmd).slice(0, 200) : undefined,
      valid: !!node || action === "cmd",
      note: node ? undefined : "path was not in the scan",
    });
  }

  items.sort((a, b) => b.estimate - a.estimate);
  const freeAll = items.filter((i) => i.action !== "keep").reduce((s, i) => s + i.estimate, 0);
  const freeSafe = items.filter((i) => i.risk === "safe" && i.action === "delete").reduce((s, i) => s + i.estimate, 0);

  return {
    ok: true,
    summary: String(j.summary ?? "").slice(0, 800),
    items, freeSafe, freeAll, dropped, raw: r.text, ms: r.ms,
  };
}

// ═════════ 3) Explain a suspicious path ═════════
export async function explainPath(path: string, extra = ""): Promise<AdviceResult> {
  const m = mountOf(path);
  const r = await chat([
    { role: "system", content: SYS },
    { role: "user", content:
`What is this path on my system and what are the consequences of deleting it?
Path: ${path}
Disk: ${m?.mount ?? "?"} (free ${fmtSize(m?.free ?? 0)})
${extra}

Answer in 4 lines: 1) what this folder/file is 2) which app creates it 3) is deletion safe or not 4) the proper way to clean it (command).` },
  ], { maxTokens: 500 });
  return { ok: r.ok, text: r.text, tokens: r.promptTokens + r.completionTokens, ms: r.ms, err: r.err };
}

// ═════════ 4) Multi-turn chat about the same scan ═════════
export class DiskChat {
  private history: Msg[] = [];
  constructor(private digest: string) {
    this.history.push({ role: "system", content: SYS });
    this.history.push({ role: "user", content: `Here is my disk summary; I will ask questions next:\n\n${digest}` });
    this.history.push({ role: "assistant", content: "Ready. Ask away." });
  }
  get model() { return llmConfig().model; }
  async ask(q: string): Promise<AdviceResult> {
    this.history.push({ role: "user", content: q });
    const r = await chat(this.history, { maxTokens: 900 });
    if (r.ok) this.history.push({ role: "assistant", content: r.text });
    else this.history.pop();
    if (this.history.length > 14) this.history.splice(3, 2);
    return { ok: r.ok, text: r.text, tokens: r.promptTokens + r.completionTokens, ms: r.ms, err: r.err };
  }
  reset() { this.history = this.history.slice(0, 3); }
}

export function planReport(p: Plan): string {
  const L: string[] = [];
  if (p.summary) L.push(p.summary, "");
  const icon: Record<string, string> = { delete: "🗑", move: "📦", cmd: "⌘", keep: "🔒" };
  for (const i of p.items) {
    L.push(`${icon[i.action] ?? "•"} ${fmtSize(i.estimate).padStart(8)}  [${i.risk}] ${i.path}`);
    L.push(`   ${i.reason}${i.cmd ? `\n   $ ${i.cmd}` : ""}${i.note ? `  ⚠ ${i.note}` : ""}`);
  }
  L.push("", `safe to free: ${fmtSize(p.freeSafe)} • total suggested: ${fmtSize(p.freeAll)}`);
  if (p.dropped.length) L.push(`${p.dropped.length} hallucinated model paths were ignored.`);
  return L.join("\n");
}
