// Light LLM integration: OpenRouter (free open-weights models), Groq, or any
// OpenAI-compatible endpoint. Never throws — returns null so the offline rule
// engine stays as a guaranteed fallback.

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function findLLM(): LLMConfig | null {
  if (process.env.OPENROUTER_API_KEY) {
    return {
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.LLM_MODEL || "inclusionai/ling-3.0-flash-sante:free",
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.LLM_MODEL || "gpt-4o-mini",
    };
  }
  return null;
}

export async function chatRaw(cfg: LLMConfig, messages: { role: string; content: string }[], maxTokens = 800): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45_000);
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
          ...(cfg.baseUrl.includes("openrouter") ? { "HTTP-Referer": "https://github.com/hassudo/ugc-factory", "X-Title": "UGC Factory" } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.4,
          max_tokens: maxTokens,
        }),
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 429 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        return null;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      return typeof text === "string" && text.trim().length ? text.trim() : null;
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      return null;
    }
  }
  return null;
}

function extractJson(text: string): unknown {
  let t = text.trim();
  // strip markdown fences
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[{[]/);
  if (start > 0) t = t.slice(start);
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const SYSTEM = `You are UGC Factory, a friendly chat assistant inside a tiny web app. Behave like ChatGPT:
answer naturally, hold the thread, keep replies short and warm, use markdown lightly. Absolutely no emoji.

Your one special power: you can trigger the app's UGC-video workflow. It renders a short 9:16 marketing
video for a product out of: background photo/video, a trendy caption, trending audio, and a GIF on top.

Decide EVERY message as either "chat" (your assistant reply) or "video" (trigger the render):

- kind="video" ONLY when the user, in this thread, pitches a concrete product/app/startup they want a
  video for — most often with a site URL such as "calai.app" or https://... — or a message that clearly
  refers back to such a product pitched earlier. A bare product URL alone counts as a video request.
- everything else is kind="chat": greetings, questions, thanks, small talk, opinions, unrelated topics,
  requests for advice. NEVER start a video for a chat.

For kind="video" include "product" (all fields):
  name     product name, max 40 chars (title case)
  url      the product site with scheme if given/carried in the thread, else ""
  tagline  what it does, max 160 chars
  keywords up to 8 short lowercase single/double-word terms for asset matching (e.g. calorie tracking,
           gym, food, ai, skincare, travel, fintech, deep work)
  hook     ONE aggressive UGC caption, ALL CAPS, max 22 chars, benefit/urgency driven (e.g.
           "TRACK EVERY BITE" or "MONEY SIMPLIFIED"), optional "!", no quotes, no emoji
  vibe     one of exactly: fitness, food, finance, travel, fashion, music, productivity, social, home, tech

Always include "reply": for "chat" it's your answer; for "video" the intro line before the video appears,
e.g. "Here's your UGC video for <name>!" Do not fabricate product facts the user never stated.

Reply with ONLY valid JSON (no markdown): {"kind":"chat"|"video","reply":"...","product":{...}|null}`;

export interface LLMVideoProduct {
  name: string;
  url: string;
  tagline: string;
  keywords: string[];
  hook: string;
  vibe: string;
}

export interface LLMResult {
  kind: "chat" | "video";
  reply: string;
  product: LLMVideoProduct | null;
  proseFallback?: boolean;
}

export async function classifyWithLLM(messages: { role: string; content: string }[]): Promise<LLMResult | null> {
  const cfg = findLLM();
  if (!cfg) return null;
  const history = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));
  if (!history.length) return null;
  const raw = await chatRaw(cfg, [{ role: "system", content: SYSTEM }, ...history]);
  if (!raw) return null;
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") {
    // The free reasoning model sometimes answers as plain prose instead of our
    // JSON contract. Use the prose directly as the chat reply rather than
    // falling back to canned text — and flag it so callers can still trigger
    // the video workflow when the message clearly pitches a product.
    const prose = raw.trim().slice(0, 400);
    if (prose) return { kind: "chat", reply: prose, product: null, proseFallback: true };
    return null;
  }
  const kind = (obj as any).kind;
  if (kind !== "chat" && kind !== "video") return null;
  const reply = typeof (obj as any).reply === "string" ? (obj as any).reply.slice(0, 400) : "";
  const p = (obj as any).product as any;
  let product: LLMVideoProduct | null = null;
  if (kind === "video" && p && typeof p === "object") {
    product = {
      name: typeof p.name === "string" ? p.name.slice(0, 40) : "A new product",
      url: typeof p.url === "string" ? p.url.slice(0, 200) : "",
      tagline: typeof p.tagline === "string" ? p.tagline.slice(0, 160) : "",
      keywords: Array.isArray(p.keywords)
        ? p.keywords.filter((k: unknown): k is string => typeof k === "string").map((k: string) => k.toLowerCase()).slice(0, 8)
        : [],
      hook: typeof p.hook === "string" ? p.hook.slice(0, 24) : "",
      vibe: typeof p.vibe === "string" ? p.vibe.toLowerCase() : "",
    };
  }
  return { kind, reply, product };
}

/** Interpolate a class (tuning / deterministic debugging) by forcing JSON. */
export async function chatJSON(cfg: LLMConfig, messages: { role: string; content: string }[]): Promise<unknown> {
  const raw = await chatRaw(cfg, messages);
  return raw ? extractJson(raw) : null;
}