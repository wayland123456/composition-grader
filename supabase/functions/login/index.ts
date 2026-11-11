// ====================================================================
// Supabase Edge Function: login
// POST { account, password } -> { token, name, account, exp }
// --------------------------------------------------------------------
// 教师登录。账号密码校验通过后签发 8 小时有效的 JWT，其它函数只认这枚令牌。
// 密码来源：优先 public.teacher_accounts（老师可自助改），
//           首次登录时用 Secrets 的 TEACHER_ACCOUNTS 校验并落库（引导）。
// 前端代码里没有任何能换到令牌的字符串，拿源码也刷不了模型的 token。
// ====================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { signTeacherToken, verifyPassword } from "../_shared/auth.ts";
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

// 简易防爆破：同一实例内按账号累计失败次数，5 次锁 10 分钟。
const FAIL_LIMIT = 5;
const LOCK_MS = 10 * 60 * 1000;
const fails = new Map<string, { count: number; until: number }>();

function lockedUntil(account: string): number {
  const rec = fails.get(account);
  if (!rec) return 0;
  return rec.until > Date.now() ? rec.until : 0;
}

function recordFail(account: string) {
  const rec = fails.get(account) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= FAIL_LIMIT) {
    rec.until = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  fails.set(account, rec);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonResp({ error: "仅支持 POST" }, 405);

  let payload: { account?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ error: "请求体不是合法 JSON" }, 400);
  }

  const account = String(payload?.account || "").trim().toLowerCase();
  const password = String(payload?.password || "");
  if (!account || !password) {
    return jsonResp({ error: "请输入账号和密码" }, 400);
  }

  const lock = lockedUntil(account);
  if (lock) {
    const mins = Math.ceil((lock - Date.now()) / 60000);
    return jsonResp({ error: `密码错误次数过多，请 ${mins} 分钟后再试` }, 429);
  }

  let db = null as Awaited<ReturnType<typeof getDb>> | null;
  let record: { account: string; name: string; hash: string } | null = null;
  let fromDb = false;

  try {
    db = await getDb();
    await ensureTable(db);
    const row = await findTeacherFromDb(db, account);
    if (row) {
      record = { account: row.account, name: row.name, hash: row.pwd_hash };
      fromDb = true;
    }
  } catch (_e) {
    // 数据库不可用：降级到 Secrets，仅保证登录不至于全盘失败
    db = null;
  }

  if (!record) {
    const seed = loadSeedTeachers().find((t) => t.account === account);
    if (seed) record = { account: seed.account, name: seed.name, hash: seed.hash };
  }

  if (!record && !db) {
    const hasSeed = loadSeedTeachers().length > 0;
    return jsonResp(
      {
        error: hasSeed
          ? "账号或密码不正确"
          : "服务端未配置教师账号，请在 Supabase Secrets 中设置 TEACHER_ACCOUNTS",
      },
      hasSeed ? 401 : 500,
    );
  }

  // 账号不存在也走一遍哈希，避免用响应时间判断账号是否存在
  const dummyHash =
    "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifyPassword(password, record ? record.hash : dummyHash);

  if (!record || !ok) {
    recordFail(account);
    try { if (db) await db.end(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 700));
    return jsonResp({ error: "账号或密码不正确" }, 401);
  }

  // 首次用 Secrets 账号登录成功 → 把哈希落库，之后改密码改的就是这一行
  if (!fromDb && db) {
    try {
      await saveTeacherHash(db, record.account, record.name, record.hash);
    } catch { /* 落库失败不影响本次登录 */ }
  }

  fails.delete(account);
  try { if (db) await db.end(); } catch { /* ignore */ }

  try {
    const { token, exp } = await signTeacherToken(record.account, record.name);
    return jsonResp({
      token,
      account: record.account,
      name: record.name,
      exp,
      expiresIn: exp - Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
