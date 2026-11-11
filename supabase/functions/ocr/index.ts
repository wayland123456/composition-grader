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

// 服务端鉴权（2026-11-11 改造）：只认 login 函数签发的教师令牌。
// publishable key 是公开的、拿网页源码就有，绝不能当通行证用。
// 平台层的 Verify JWT 保持 Disable（自签令牌不是 Supabase 签发的），由函数自己验签。
import { verifyTeacher } from "../_shared/auth.ts";

// DashScope API Key：只从 Edge Function Secrets 读取，禁止写入代码或仓库。
// 配置方式：Supabase Dashboard -> Project Settings -> Edge Functions -> Secrets
//           新增 DASHSCOPE_API_KEY，然后重新 Deploy 本函数。
const getDashKey = () => Deno.env.get("DASHSCOPE_API_KEY") || "";

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

  // 鉴权：必须是已登录教师（login 函数签发的令牌）
  const auth = await verifyTeacher(req);
  if (!auth.ok) {
    return jsonResp({ error: auth.error }, auth.status || 401);
  }

  const apiKey = getDashKey();
  if (!apiKey) {
    return jsonResp(
      { error: "服务端未配置 DASHSCOPE_API_KEY，请在 Supabase 项目 Secrets 中设置后重新部署" },
      500,
    );
  }

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

  // 成本护栏：单张图片 base64 超过 4.5MB（约 3.3MB 原图）直接拒绝，
  // 防止令牌万一外泄后被拿来跑大图批量刷额度。
  if (imageBase64 && imageBase64.length > 4_500_000) {
    return jsonResp({ error: "图片过大（超过约 3MB），请压缩后再上传" }, 413);
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
