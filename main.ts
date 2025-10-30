// main.ts — no-auth + context sessions + vercel-friendly

import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// 读取 .env（在 Vercel 上没有也没关系）
await load({ export: true });

const settings = {
  APP_NAME: "kimi-ai-2api-deno",
  APP_VERSION: "1.1.0",
  DESCRIPTION: "Kimi 转 OpenAI 兼容 API（无鉴权 + 内存上下文会话）",
  PORT: parseInt(Deno.env.get("PORT") || "8088", 10),

  // Kimi 上游
  UPSTREAM_URL: "https://kimi-ai.chat/wp-admin/admin-ajax.php",
  CHAT_PAGE_URL: "https://kimi-ai.chat/chat/",

  KNOWN_MODELS: ["kimi-k2-instruct-0905", "kimi-k2-instruct"],
  DEFAULT_MODEL: "kimi-k2-instruct-0905",

  // 会话缓存 TTL（毫秒）
  SESSION_CACHE_TTL: parseInt(Deno.env.get("SESSION_CACHE_TTL") || "3600", 10) * 1000,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Session-Id",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};
const encoder = new TextEncoder();
const DONE_CHUNK = encoder.encode("data: [DONE]\n\n");

function sseData(obj: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}
function chunk(id: string, model: string, content: string, finish: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

// ---------------- Cookie & Session 工具 ----------------
function parseCookie(cookie: string | null) {
  const map = new Map<string, string>();
  if (!cookie) return map;
  for (const part of cookie.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k) map.set(k, decodeURIComponent(v ?? ""));
  }
  return map;
}

type SessionData = { kimi_session_id: string; messages: Array<{ role: "user" | "assistant"; content: string }> };
type CacheEntry = { data: SessionData; timeoutId: number; expiresAt: number };

class SessionStore {
  private map = new Map<string, CacheEntry>();

  constructor(private ttl: number) {}

  getOrCreate(key: string): SessionData {
    const now = Date.now();
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > now) return hit.data;

    const id = `session_${now}_${Math.random().toString(36).slice(2, 10)}`;
    const data: SessionData = { kimi_session_id: id, messages: [] };
    const expiresAt = now + this.ttl;
    const timeoutId = setTimeout(() => this.map.delete(key), this.ttl) as unknown as number;

    this.map.set(key, { data, timeoutId, expiresAt });
    return data;
  }

  touch(key: string) {
    const hit = this.map.get(key);
    if (!hit) return;
    clearTimeout(hit.timeoutId as unknown as number);
    hit.expiresAt = Date.now() + this.ttl;
    hit.timeoutId = setTimeout(() => this.map.delete(key), this.ttl) as unknown as number;
  }

  clear(key: string) {
    const hit = this.map.get(key);
    if (hit) clearTimeout(hit.timeoutId as unknown as number);
    this.map.delete(key);
  }

  info(key: string) {
    const hit = this.map.get(key);
    if (!hit) return null;
    return {
      kimi_session_id: hit.data.kimi_session_id,
      message_count: hit.data.messages.length,
      ttl_ms_remaining: Math.max(0, hit.expiresAt - Date.now()),
    };
  }
}

const sessions = new SessionStore(settings.SESSION_CACHE_TTL);

// ---------------- Kimi Provider ----------------
class KimiAIProvider {
  private nonce: string | null = null;
  private noncePromise: Promise<string> | null = null;

  private async fetchNonce(): Promise<string> {
    const res = await fetch(settings.CHAT_PAGE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`fetch chat page ${res.status}`);
    const html = await res.text();
    const m = html.match(/var kimi_ajax = ({.*?});/);
    if (!m?.[1]) throw new Error("no kimi_ajax nonce");
    const nonce = JSON.parse(m[1]).nonce;
    if (!nonce) throw new Error("nonce missing");
    console.log("nonce:", nonce);
    return nonce;
  }
  private getNonce(force = false) {
    if (!this.noncePromise || force) {
      this.noncePromise = this.fetchNonce()
        .then((n) => (this.nonce = n))
        .catch((e) => {
          this.noncePromise = null;
          throw e;
        });
    }
    return this.noncePromise;
  }

