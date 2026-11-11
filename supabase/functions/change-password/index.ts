// ====================================================================
// Supabase Edge Function: change-password
// POST { oldPassword, newPassword }  + Authorization: Bearer <教师令牌>
// -> { token, exp }   （返回新令牌，前端可直接替换本地会话）
// --------------------------------------------------------------------
// 老师自助改密码。身份来自令牌（不用前端传账号，防止改别人的密码）。
// 新哈希写入 public.teacher_accounts，立即生效。
// ====================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { hashPassword, signTeacherToken, verifyPassword, verifyTeacher } from "../_shared/auth.ts";
import {
  ensureTable,
  findTeacherFromDb,
  getDb,
  loadSeedTeachers,
  saveTeacherHash,
} from "../_shared/teachers.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResp({ error: "仅支持 POST" }, 405);

  // 身份来自令牌，不接受前端指定账号
  const auth = await verifyTeacher(req);
  if (!auth.ok) return jsonResp({ error: auth.error }, auth.status || 401);
  const account = auth.claims!.sub;
  const name = auth.claims!.name || account;

  let payload: { oldPassword?: string; newPassword?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ error: "请求体不是合法 JSON" }, 400);
  }

  const oldPassword = String(payload?.oldPassword || "");
  const newPassword = String(payload?.newPassword || "");

  if (!oldPassword || !newPassword) {
    return jsonResp({ error: "请填写当前密码和新密码" }, 400);
  }
  if (newPassword.length < 8 || newPassword.length > 64) {
    return jsonResp({ error: "新密码长度需为 8-64 位" }, 400);
  }
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return jsonResp({ error: "新密码需同时包含字母和数字" }, 400);
  }
  if (newPassword === oldPassword) {
    return jsonResp({ error: "新密码不能与当前密码相同" }, 400);
  }

  let db = null as Awaited<ReturnType<typeof getDb>> | null;
  try {
    db = await getDb();
    await ensureTable(db);
  } catch (e) {
    return jsonResp({ error: "数据库不可用，暂时无法修改密码：" + (e as Error).message }, 500);
  }

  try {
    const row = await findTeacherFromDb(db, account);
    const seed = loadSeedTeachers().find((t) => t.account === account);
    const currentHash = row?.pwd_hash || seed?.hash || "";

    if (!currentHash) {
      return jsonResp({ error: "账号不存在" }, 404);
    }

    const ok = await verifyPassword(oldPassword, currentHash);
    if (!ok) {
      // 放缓爆破
      await new Promise((r) => setTimeout(r, 700));
      return jsonResp({ error: "当前密码不正确" }, 401);
    }

    const newHash = await hashPassword(newPassword);
    await saveTeacherHash(db, account, row?.name || name, newHash);

    const { token, exp } = await signTeacherToken(account, row?.name || name);
    return jsonResp({ ok: true, token, exp, message: "密码已更新" });
  } catch (e) {
    return jsonResp({ error: "修改失败：" + (e as Error).message }, 500);
  } finally {
    try { await db.end(); } catch { /* ignore */ }
  }
});
