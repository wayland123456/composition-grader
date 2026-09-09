// Supabase Edge Function: score
// POST { title, content, question }
// 调用通义千问 qwen3-plus（DashScope 模型名 qwen-plus，等同 qwen-plus-2025-07-28）
// 按高考语文作文 60 分制评分，返回结构化 JSON。
// v2 (2026-09-07)：融合教育部 2025"八要和八不要" + 湖北阅卷组细则 + 完整评分标准，
//                  并加入 few-shot 升格教学（精选《55 分升格之旅》2 例）。
// v3 (2026-09-09)：评分模型从 qwen-max 切换到 qwen-plus（Qwen3 系列 Plus），
//                  单次成本约降低 25-30 倍，效果对高考语文作文够用。

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const DASHSCOPE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
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

// Few-shot 升格教学：精选《55 分升格之旅》2 个代表性案例。
// 让 AI 学到"问题定位→升格要点→升格示范"的具体思路，而非凭空写升格建议。
const FEW_SHOT = `
【升格教学 · 案例 1】（47→56，"成功"主题：技术·经验·勇气三原色）

【学生习作 47 分·节选】
"……在做事之前必定要掌握的是关于这件事情的相关技术。要想盖楼盖得高，地基必须打好……"
"……当你熟练地运用这项技术后，能够提高成功率的要素便是经验……"
"……这一点，但却是重中之重的一点：勇气。关于这点有以下这么一件事：一对哥们，其中一个是在武术训练班里待过的人，另外一个是当过兵刚退伍的人……"

【名师评语·核心问题】
① "技术、经验、勇气"三段并列罗列，缺乏内在关联逻辑，读起来像三个孤岛；
② 论据单薄：武术/当兵例子太日常，缺乏分量；
③ 语言啰嗦，结尾"中国梦的建设将会飞速发展，创造辉煌"空话收束；
④ 标题"成功的前提"过于直白，像分论点而非中心论点。

【升格要点】
· 改标题：从"成功的前提" → "成功三原色：技术、经验和勇气"（化用绘画术语，有画面感）
· 开头：用切割钻石的场景做引子，把三原色与材料绑定（"由'术'而'道'、触类旁通"）
· 中间三段：每段开头一句观点句 + 三个有力论据（鲁班/爱迪生/屠呦呦、资深老农/莫言、华为备胎计划）
· 段内句与句之间用"起承转合"逻辑勾连（"技术再重要，也只是门槛，……这时经验及其所代表的智慧很重要"）
· 删除凑字数的话，结尾一句话收束（"如果能多点这类人，'中国梦'必将加速实现！"）

【升格后 56 分·开头段】
"每个人在做任何事时，心里的目标往往只有一个：成功。急于求成、畏首畏尾往往都是成功的绊脚石，老切割师的过人之处和成功诀窍在于，他像一位绘画大师一样，娴熟地驾驭保障切割成功的三原色：'技术、经验和勇气'。由'术'而'道'、触类旁通，这切割工艺的三原色适用于更广泛的事业成功之路。"

——> 启示：升格的核心是「让原本并列的论点产生内在递进逻辑 + 用具体有力的论据替换日常举例 + 删除一切凑字数的话」。

---

【升格教学 · 案例 2】（44→57，"细节·流行语"主题：敢饮头啖汤 + 时间就是金钱）

【学生习作 44 分·节选】
"……'敢饮头啖汤'这句俗语……'敢'体现新时期青年的气魄和勇气，这不是'初生牛犊不怕虎'的莽撞的勇气，而是……"
"……深圳可谓改革开放时代的先锋模范城市。三十多年前，深圳仍是个毫不起眼的小渔村……"
"……'实践是检验真理的唯一标准'，改革开放的力量深入人心……"

【名师评语·核心问题】
① 第一段开头"改革开放四十周年已过去"与标题"流行语中见中国"关联弱（中国没体现），显得空泛；
② 论据堆砌（马云/深圳/邓小平）但缺乏"流行语"如何体现的核心论证；
③ 段落之间过渡生硬（"若说……那么……就是……"过于机械）；
④ 末段喊口号"不负青春韶华，更不负祖国"显得空洞。

【升格要点】
· 改开头：用"历史不必铭刻，但需要怀念。那一条条印着时代烙印的流行语，见证着改革开放四十年的伟大变迁。"—— 一句话把"流行语"和"中国变迁"绑定，立刻有历史纵深感；
· 论据紧扣"流行语"：每个论据都要点出"流行语背后的时代精神"（不是泛泛讲马云/深圳）；
· 段间过渡：用"敢闯敢试的勇气""务实的奋斗"等观点性短语代替机械句式；
· 末段用哲学家克罗齐"一切历史都是当代史"收束，提升思想厚度；
· 删除所有"为了凑字数"的描述性句子（如"已过去，新时代的中国青年仍需努力追梦"）。

【升格后 57 分·开头段】
"历史不必铭刻，但需要怀念。那一条条印着时代烙印的流行语，见证着改革开放四十年的伟大变迁。"

——> 启示：升格的核心是「让每个句子都回答问题或达到目的，不要'为了凑字数而写'」+「开头段就要有历史纵深感，让标题中的核心词落地」。
`;