  private payload(prompt: string, model: string, sid: string, nonce: string) {
    const upstream =
      model === "kimi-k2-instruct-0905"
        ? "moonshotai/Kimi-K2-Instruct-0905"
        : model === "kimi-k2-instruct"
        ? "moonshotai/Kimi-K2-Instruct"
        : (() => {
            throw new Error(`unsupported model: ${model}`);
          })();
    return new URLSearchParams({
      action: "kimi_send_message",
      nonce,
      message: prompt,
      model: upstream,
      session_id: sid,
    });
  }

  async models() {
    const body = {
      object: "list",
      data: settings.KNOWN_MODELS.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "lzA6",
      })),
    };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...CORS } });
  }

  async chat(req: Request, sessionKey: string, setCookieHeader: string | null) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const json = await req.json().catch(() => ({}));
    const { messages, model = settings.DEFAULT_MODEL } = json;

    // 从会话里拼接上下文（如果本次没传 messages 或只有最后一句）
    let lastUser: { role: "user"; content: string } | null = null;
    let promptToSend: string;
    const session = sessions.getOrCreate(sessionKey);

    if (Array.isArray(messages) && messages.length > 0) {
      // 兼容 OpenAI：如果带了完整 messages，就把最新 user 纳入会话
      lastUser = messages[messages.length - 1];
      if (lastUser?.role !== "user") {
        return new Response(JSON.stringify({ error: "messages 最后一条必须是 user" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS, ...(setCookieHeader ? { "Set-Cookie": setCookieHeader } : {}) },
        });
      }
      // 把历史纳入（仅将最后一条 user 与已有会话拼接，避免无限膨胀）
      promptToSend = this.buildPrompt(session.messages, lastUser.content);
    } else {
      // 没给 messages：直接用会话最后一次的上下文（如果没有则报错）
      return new Response(JSON.stringify({ error: "缺少 messages（至少需要一条 user）" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS, ...(setCookieHeader ? { "Set-Cookie": setCookieHeader } : {}) },
      });
    }

    const reqId = `chatcmpl-${crypto.randomUUID()}`;
    const stream = new ReadableStream({
      start: async (ctl) => {
        const call = async (retry = false): Promise<string | null> => {
          try {
            const nonce = await this.getNonce(retry);
            const upstreamBody = this.payload(promptToSend!, model, session.kimi_session_id, nonce);
            const r = await fetch(settings.UPSTREAM_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
              },
              body: upstreamBody,
            });
            if (!r.ok) throw new Error(String(r.status));
            const j = await r.json();
            if (!j.success) throw new Error(String(j.data ?? "upstream error"));
            return j.data?.message ?? "";
          } catch (_e) {
            if (!retry) return await call(true);
            return null;
          }
        };

        const text = await call();
        const headers = { 
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...CORS,
          ...(setCookieHeader ? { "Set-Cookie": setCookieHeader } : {}),
        } as Record<string, string>;

        if (text == null) {
          // 失败也要把 Set-Cookie 带回去
          ctl.enqueue(sseData(chunk(reqId, model, "上游失败", "stop")));
          ctl.enqueue(DONE_CHUNK);
          // 关闭时写不进头部，故这里不用 new Response(headers)；headers 已由外层返回
          return;
        }

        // 更新会话（把本次的 user+assistant 写入）
        if (lastUser) session.messages.push(lastUser);
        session.messages.push({ role: "assistant", content: text });
        sessions.touch(sessionKey);

        for (const ch of text) {
          ctl.enqueue(sseData(chunk(reqId, model, ch)));
          await new Promise((r) => setTimeout(r, 10));
        }
        ctl.enqueue(sseData(chunk(reqId, model, "", "stop")));
        ctl.enqueue(DONE_CHUNK);
      },
    });

    return new Response(stream, { headers: { 
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...CORS,
      ...(setCookieHeader ? { "Set-Cookie": setCookieHeader } : {}),
    }});
  }

  private buildPrompt(history: { role: "user" | "assistant"; content: string }[], last: string) {
    const lines = history.map((m) => `${m.role === "user" ? "用户" : "模型"}: ${m.content}`);
    return [...lines, `用户: ${last}`].join("\n").trim();
  }
}

const provider = new KimiAIProvider();

