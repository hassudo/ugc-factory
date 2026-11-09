import dns from "node:dns/promises";
import net from "node:net";

const TIMEOUT_MS = 6500;
const MAX_BODY = 300_000;

export interface SiteMeta {
  title: string;
  description: string;
}

function isPrivateHostname(host: string): boolean {
  if (net.isIP(host) === 0) return false; // non-literal IP resolved below
  return isPrivateIp(host);
}

function isPrivateIp(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : null;
  if (v4 && net.isIPv4(v4)) ip = v4;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map((n) => Number(n));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  return false;
}

/** Guarded fetch: blocks private/loopback targets (SSRF), caps size + time. */
export async function fetchPageText(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!/^(https|http):$/.test(u.protocol)) return null;
    if (net.isIP(host)) {
      if (isPrivateIp(host)) return null;
    } else {
      let ips: string[] = [];
      try {
        ips = (await dns.lookup(host, { all: true })).map((x) => x.address);
      } catch {
        return null;
      }
      if (ips.some(isPrivateIp)) return null;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(u, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UGC-Factory/1.0; +https://github.com/hassudo/ugc-factory)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("html")) return null;
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BODY);
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

const ogTitle = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i;
const metaTitle = /<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i;
const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i;
const ogDesc = /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i;
const descMeta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i;

export function parseHtmlMeta(html: string): SiteMeta {
  const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();
  let title = "";
  const m1 = html.match(ogTitle) || html.match(metaTitle);
  if (m1) title = clean(m1[1]);
  if (!title) {
    const m2 = html.match(titleTag);
    if (m2) title = clean(m2[1]);
  }
  let description = "";
  const d1 = html.match(ogDesc);
  if (d1) description = clean(d1[1]);
  if (!description) {
    const d2 = html.match(descMeta);
    if (d2) description = clean(d2[1]);
  }
  return { title: title.slice(0, 160), description: description.slice(0, 240) };
}

export async function fetchSiteMeta(url: string): Promise<SiteMeta | null> {
  const html = await fetchPageText(url);
  if (!html) return null;
  return parseHtmlMeta(html);
}