// Supabase Edge Function: score
// POST { title, content, question }
// 调用通义千问 qwen-max 按高考语文作文 60 分制评分，返回结构化 JSON。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const DASHSCOPE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
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

const RUBRIC = `
【评分标准：高考语文作文 60 分制（四等分档）】
- 基础等级 40 分 = 内容 20 + 表达 20，按四等打分：
  · 一等 17–20：完全切合题意，立意深刻，中心突出，素材充实，思想健康；文体特征鲜明（议论文逻辑严谨 / 记叙文情思兼备），结构闭环清晰，语言流畅典雅
  · 二等 13–16：符合题意，中心明确，内容较充实；符合文体要求，结构完整，语言通顺
  · 三等 9–12 ：基本符合题意，中心基本明确，内容单薄；基本符合文体，结构基本完整，语言基本通顺
  · 四等 0–8 ：偏离题意，中心不明或立意不当；不符合文体要求，结构不完整，语言不通顺
- 发展等级 20 分（深刻 / 丰富 / 有文采 / 有创意），四点不求全，单项满分 5
  · 深刻 5 / 丰富 5 / 有文采 5 / 有创意 5；一点突出即可高分
  封顶规则（重要）：
    基础一 / 二等 ⇒ 发展分正常（最高 20）
    基础三等     ⇒ 发展封顶 10
    基础四等     ⇒ 发展封顶 6
- 硬性扣分（统一执行；扣完得 total）
  · 无标题 −2 分
  · 字数不足 800 字：每少 50 字 −1；600 字以下基础等级直接划入三等及以下；400 字以内最高不超 20 分
  · 错别字：每 3 个 −1（最多 −3）
- 档次总分对应区间（实操阅卷分档）
  · 一类文 54–60：内容一等 + 表达一等，发展 16–20
  · 二类文 42–53：内容二等 + 表达二等，发展 10–19
  · 三类文 30–41：基础三等；发展封顶 10
  · 四类文 ≤ 29 或严重跑题 / 字数严重不足：基础四等；发展封顶 6
`;

const SYSTEM_PROMPT = `你是一位资深高考语文阅卷老师。请严格按【评分标准】给学生的作文打分。必须只输出一个 JSON 对象，禁止任何前后缀解释或 Markdown 代码块。

【核心原则】
- 按"内容 20 + 表达 20"双维度给基础分（四等：17-20 / 13-16 / 9-12 / 0-8）；按"深刻 / 丰富 / 有文采 / 有创意"四项给发展分；发展分严格遵守基础等级封顶规则
- 改写必须具体到原文原句，禁止空泛建议
- 改写示范要"换上就能用"，避免"可考虑运用比喻"式空话
- 提分路径必须给出预期提分幅度（几分到几分），让学生有目标感

JSON 字段（必填，缺字段视为不合格）：
{
  "total": 数字 0-60,         // 含硬性扣分
  "basic": 数字 0-40,         // 内容 20 + 表达 20
  "basicReason": "基础等级的详细评分理由，120-200 字，要逐项对应内容（审题/立意/中心/素材/思想）和表达（文体/结构/语言/卷面）两档所属等次",
  "develop": 数字 0-20,       // 已应用基础等级封顶
  "developReason": "发展等级的详细评分理由，100-150 字，要逐项对应深刻/丰富/文采/创意，并点明封顶依据",
  "tier": "一类卷/二类卷/三类卷/四类卷",

  "summary": "一句话核心评价（30-60 字，给非专业读者看的）",
  "highlights": ["亮点1", "亮点2", "亮点3"],

  "dimension_scores": [
    {"name":"切合题意","score": 0-10,"reason":"该项具体评分理由"},
    {"name":"中心突出","score": 0-10,"reason":"..."},
    {"name":"内容充实","score": 0-10,"reason":"..."},
    {"name":"结构严谨","score": 0-10,"reason":"..."},
    {"name":"语言流畅","score": 0-10,"reason":"..."},
    {"name":"字数书写","score": 0-10,"reason":"..."},
    {"name":"深刻","score": 0-5,"reason":"..."},
    {"name":"丰富","score": 0-5,"reason":"..."},
    {"name":"文采","score": 0-5,"reason":"..."},
    {"name":"有创意","score": 0-5,"reason":"..."}
  ],

  "polish_examples": [
    {
      "original": "原文原句（必须能在学生作文里找到）",
      "issue": "这句的具体毛病（10-25 字）",
      "polished": "升格示范（30-80 字，用了什么手法在 technique 里说明）",
      "technique": "改写手法（如：动作细节+短句节奏 / 排比+比喻 / 引用+联想）",
      "gain": "换上这句大约能多拿多少分"
    }
    // 至少 3 条，按"提分性价比"从高到低排列
  ],

  "gain_plan": [
    {
      "step": 1,
      "task": "具体修改动作（如：在第三段加 1 个 2024 年时事论据，或把结尾改成排比+比喻双层收束）",
      "expected": "预期提分（写"+3~5 分"这种区间，注明对应维度）",
      "difficulty": "简单/中等/困难"
    }
    // 至少 4 条，按性价比从高到低
  ],

  "issues": [
    {"title":"问题小标题","body":"问题描述","gain":"如果修好可多得几分"}
  ],

  "suggestions": [
    "可操作短建议 1（要明确"做什么"，少用"应注意"）",
    "建议 2",
    "建议 3"
  ]
}`;

