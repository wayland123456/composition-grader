// ====================================================================
// 共用：教师账号存储（Postgres）
// --------------------------------------------------------------------
// 为什么不用 Secrets：Supabase 的 Secrets 只能通过控制台/CLI 写，
// 函数自身改不了，老师也就没法自助改密码。
// 所以密码哈希落到表 public.teacher_accounts：
//   · 首次登录时用 Secrets 里的 TEACHER_ACCOUNTS 校验，通过后把哈希落库（引导）
//   · 之后一律以库里的哈希为准，改密码就是 UPDATE 这一行
//   · 数据库不可用时回落到 Secrets，保证登录不会因为库挂了而全盘失败
// ====================================================================

import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

export interface TeacherRow {
  account: string;
  name: string;
  pwd_hash: string;
}

export interface SeedTeacher {
  account: string;
  name: string;
  hash: string;
}

export async function getDb(): Promise<Client> {
  const url = Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("SUPABASE_DB_URL 未配置");
  const client = new Client(url);
  await client.connect();
  return client;
}

export async function ensureTable(db: Client): Promise<void> {
  await db.queryObject(
    `CREATE TABLE IF NOT EXISTS public.teacher_accounts (
       account    text PRIMARY KEY,
       name       text NOT NULL,
       pwd_hash   text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

export async function findTeacherFromDb(
  db: Client,
  account: string,
): Promise<TeacherRow | null> {
  const res = await db.queryObject<TeacherRow>(
    `SELECT account, name, pwd_hash FROM public.teacher_accounts WHERE account = $1`,
    [account],
  );
  return res.rows[0] || null;
}

export async function saveTeacherHash(
  db: Client,
  account: string,
  name: string,
  pwdHash: string,
): Promise<void> {
  await db.queryObject(
    `INSERT INTO public.teacher_accounts (account, name, pwd_hash, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (account) DO UPDATE
       SET pwd_hash = EXCLUDED.pwd_hash,
           name = EXCLUDED.name,
           updated_at = now()`,
    [account, name, pwdHash],
  );
}

/** 读取 Secrets 里的初始账号表（作为引导数据与降级兜底） */
export function loadSeedTeachers(): SeedTeacher[] {
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
