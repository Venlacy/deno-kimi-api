#!/usr/bin/env deno run --allow-net --allow-env --allow-read
// ↑ shebang 用来告诉 vercel-deno 需要哪些 Deno 权限（官方推荐做法）

// 如果 main.ts 里是 Deno.serve(...)，简单做法是把核心“请求处理函数”抽出来：
// 例如在 main.ts 里导出：export async function handle(req: Request): Promise<Response> { ... }
// 然后这里直接复用。
// 若你不想动 main.ts，也可以在这里复制 main.ts 中的路由/处理逻辑。

import { handle } from "../main.ts"; // ← 假设你在 main.ts 暴露了 handle(req)

export default async function (req: Request): Promise<Response> {
  return handle(req);
}
