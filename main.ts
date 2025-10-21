// main.ts (v1.1 - 已修复语法错误)

// 从 Deno 标准库导入必要的模块
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";

// --- 1. 配置模块 (等同于 app/core/config.py 和 .env) ---

// 动态加载 .env 文件中的环境变量
// 在启动时使用 `deno run --load` 标志是更现代的方式，但这里提供代码内加载作为备用
await load({ export: true });

const settings = {
  APP_NAME: "kimi-ai-2api-deno",
  APP_VERSION: "1.0.0",
  DESCRIPTION: "一个将 kimi-ai.chat 转换为兼容 OpenAI 格式 API 的高性能 Deno 代理。",

  // 从环境变量读取，提供默认值
  API_MASTER_KEY: Deno.env.get("API_MASTER_KEY") || "sk-kimi-ai-2api-default-key-please-change-me",
  PORT: parseInt(Deno.env.get("PORT") || "8088", 10),
  SESSION_CACHE_TTL: parseInt(Deno.env.get("SESSION_CACHE_TTL") || "3600", 10) * 1000, // 转换为毫秒

  // Kimi 上游服务的相关配置
  UPSTREAM_URL: "https://kimi-ai.chat/wp-admin/admin-ajax.php",
  CHAT_PAGE_URL: "https://kimi-ai.chat/chat/",
  
  // 支持的模型列表
  KNOWN_MODELS: ["kimi-k2-instruct-0905", "kimi-k2-instruct"],
  DEFAULT_MODEL: "kimi-k2-instruct-0905",
};

// --- 2. SSE 工具函数 (等同于 app/utils/sse_utils.py) ---

const encoder = new TextEncoder();
const DONE_CHUNK = encoder.encode("data: [DONE]\n\n");

function createSSEData(data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function createChatCompletionChunk(
  requestId: string,
  model: string,
  content: string,
  finishReason: string | null = null
): Record<string, unknown> {
  return {
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: { content: content },
        finish_reason: finishReason,
      },
    ],
  };
}

// --- 3. 核心服务提供者 (等同于 app/providers/kimi_ai_provider.py) ---

class KimiAIProvider {
  private sessionCache = new Map<string, any>();
  private nonce: string | null = null;
  private noncePromise: Promise<string> | null = null;

  constructor() {
    console.info("正在初始化 KimiAIProvider，首次获取 nonce...");
    this.getNonce().catch(err => console.error("初始化 nonce 失败:", err));
  }

