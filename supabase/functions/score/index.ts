// Supabase Edge Function: score
// POST { title, content, question }
// 调用通义千问 qwen-max 按高考英语/语文作文 60 分制评分，返回结构化 JSON。

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
【评分标准：高考作文 60 分制（一类卷~六类卷）】
- 基础等级 40 分（内容 20 + 表达 20）
  · 一类(40-36)：切合题意、中心突出、内容充实、感情真挚、结构严谨、语言流畅、用语得体、书写工整
  · 二类(35-31)：符合题意、中心明确、内容较充实、感情真实、结构完整、语言通顺、书写规范
  · 三类(30-26)：基本符合题意、中心基本明确、内容尚充实、感情基本真实、结构基本完整、语言基本通顺
  · 四类(25-21)：偏离题意、中心不明确、内容空泛、感情虚假、结构不完整、语病较多
  · 五类(20-16)：不切题意、中心混乱、内容空洞、感情失真、结构混乱、语病严重
  · 六类(15-0)：文不对题、不知所云
- 发展等级 20 分（深刻 / 丰富 / 有文采 / 有创意 四个特征，满足即可得分；最多 20 分）
  · 深刻(8-5)：透过现象深入本质、揭示内在因果关系、观点具有启发性
  · 丰富(8-5)：材料丰富、形象丰满、意境深远
  · 有文采(8-5)：词语生动、句式灵活、文句有意蕴
  · 有创意(8-5)：见解新颖、材料新鲜、构思新巧
  · 任一项突出给该区间分；多项俱佳最多 20；全部平庸 0
- 总分 = 基础分 + 发展分，最高 60
- 评分档判定：
  · 54-60 = 一类卷
  · 48-53 = 二类上
  · 42-47 = 二类下
  · 36-41 = 三类上
  · 30-35 = 三类下
  · 24-29 = 四类
  · 18-23 = 五类
  · 0-17  = 六类
`;

const SYSTEM_PROMPT = `你是一位资深高考语文阅卷老师。请严格按【评分标准】给学生的作文打分。必须只输出一个 JSON 对象，禁止任何前后缀解释或 Markdown 代码块。

【核心原则】
- 改写必须具体到原文原句，禁止空泛建议
- 改写示范要"换上就能用"，避免"可考虑运用比喻"式空话
- 提分路径必须给出预期提分幅度（几分到几分），让学生有目标感

JSON 字段（必填，缺字段视为不合格）：
{
  "total": 数字 0-60,
  "basic": 数字 0-40,
  "basicReason": "基础等级的详细评分理由，120-200 字，要逐项对应切题/中心/内容/结构/语言/字数六维",
  "develop": 数字 0-20,
  "developReason": "发展等级的详细评分理由，100-150 字，要逐项对应深刻/丰富/文采/创意",
  "tier": "一类卷/二类上/二类下/三类上/三类下/四类/五类/六类",

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

  const userText = `${RUBRIC}\n\n【特别要求】\n- polish_examples 必须从学生原文中引用原句（不是泛指），并给出可直接复用的升格版\n- gain_plan 按"性价比"排序：第一条必须是改起来最快、提分最明显的\n- 升格示范避免空话（"用更生动的语言"这种不算），必须有具体的修辞/句式/论据\n- 提分幅度基于 60 分卷的常见档位差给出（如"+2~3 分到一类卷底线"）\n\n【作文题目】\n${title || "（无题）"}\n\n【原题/要求】\n${question || "（未提供原题，按通用记叙文/议论文标准评）"}\n\n【学生作文】\n${content}\n\n请按 SYSTEM 字段定义输出 JSON。`;

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