// 解析/生成会话键，并根据需要下发 Set-Cookie
function resolveSessionKey(req: Request, bodySessionId?: string | null): { key: string; setCookie: string | null } {
  // 1) body.session_id 优先
  if (bodySessionId && typeof bodySessionId === "string") {
    return { key: `b:${bodySessionId}`, setCookie: null };
  }
  // 2) Header: X-Session-Id
  const headerSid = req.headers.get("X-Session-Id");
  if (headerSid) return { key: `h:${headerSid}`, setCookie: null };
  // 3) Cookie: sid
  const cookieMap = parseCookie(req.headers.get("Cookie"));
  const cookieSid = cookieMap.get("sid");
  if (cookieSid) return { key: `c:${cookieSid}`, setCookie: null };
  // 4) 都没有就生成并下发 Cookie
  const sid = `${crypto.randomUUID()}`;
  const cookie = [
    `sid=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    // 不标 Secure，方便本地；部署到 HTTPS 可加上 Secure
    `Max-Age=${Math.floor(settings.SESSION_CACHE_TTL / 1000)}`,
  ].join("; ");
  return { key: `c:${sid}`, setCookie: cookie };
}

// ---------------- HTTP 处理（导出给 Vercel） ----------------
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // 根页面
  if (p === "/" && req.method === "GET") {
    const html = `<!doctype html><meta charset="utf-8"><title>${settings.APP_NAME}</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:40px;max-width:760px;margin:auto}code{background:#f4f4f4;padding:.2em .4em;border-radius:6px}</style>
<h1>✅ ${settings.APP_NAME} v${settings.APP_VERSION}</h1>
<p>${settings.DESCRIPTION}</p>
<h3>上下文会话已启用（内存，TTL=${Math.floor(settings.SESSION_CACHE_TTL/1000)}s）</h3>
<ol>
  <li>自动识别 <code>session_id</code>（body）、<code>X-Session-Id</code>（header）或 <code>sid</code>（cookie）。</li>
  <li>都不传则自动生成 <code>sid</code> 并下发 Set-Cookie。</li>
  <li>会话接口：<code>GET /v1/session</code> 查看、<code>POST /v1/session/reset</code> 重置。</li>
</ol>
<p>示例：</p>
<pre><code>curl -s https://YOUR-URL.vercel.app/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"kimi-k2-instruct-0905","messages":[{"role":"user","content":"你好！"}]}'</code></pre>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
  }

  // 读取 body 的 session_id（如果是 chat 接口）
  let bodySessionId: string | null = null;
  if (p === "/v1/chat/completions" && req.method === "POST") {
    try {
      const text = await req.clone().text();
      if (text) {
        const j = JSON.parse(text);
        if (j && typeof j.session_id === "string") bodySessionId = j.session_id;
      }
    } catch {
      // ignore
    }
  }

  const { key: sessionKey, setCookie } = resolveSessionKey(req, bodySessionId);

  // 会话查看/重置
  if (p === "/v1/session" && req.method === "GET") {
    const info = sessions.info(sessionKey) ?? { note: "当前无会话，下一次 chat 将自动创建。" };
    return new Response(JSON.stringify({ session_key: sessionKey, ...info }), {
      headers: { "Content-Type": "application/json", ...CORS, ...(setCookie ? { "Set-Cookie": setCookie } : {}) },
    });
  }
  if (p === "/v1/session/reset" && req.method === "POST") {
    sessions.clear(sessionKey);
    return new Response(JSON.stringify({ ok: true, cleared: sessionKey }), {
      headers: { "Content-Type": "application/json", ...CORS, ...(setCookie ? { "Set-Cookie": setCookie } : {}) },
    });
  }

  // 模型列表
  if (p === "/v1/models" && req.method === "GET") {
    const resp = await provider.models();
    const headers = new Headers(resp.headers);
    if (setCookie) headers.set("Set-Cookie", setCookie);
    return new Response(await resp.text(), { status: resp.status, headers });
  }

  // Chat Completions（带上下文）
  if (p === "/v1/chat/completions" && req.method === "POST") {
    return provider.chat(req, sessionKey, setCookie);
  }

  return new Response(JSON.stringify({ detail: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...CORS, ...(setCookie ? { "Set-Cookie": setCookie } : {}) },
  });
}

// 仅“本地直接运行 main.ts”时才监听端口；Vercel 不会走这里
if (import.meta.main) {
  Deno.serve({ port: settings.PORT }, handle);
}
