// ====================================================================
// 共用：教师令牌（JWT HS256）校验 / 签发
// --------------------------------------------------------------------
// 设计要点（2026-11-11 安全改造）：
//   1. 前端不再持有任何可用于调用模型的凭据。publishable key 谁都能看到，
//      所以它绝不能当作"通行证"——之前正是这么用的，导致拿网页源码就能刷 token。
//   2. 通行证由 login 函数在账号密码校验通过后签发，密钥只在 Secrets
//      （AUTH_JWT_SECRET），前端伪造不了签名，也猜不出。
//   3. 令牌 8 小时过期，过期必须重新登录。
// ====================================================================

const AUTH_SECRET = () => Deno.env.get("AUTH_JWT_SECRET") || "";
export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface TeacherClaims {
  sub: string;   // 账号，如 lihaifeng
  name: string;  // 姓名，如 李海峰
  iat: number;
  exp: number;
  iss: string;
}

export async function signTeacherToken(
  account: string,
  name: string,
): Promise<{ token: string; exp: number }> {
  const secret = AUTH_SECRET();
  if (!secret) throw new Error("服务端未配置 AUTH_JWT_SECRET");
  const now = Math.floor(Date.now() / 1000);
  const claims: TeacherClaims = {
    sub: account,
    name,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    iss: "composition-grader",
  };
  const header = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(data),
  );
  return { token: `${data}.${b64urlEncode(new Uint8Array(sig))}`, exp: claims.exp };
}

export interface VerifyResult {
  ok: boolean;
  status?: number;
  error?: string;
  claims?: TeacherClaims;
}

/** 校验请求头里的 Authorization: Bearer <token>。失败时给出 401/500 的错误文案。 */
export async function verifyTeacher(req: Request): Promise<VerifyResult> {
  const secret = AUTH_SECRET();
  if (!secret) {
    return { ok: false, status: 500, error: "服务端未配置 AUTH_JWT_SECRET" };
  }

  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return { ok: false, status: 401, error: "未登录：缺少访问令牌，请重新登录" };
  }

  const parts = m[1].trim().split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: "访问令牌格式不正确，请重新登录" };
  }
  const [h64, p64, s64] = parts;

  let signatureOk = false;
  try {
    signatureOk = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(s64),
      new TextEncoder().encode(`${h64}.${p64}`),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { ok: false, status: 401, error: "访问令牌无效，请重新登录" };
  }

  let claims: TeacherClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p64)));
  } catch {
    return { ok: false, status: 401, error: "访问令牌内容损坏，请重新登录" };
  }

  if (!claims || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    return { ok: false, status: 401, error: "登录已过期（8 小时），请重新登录" };
  }
  if (!claims.sub) {
    return { ok: false, status: 401, error: "访问令牌缺少账号信息，请重新登录" };
  }
  return { ok: true, claims };
}

// ---- 密码校验：PBKDF2-SHA256，格式 pbkdf2$<迭代次数>$<saltB64>$<hashB64> ----

export function parsePasswordHash(stored: string): {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
} | null {
  const m = /^pbkdf2\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored || "");
  if (!m) return null;
  return {
    iterations: parseInt(m[1], 10),
    salt: b64Decode(m[2]),
    hash: b64Decode(m[3]),
  };
}

/** 常量时间比较，避免按字节提前返回泄露信息 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: parsed.salt,
        iterations: parsed.iterations,
        hash: "SHA-256",
      },
      key,
      parsed.hash.length * 8,
    );
    return timingSafeEqual(new Uint8Array(bits), parsed.hash);
  } catch {
    return false;
  }
}

export function b64FromString(s: string): string {
  return b64Encode(new TextEncoder().encode(s));
}
