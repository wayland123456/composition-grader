// ====================================================================
// Supabase Edge Function: login
// POST { account, password } -> { token, name, account, exp }
// --------------------------------------------------------------------
// 教师登录。账号密码校验通过后签发 8 小时有效的 JWT，其它函数只认这枚令牌。
// 密码哈希与签名密钥都只存在 Edge Function Secrets：
//   TEACHER_ACCOUNTS = [{"account":"lihaifeng","name":"李海峰","hash":"pbkdf2$..."}]
//   AUTH_JWT_SECRET  = 随机长串（base64url）
// 前端代码里没有任何能换到令牌的字符串，拿源码也刷不了模型的 token。
// ====================================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { signTeacherToken, verifyPassword } from "../_shared/auth.ts";

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

interface TeacherRecord {
  account: string;
  name: string;
  hash: string;
}

function loadTeachers(): TeacherRecord[] {
  try {
    const raw = Deno.env.get("TEACHER_ACCOUNTS") || "";
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t) => t && typeof t.account === "string" && typeof t.hash === "string")
      .map((t) => ({
        account: String(t.account).trim().toLowerCase(),
        name: String(t.name || t.account),
        hash: String(t.hash),
      }));
  } catch {
    return [];
  }
}

// 简易防爆破：同一实例内按账号累计失败次数，5 次锁 10 分钟。
// （Edge Function 实例会被复用，够挡住脚本瞎试；跨实例的严格限流交给阿里云额度兜底。）
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

  const teachers = loadTeachers();
  if (teachers.length === 0) {
    return jsonResp(
      { error: "服务端未配置 TEACHER_ACCOUNTS，请在 Supabase Secrets 中设置后重新部署" },
      500,
    );
  }

  const teacher = teachers.find((t) => t.account === account);
  // 账号不存在也走一遍哈希，避免用响应时间判断账号是否存在
  const dummyHash =
    "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = await verifyPassword(password, teacher ? teacher.hash : dummyHash);

  if (!teacher || !ok) {
    recordFail(account);
    // 放缓爆破速度（也让"账号是否存在"在时间上不可区分）
    await new Promise((r) => setTimeout(r, 700));
    return jsonResp({ error: "账号或密码不正确" }, 401);
  }

  fails.delete(account);

  try {
    const { token, exp } = await signTeacherToken(teacher.account, teacher.name);
    return jsonResp({
      token,
      account: teacher.account,
      name: teacher.name,
      exp,
      expiresIn: exp - Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    return jsonResp({ error: (e as Error).message }, 500);
  }
});