serve(async (req) => {
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

  let payload: { title?: string; content?: string; question?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResp({ error: "请求体不是合法 JSON" }, 400);
  }

  const title = (payload.title || "").trim();
  const content = (payload.content || "").trim();
  const question = (payload.question || "").trim();

  if (!content) {
    return jsonResp({ error: "缺少作文正文 content" }, 400);
  }

  const userText = `${RUBRIC}\n\n【特别要求】\n- polish_examples 必须从学生原文中引用原句（不是泛指），并给出可直接复用的升格版\n- gain_plan 按"性价比"排序：第一条必须是改起来最快、提分最明显的\n- 升格示范避免空话（"用更生动的语言"这种不算），必须有具体的修辞/句式/论据\n- 提分幅度基于 60 分卷的常见档位差给出（如"+2~3 分到一类卷底线"）\n- 发展等级严格遵守封顶：基础一/二等⇒最高 20；基础三等⇒封顶 10；基础四等⇒封顶 6\n- 硬性扣分：无标题 −2，每少 50 字 −1，错别字每 3 个 −1（最多 −3），扣完得 total\n\n【作文题目】\n${title || "（无题）"}\n\n【原题/要求】\n${question || "（未提供原题，按通用记叙文/议论文标准评）"}\n\n【学生作文】\n${content}\n\n请按 SYSTEM 字段定义输出 JSON。`;

  const body = {
    model: "qwen-max",
    input: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    },
    parameters: {
      temperature: 0.5,
      top_p: 0.85,
      result_format: "json",
    },
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
      text?: string;
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string };
      }>;
    };
    usage?: Record<string, number>;
  };
  try {
    data = JSON.parse(text);
  } catch {
    return jsonResp({ error: "DashScope 返回不是 JSON", detail: text.slice(0, 500) }, 502);
  }

  let rawResult = data?.output?.text || data?.output?.choices?.[0]?.message?.content || "";
  rawResult = rawResult.trim();

  if (!rawResult) {
    return jsonResp({ error: "评分模型无输出", raw: data }, 502);
  }

  // 大模型偶有不严格 JSON，尝试剥掉 ```json ... ``` 包裹
  const fenced = rawResult.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) rawResult = fenced[1].trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    // 容错：把 rawResult 当作总分与 summary 也行
    return jsonResp({
      total: 0,
      basic: 0,
      develop: 0,
      tier: "未评定",
      summary: rawResult.slice(0, 500),
      highlights: [],
      issues: ["评分模型未输出严格 JSON，已降级展示原文"],
      suggestions: [],
      _raw: true,
    });
  }

  const obj = parsed as Record<string, unknown>;
  return jsonResp({
    total: Number(obj.total) || 0,
    basic: Number(obj.basic) || 0,
    basicReason: String(obj.basicReason || ""),
    develop: Number(obj.develop) || 0,
    developReason: String(obj.developReason || ""),
    tier: String(obj.tier || "未评定"),
    summary: String(obj.summary || ""),
    highlights: Array.isArray(obj.highlights) ? obj.highlights : [],
    dimension_scores: Array.isArray(obj.dimension_scores) ? obj.dimension_scores : [],
    polish_examples: Array.isArray(obj.polish_examples) ? obj.polish_examples : [],
    gain_plan: Array.isArray(obj.gain_plan) ? obj.gain_plan : [],
    issues: Array.isArray(obj.issues) ? obj.issues : [],
    suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : [],
    usage: data.usage || {},
  });
});