  private async fetchNonce(): Promise<string> {
    try {
      console.info("正在从上游页面抓取新的 nonce...");
      const response = await fetch(settings.CHAT_PAGE_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`获取上游页面失败，状态码: ${response.status}`);
      }

      const htmlContent = await response.text();
      const match = htmlContent.match(/var kimi_ajax = ({.*?});/);
      if (!match || !match[1]) {
        throw new Error("在页面 HTML 中未找到 'kimi_ajax' JS 变量。");
      }

      const ajaxData = JSON.parse(match[1]);
      const nonce = ajaxData.nonce;
      if (!nonce) {
        throw new Error("'kimi_ajax' 对象中缺少 'nonce' 字段。");
      }

      console.log(`成功抓取到新的 nonce: ${nonce}`);
      return nonce;
    } catch (error) {
      console.error(`抓取 nonce 失败: ${error.message}`);
      throw new Error(`无法从上游服务获取必要的动态参数: ${error.message}`);
    }
  }

  private getNonce(forceRefresh = false): Promise<string> {
    if (!this.noncePromise || forceRefresh) {
      this.noncePromise = this.fetchNonce().then(nonce => {
        this.nonce = nonce;
        return nonce;
      }).catch(err => {
        this.noncePromise = null; // 失败时允许重试
        throw err;
      });
    }
    return this.noncePromise;
  }

  private getOrCreateSession(userKey: string): any {
    if (this.sessionCache.has(userKey)) {
      return this.sessionCache.get(userKey).data;
    }

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 11);
    const newSessionId = `session_${timestamp}_${randomStr}`;

    const newSession = {
      kimi_session_id: newSessionId,
      messages: [],
    };

    const timeoutId = setTimeout(() => {
      this.sessionCache.delete(userKey);
      console.log(`会话 '${userKey}' 已过期并被清除。`);
    }, settings.SESSION_CACHE_TTL);

    this.sessionCache.set(userKey, { data: newSession, timeoutId });
    console.info(`为用户 '${userKey}' 创建了新的会话: ${newSessionId}`);
    return newSession;
  }

  private buildContextualPrompt(history: { role: string; content: string }[], newMessage: string): string {
    const historyLines = history.map(msg => {
      const role = msg.role === "user" ? "用户" : "模型";
      return `${role}: ${msg.content}`;
    });
    return [...historyLines, `用户: ${newMessage}`].join("\n").trim();
  }

  private preparePayload(prompt: string, model: string, sessionId: string, nonce: string): URLSearchParams {
    let upstreamModel: string;
    if (model === "kimi-k2-instruct-0905") {
      upstreamModel = "moonshotai/Kimi-K2-Instruct-0905";
    } else if (model === "kimi-k2-instruct") {
      upstreamModel = "moonshotai/Kimi-K2-Instruct";
    } else {
      throw new Error(`不支持的模型: ${model}`);
    }

    return new URLSearchParams({
      action: "kimi_send_message",
      nonce: nonce,
      message: prompt,
      model: upstreamModel,
      session_id: sessionId,
    });
  }

  async getModels(): Promise<Response> {
    const modelData = {
      object: "list",
      data: settings.KNOWN_MODELS.map(name => ({
        id: name,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "lzA6",
      })),
    };
    return new Response(JSON.stringify(modelData), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async chatCompletion(request: Request): Promise<Response> {
    const requestData = await request.json();
    const { messages, user, model = settings.DEFAULT_MODEL } = requestData;

    if (!messages || !Array.isArray(messages) || messages.length === 0 || messages[messages.length - 1].role !== "user") {
      return new Response(JSON.stringify({ error: "'messages' 列表不能为空，且最后一条必须是 user 角色。" }), { status: 400 });
    }

    const currentUserMessage = messages[messages.length - 1];
    let sessionData: any;
    let promptToSend: string;
    let kimiSessionId: string;

    if (user) {
      console.info(`检测到 'user' 字段，进入有状态模式。用户: ${user}`);
      sessionData = this.getOrCreateSession(user);
      promptToSend = this.buildContextualPrompt(sessionData.messages, currentUserMessage.content);
      kimiSessionId = sessionData.kimi_session_id;
    } else {
      console.info("未检测到 'user' 字段，进入无状态模式。");
      promptToSend = currentUserMessage.content;
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 11);
      kimiSessionId = `session_${timestamp}_${randomStr}`;
    }

    const requestId = `chatcmpl-${crypto.randomUUID()}`;

    const stream = new ReadableStream({
      start: async (controller) => { // <--- 这里是修正的关键点
        const makeRequest = async (isRetry = false): Promise<string | null> => {
          try {
            const nonce = await this.getNonce(isRetry);
            const payload = this.preparePayload(promptToSend, model, kimiSessionId, nonce);

            console.info(`向上游发送请求, Session ID: ${kimiSessionId}, 模型: ${model}`);
            
            const response = await fetch(settings.UPSTREAM_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
              },
              body: payload,
            });

            if (!response.ok) throw new Error(`上游 API 错误，状态码: ${response.status}`);

            const responseData = await response.json();
            if (!responseData.success) {
              throw new Error(`上游请求失败: ${responseData.data || "未知错误"}`);
            }
            return responseData.data?.message || "";
          } catch (error) {
            console.error(`请求上游服务时出错: ${error.message}`);
            if (!isRetry) {
              console.warn("尝试刷新 nonce 并重试...");
              return await makeRequest(true);
            }
            return null; // 重试失败后返回 null
          }
        };

        const assistantResponseContent = await makeRequest();

        if (assistantResponseContent === null) {
            const errorChunk = createChatCompletionChunk(requestId, model, "重试后上游请求依然失败", "stop");
            controller.enqueue(createSSEData(errorChunk));
            controller.enqueue(DONE_CHUNK);
            controller.close();
            return;
        }

        if (sessionData) {
          sessionData.messages.push(currentUserMessage);
          sessionData.messages.push({ role: "assistant", content: assistantResponseContent });
          console.info(`会话 '${user}' 上下文已更新。`);
        }

        // 伪流式生成
        for (const char of assistantResponseContent) {
          const chunk = createChatCompletionChunk(requestId, model, char);
          controller.enqueue(createSSEData(chunk));
          await new Promise(resolve => setTimeout(resolve, 20)); // 模拟打字机效果
        }

        const finalChunk = createChatCompletionChunk(requestId, model, "", "stop");
        controller.enqueue(createSSEData(finalChunk));
        controller.enqueue(DONE_CHUNK);
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }
}


// --- 4. HTTP 服务器与路由 (等同于 main.py 和 nginx.conf) ---

const provider = new KimiAIProvider();

console.info(`${settings.APP_NAME} v${settings.APP_VERSION} 启动中...`);

Deno.serve({ port: settings.PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 安全检查 (等同于 verify_api_key)
  if (settings.API_MASTER_KEY && settings.API_MASTER_KEY !== "1") {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return new Response(JSON.stringify({ detail: "需要 Bearer Token 认证。" }), { status: 401 });
    }
    const token = authHeader.substring(7);
    if (token !== settings.API_MASTER_KEY) {
      return new Response(JSON.stringify({ detail: "无效的 API Key。" }), { status: 403 });
    }
  }

  // 路由
  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    return await provider.chatCompletion(req);
  }

  if (pathname === "/v1/models" && req.method === "GET") {
    return await provider.getModels();
  }

  if (pathname === "/" && req.method === "GET") {
    return new Response(
        JSON.stringify({ message: `欢迎来到 ${settings.APP_NAME} v${settings.APP_VERSION}. 服务运行正常。` }),
        { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
});

console.info(`服务已启动，正在监听 http://localhost:${settings.PORT}`);
