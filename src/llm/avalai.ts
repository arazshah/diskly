import { HOME, loadConfig, CFG_DIR } from "../core/config.ts";
import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export const DEFAULT_BASE = "https://api.avalai.ir/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  enabled: boolean;
}

export function llmConfig(over: Partial<LlmConfig> = {}): LlmConfig {
  const cfg: any = loadConfig();
  const f = cfg?.llm ?? {};
  const keyFile = join(CFG_DIR, "avalai.key");
  const fileKey = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";
  const key =
    over.apiKey ||
    process.env.AVALAI_API_KEY ||
    process.env.AVALAI_KEY ||
    f.apiKey ||
    fileKey ||
    "";
  return {
    baseUrl: (over.baseUrl || process.env.AVALAI_BASE_URL || f.baseUrl || DEFAULT_BASE).replace(/\/+$/, ""),
    model: over.model || process.env.AVALAI_MODEL || f.model || DEFAULT_MODEL,
    apiKey: key,
    timeoutMs: over.timeoutMs ?? f.timeoutMs ?? 45_000,
    maxTokens: over.maxTokens ?? f.maxTokens ?? 1400,
    temperature: over.temperature ?? f.temperature ?? 0.15,
    enabled: !!key,
  };
}

export function keyHint(): string {
  const c = llmConfig();
  if (c.enabled) return `key active (…${c.apiKey.slice(-4)}) • model: ${c.model}`;
  return `key not set. Run:  export AVALAI_API_KEY=...   or   echo "KEY" > ${join(CFG_DIR, "avalai.key")}`;
}

// ───────────── Privacy: sanitize text before sending ─────────────
const USER = basename(HOME) || "user";

export function redact(text: string): string {
  let t = text;
  t = t.split(HOME).join("~");
  if (USER.length > 2) t = t.replace(new RegExp(`\\b${USER}\\b`, "g"), "USER");
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "EMAIL");
  t = t.replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, "IP");
  t = t.replace(/\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "SECRET");
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/g, "HASH");
  t = t.replace(/(\+98|0)9\d{9}\b/g, "PHONE");
  return t;
}

// ───────────── Request ─────────────
export interface Msg { role: "system" | "user" | "assistant"; content: string }

export interface ChatOpts {
  json?: boolean;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  ok: boolean;
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  err?: string;
}

export async function chat(messages: Msg[], o: ChatOpts = {}): Promise<ChatResult> {
  const c = llmConfig({ model: o.model, maxTokens: o.maxTokens, temperature: o.temperature });
  const t0 = performance.now();
  const base: ChatResult = { ok: false, text: "", model: c.model, promptTokens: 0, completionTokens: 0, ms: 0 };
  if (!c.enabled) return { ...base, err: "AvalAI key is not set. " + keyHint() };

  const safe = messages.map((m) => ({ role: m.role, content: redact(m.content) }));
  const body: any = {
    model: c.model,
    messages: safe,
    max_tokens: c.maxTokens,
    temperature: c.temperature,
  };
  if (o.json) body.response_format = { type: "json_object" };

  const tries = (o.retries ?? 2) + 1;
  let lastErr = "";

  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), c.timeoutMs);
    o.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const txt = (await res.text().catch(() => "")).slice(0, 300);
        lastErr = `HTTP ${res.status}: ${txt}`;
        if (res.status === 401 || res.status === 403) return { ...base, ms: performance.now() - t0, err: "invalid key (401/403)" };
        if (res.status === 404) return { ...base, ms: performance.now() - t0, err: `model "${c.model}" not found` };
        if (res.status === 429 || res.status >= 500) { await sleep(700 * (i + 1)); continue; }
        return { ...base, ms: performance.now() - t0, err: lastErr };
      }

      const j: any = await res.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      return {
        ok: true,
        text: String(text).trim(),
        model: j?.model || c.model,
        promptTokens: j?.usage?.prompt_tokens ?? 0,
        completionTokens: j?.usage?.completion_tokens ?? 0,
        ms: performance.now() - t0,
      };
    } catch (e: any) {
      clearTimeout(timer);
      lastErr = e?.name === "AbortError" ? "timeout / aborted" : String(e?.message || e);
      if (e?.name === "AbortError" && o.signal?.aborted) break;
      await sleep(500 * (i + 1));
    }
  }
  return { ...base, ms: performance.now() - t0, err: lastErr || "unknown network error" };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Extract JSON from the model response (even if wrapped in ```json) */
export function parseJson<T = any>(text: string): T | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)) as T; } catch {}
  try { return JSON.parse(t.slice(s, e + 1).replace(/,(\s*[}\]])/g, "$1")) as T; } catch {}
  return null;
}

export async function ping(): Promise<{ ok: boolean; msg: string }> {
  const c = llmConfig();
  if (!c.enabled) return { ok: false, msg: keyHint() };
  const r = await chat([{ role: "user", content: "just write: ok" }], { maxTokens: 5, retries: 0 });
  return r.ok
    ? { ok: true, msg: `connected • ${r.model} • ${r.ms.toFixed(0)}ms` }
    : { ok: false, msg: r.err || "failed" };
}