const RUBRIC = `
【高考语文作文 60 分制评分标准（v2 · 2026-09-07 融合版）】
依据：教育部考试院 2025 命题指导意见 + 八要和八不要 + 湖北阅卷组评分细则 + 标杆作文评语维度。

【一、整体要求（教育部 2025）】
文风端正、文脉清晰、文气顺畅；思想积极向上，符合社会主义核心价值观；
内容切合题意，符合试题材料/情境/任务；观点明确、逻辑严密、结构严谨、论证充分、思考具独立性；
表达准确流畅，合理运用词语/句式/修辞。

【二、阅卷三大法则（教育部考试院）】—— 评阅大前提
① 是否有真情实感（不是套话、不是伪抒情）
② 是否有深入思考（不是材料简单复述、有思辨深度）
③ 是否有逻辑（论点→论据→论证闭环；句与句、段与段有勾连）

【三、八要和八不要（教育部考试院 · 强制阅卷导向）】
【要】逻辑清晰  【不要】逻辑混乱（论点与论据割裂、结构无层次）
【要】言之有物  【不要】空洞无物（喊口号、车轱辘话、无信息量）
【要】准确真诚  【不要】无病呻吟（缺感情或感情泛滥）
【要】事例契合  【不要】堆砌材料（罗列无关联的事例）
【要】灵活运用  【不要】生搬硬套（套万能结构、金句）
【要】风格和谐  【不要】风格杂糅（不土不洋、不文不白）
【要】文从字顺  【不要】语句不通（表意不明、成分残缺）
【要】自然得体  【不要】语言造作（堆砌生僻词、标题浮华）

【四、基础等级 40 分 = 内容 20 + 表达 20，按四等】
【内容项 20 分】审题 · 立意 · 中心 · 素材 · 思想
  一等 17–20：完全切合题意，立意深刻，中心突出，素材充实多元（个人+社会+时代），思想健康有思辨
  二等 13–16：符合题意，中心明确，内容较充实，时代关联单薄
  三等 9–12 ：基本符合题意，中心基本明确，内容单薄（仅一侧维度）
  四等 0–8 ：偏离题意，中心不明或立意不当，价值观偏差
【表达项 20 分】文体 · 结构 · 语言 · 卷面
  一等 17–20：文体特征鲜明（议论文逻辑严谨 / 记叙文情思兼备），结构闭环清晰（首尾呼应、过渡自然），语言流畅典雅
  二等 13–16：符合文体要求，结构完整，过渡平淡，语言通顺
  三等 9–12：基本符合文体，结构松散，语病较多
  四等 0–8：不符合文体要求，结构不完整，语言不通顺

【五、发展等级 20 分】深刻 · 丰富 · 有文采 · 有创意（四点不求全，单项满分 5）
  深刻 5：辩证反思、元认知、批判性（思维外显是核心得分点）
  丰富 5：素材多元（个人+社会+时代）/ 形象饱满
  有文采 5：用词有质感 / 句式长短错落 / 不堆砌
  有创意 5：构思独特 / 跳出模板 / 有个人体悟
【封顶规则】基础一/二等 ⇒ 发展最高 20；基础三等 ⇒ 封顶 10；基础四等 ⇒ 封顶 6

【六、硬性扣分（统一执行）】
  · 无标题 −2 分
  · 字数 < 800：每少 50 字 −1；600 字以下基础等级直接三等及以下；400 字以内最高 20 分
  · 错别字：每 1 字 −1（重复不计，最多 −5）；标点 3 处以上错误 −1（最多 −2）
  · 套作：基础降一等 + 发展减半；全盘抄袭 → 基础四等 + 发展 0 分
  · ⚠️ 泄露真实校名/姓名等个人信息：酌情 −3 ~ −5 分（参赛合规要求）

【七、湖北阅卷组细则（针对性导向）】
  · 议论文常见扣分：论点与论据割裂、结构混乱、"精神列举+事例堆砌"模式（无思辨深度）
  · 记叙文常见扣分：过度沉溺故事叙述、未提炼与材料呼应的精神主旨
  · 语言口语化、缺乏感染力 → 表达项压分
  · 立意偏差（如把"民族精神"窄化为"勇气""坚持"）→ 内容项压分
  · 时代关联单薄（只谈个人理想、未与民族命运关联）→ 发展项压分

【八、档位总分区间】
  一类文 54–60：内容一等 + 表达一等，发展 16–20
  二类文 42–53：内容二等 + 表达二等，发展 10–19
  三类文 30–41：基础三等；发展封顶 10
  四类文 ≤ 29 或严重跑题 / 字数严重不足：基础四等；发展封顶 6
`;

