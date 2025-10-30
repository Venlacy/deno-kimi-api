#!/usr/bin/env deno run --allow-net --allow-env --allow-read
// Vercel serverless entry for Deno. Expects your main.ts to export: export async function handle(req: Request): Promise<Response>
// If your main.ts doesn't yet export handle, see README_APPLY.md for Option A (recommended) to refactor, or Option B to copy logic here.
import { handle } from "../main.ts";
export default function (req: Request): Promise<Response> {
  return handle(req);
}
