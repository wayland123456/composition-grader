// Supabase Edge Function: ocr
// POST { image: "data:image/...;base64,..." }
//   or { imageBase64: "..." }（兼容旧字段名）
//   或 { imageUrl: "https://..." }
// 调用通义千问 qwen-vl-ocr 识别手写体中文，返回纯文本。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const DASHSCOPE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// 服务端鉴权：允许的 apikey 集合 = 项目 publishable key（新版）
// 平台 verify_jwt 必须关（publishable key 不是 JWT），由函数自己校验 apikey header。
// 优先读 env `SUPABASE_PUBLISHABLE_KEYS`（JSON 对象数组）兜底硬编码。
const FALLBACK_KEY = "sb_publishable_PqN5m9yOrWZzBazFjO7Y_w_pfIMO1PI"; // 英语网站项目 publishable
const EXPECTED_KEYS = (() => {
  const keys = new Set<string>();
  try {
    const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "";
    if (raw) {
      const obj = JSON.parse(raw);
      for (const v of Object.values(obj)) keys.add(String(v));
    }
  } catch {}
  keys.add(FALLBACK_KEY);
  return keys;
})();

// DashScope API Key：优先 env 兜底硬编码
const FALLBACK_DASH_KEY = "sk-f023354dbf9c4022b2a0f33b30da8d73";
const getDashKey = () => Deno.env.get("DASHSCOPE_API_KEY") || FALLBACK_DASH_KEY;

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "仅支持 POST" }, 405);
  }

  // 鉴权：校验 apikey header。若项目有 publishable keys，必须匹配其中一把。
  const authKey = req.headers.get("apikey") || "";
  if (!authKey) {
    return jsonResp({ error: "缺少 apikey" }, 401);
  }
  if (EXPECTED_KEYS.size > 0 && !EXPECTED_KEYS.has(authKey)) {
    return jsonResp({ error: "apikey 无效" }, 401);
  }

  const apiKey = getDashKey();

  let payload: {
    image?: string;
    imageBase64?: string;
    imageUrl?: string;
    prompt?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ error: "请求体不是合法 JSON" }, 400);
  }

  // 兼容字段名
  const imageBase64 = payload.image || payload.imageBase64 || "";
  const imageUrl = payload.imageUrl || "";
  const prompt =
    payload.prompt ||
    "请仔细识别图片中所有手写或印刷的中文/英文文字，按原文自然段落顺序输出。保留标点、换行与段落结构，不要输出任何解释、标题或前后缀文字。";

  if (!imageBase64 && !imageUrl) {
    return jsonResp({ error: "缺少 image / imageUrl 字段" }, 400);
  }

  // 构造 content 第一项
  const imageContent = imageUrl
    ? { image: imageUrl }
    : {
        image: imageBase64.startsWith("data:")
          ? imageBase64
          : `data:image/jpeg;base64,${imageBase64}`,
      };

  const body = {
    model: "qwen-vl-ocr",
    input: {
      messages: [
        {
          role: "user",
          content: [imageContent, { text: prompt }],
        },
      ],
    },
    parameters: {},
  };

  let dashResp: Response;
  try {
    dashResp = await fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return jsonResp({ error: `调用 DashScope 失败: ${(err as Error).message}` }, 502);
  }

  const text = await dashResp.text();
  if (!dashResp.ok) {
    return jsonResp(
      { error: `DashScope 返回 ${dashResp.status}`, detail: text.slice(0, 1000) },
      dashResp.status,
    );
  }

  let data: {
    output?: {
      choices?: Array<{
        message?: { content?: Array<{ text?: string }> };
      }>;
    };
  };
  try {
    data = JSON.parse(text);
  } catch {
    return jsonResp({ error: "DashScope 返回不是 JSON", detail: text.slice(0, 500) }, 502);
  }

  const ocrText = data?.output?.choices?.[0]?.message?.content
    ?.map((c) => c.text || "")
    .join("")
    .trim();

  if (!ocrText) {
    return jsonResp({ error: "OCR 未识别出文字", raw: data }, 502);
  }

  return jsonResp({ text: ocrText, model: "qwen-vl-ocr" });
});
