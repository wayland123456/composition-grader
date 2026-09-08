// Supabase Edge Function: report
// 存储 / 读取语文作文批改报告，解决"分享链接过长被截断"问题。
//
//   POST  { data: {...} }        ->  { id }        存报告，返回 8 位短 ID
//   GET   ?id=<短ID>             ->  { id, data }  取报告
//
// 鉴权：apikey header = publishable key（与 ocr/score 一致，函数需设 Verify JWT = Disable）。
// 存储：直连 Supabase Postgres（SUPABASE_DB_URL），表 public.reports 首次运行时自动创建。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// 允许的 apikey（publishable key），与 ocr/score 保持一致
const FALLBACK_KEY = "sb_publishable_PqN5m9yOrWZzBazFjO7Y_w_pfIMO1PI";

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// 8 位短 ID（去掉易混淆的 0/O/1/l/I）
const ID_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
function genId(len = 8) {
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (let i = 0; i < len; i++) s += ID_CHARS[arr[i] % ID_CHARS.length];
  return s;
}

async function getDb() {
  const url = Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("SUPABASE_DB_URL 未配置");
  const client = new Client(url);
  await client.connect();
  return client;
}

serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 鉴权：校验 apikey header
  const authKey = req.headers.get("apikey") || "";
  let valid = authKey === FALLBACK_KEY;
  if (!valid) {
    try {
      const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}";
      const obj = JSON.parse(raw);
      valid = Object.values(obj).some((v) => String(v) === authKey);
    } catch {
      /* ignore */
    }
  }
  if (!valid) return jsonResp({ error: "apikey 无效" }, 401);

  let db: Client;
  try {
    db = await getDb();
  } catch (e) {
    return jsonResp({ error: "数据库连接失败：" + (e as Error).message }, 500);
  }

  try {
    // 幂等建表（若项目里没有 SUPABASE_DB_URL 或无权建表，会在此报错）
    await db.queryObject(
      `CREATE TABLE IF NOT EXISTS public.reports (
         id text PRIMARY KEY,
         data jsonb NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )`
    );

    if (req.method === "POST") {
      let payload: { data?: unknown };
      try {
        payload = await req.json();
      } catch {
        return jsonResp({ error: "请求体不是合法 JSON" }, 400);
      }
      if (!payload || !payload.data) {
        return jsonResp({ error: "缺少 data 字段" }, 400);
      }
      const id = genId();
      await db.queryObject(
        `INSERT INTO public.reports (id, data) VALUES ($1, $2::jsonb)`,
        [id, JSON.stringify(payload.data)]
      );
      return jsonResp({ id });
    }

    if (req.method === "GET") {
      const id = (new URL(req.url).searchParams.get("id") || "").trim();
      if (!id) return jsonResp({ error: "缺少 id 参数" }, 400);
      const res = await db.queryObject<{ data: unknown }>(
        `SELECT data FROM public.reports WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) {
        return jsonResp({ error: "报告不存在或已失效" }, 404);
      }
      const raw = res.rows[0].data;
      // deno-postgres 对 jsonb 可能返回字符串或已解析对象，统一归一化
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return jsonResp({ id, data });
    }

    return jsonResp({ error: "不支持的方法" }, 405);
  } catch (e) {
    return jsonResp({ error: "处理失败：" + (e as Error).message }, 500);
  } finally {
    try {
      await db.end();
    } catch {
      /* ignore */
    }
  }
});