const SYSTEM_PROMPT = `你是一位资深高考语文阅卷老师（特级教师标准），严格按【评分标准】给学生的作文打分。必须只输出一个 JSON 对象，禁止任何前后缀解释或 Markdown 代码块。

【核心原则】
- 按"内容 20 + 表达 20"双维度给基础分（四等：17-20 / 13-16 / 9-12 / 0-8）；按"深刻 / 丰富 / 有文采 / 有创意"四项给发展分；发展分严格遵守基础等级封顶规则
- 阅卷前先过【阅卷三大法则】：真情、思考、逻辑；缺一不可
- 阅卷时对照【八要和八不要】，任何一条触发"不要"则对应维度压分
- 改写必须具体到原文原句，禁止空泛建议
- 改写示范要"换上就能用"，避免"可考虑运用比喻"式空话
- 提分路径必须给出预期提分幅度（几分到几分），让学生有目标感

【升格方法论】（必读，影响 polish_examples 与 gain_plan 质量）
你必须按以下思路生成升格建议，不要凭空写"语言要生动""结构要清晰"这种空话：
1. **定位问题**：先找出原文最致命的 1-3 个问题（论点脱节 / 论据堆砌 / 套话收束 / 标题不扣题 / 段间过渡生硬等）
2. **升格要点**：对每个问题给出具体改法（改标题 / 改开头 / 加论据 / 删凑字数的话 / 改收束方式）
3. **示范改写**：从原文里引用原句，给出"换上就能用"的升格版（30-80 字），并说明用了什么手法（排比+比喻 / 动作细节+短句节奏 / 引用+联想 / 克式收束等）
4. **提分幅度**：每条示范预估 +几分（基于 60 分卷的常见档位差）

【Few-shot 升格教学】见下方 FEW_SHOT 段（精选《55 分升格之旅》2 个代表性案例）。请学习其"问题定位→升格要点→示范改写→启示"链条，不要凭空写升格建议。

【输出 JSON 字段】（必填，缺字段视为不合格）
{
  "total": 数字 0-60,         // 含硬性扣分
  "basic": 数字 0-40,         // 内容 20 + 表达 20
  "basicReason": "基础等级的详细评分理由，120-200 字，要逐项对应内容（审题/立意/中心/素材/思想）和表达（文体/结构/语言/卷面）两档所属等次；点明对照'八要和八不要'中触发的'不要'条款",
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
      "issue": "这句的具体毛病（10-25 字，对照'八要和八不要'定位）",
      "polished": "升格示范（30-80 字，用了什么手法在 technique 里说明）",
      "technique": "改写手法（如：动作细节+短句节奏 / 排比+比喻 / 引用+联想 / 克式收束）",
      "gain": "换上这句大约能多拿多少分"
    }
    // 至少 3 条，按"提分性价比"从高到低排列
  ],

  "gain_plan": [
    {
      "step": 1,
      "task": "具体修改动作（如：在第三段加 1 个 2024 年时事论据，或把结尾改成排比+比喻双层收束）",
      "expected": "预期提分（写'+3~5 分'这种区间，注明对应维度）",
      "difficulty": "简单/中等/困难"
    }
    // 至少 4 条，按性价比从高到低
  ],

  "issues": [
    {"title":"问题小标题","body":"问题描述（含具体例证）","gain":"如果修好可多得几分"}
    // 至少 3 条
  ],

  "suggestions": [
    "可操作短建议 1（要明确'做什么'，少用'应注意'）",
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

  const userText = `${RUBRIC}\n\n${FEW_SHOT}\n\n【特别要求】\n- 阅卷前先过【阅卷三大法则】（真情、思考、逻辑）和【八要和八不要】，触发的"不要"条款要在 basicReason 里点明\n- polish_examples 必须从学生原文中引用原句（不是泛指），并给出可直接复用的升格版（30-80 字），按【升格方法论】的"定位问题→升格要点→示范改写→提分"四步走\n- gain_plan 按"性价比"排序：第一条必须是改起来最快、提分最明显的；至少 4 条\n- 升格示范避免空话（"用更生动的语言"这种不算），必须有具体的修辞/句式/论据，并填 technique 字段\n- 提分幅度基于 60 分卷的常见档位差给出（如"+2~3 分到一类卷底线"）\n- 发展等级严格遵守封顶：基础一/二等⇒最高 20；基础三等⇒封顶 10；基础四等⇒封顶 6\n- 硬性扣分：无标题 −2，每少 50 字 −1，错别字每 1 字 −1（最多 −5），扣完得 total\n- ⚠️ 若学生作文出现真实校名/姓名等个人信息，必须在 issues 中点出并扣 3-5 分\n\n【作文题目】\n${title || "（无题）"}\n\n【原题/要求】\n${question || "（未提供原题，按通用记叙文/议论文标准评）"}\n\n【学生作文】\n${content}\n\n请按 SYSTEM 字段定义输出 JSON。`;

  const body = {
    model: "qwen-plus",  // 即 Qwen3-Plus，输入 0.8 元/百万tokens，输出 2 元/百万tokens（华北2）
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    temperature: 0.5,
    top_p: 0.85,
    response_format: { type: "json_object" },
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
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string };
    }>;
    usage?: Record<string, number>;
  };
  try {
    data = JSON.parse(text);
  } catch {
    return jsonResp({ error: "DashScope 返回不是 JSON", detail: text.slice(0, 500) }, 502);
  }

  let rawResult = data?.choices?.[0]?.message?.content || "";
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
