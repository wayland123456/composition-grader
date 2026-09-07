/* ====================================================================
 * 语文作文智能批改平台 · 教师端 · 业务脚本
 * --------------------------------------------------------------------
 * 当前为 Mock 模式。等接入讯飞 API 时，只需把：
 *   - ocrRecognize()   内替换成真实接口调用
 *   - scoreEssay()     内替换成真实接口调用
 *   - settingsModal    中的凭据生效
 * ==================================================================== */

const $ = (id) => document.getElementById(id);

/* ====================================================================
 * 全局状态
 * ==================================================================== */
const state = {
  step: 0,  // 0 = 落地页（入口选择） / 1-3 = 批改流程
  images: { question: [], essay: [] },   // [{ id, dataUrl, name }]
  ocr: { question: '', essay: '', confirmed: false },
  edits: { question: '', essay: '' },
  score: null,            // { total, basic, basicReason, develop, developReason, tier, suggestions }
  meta: { school: '', student: '', title: '', createdAt: null },
  config: {
    dashKey: '',                                       // 本地直连备用（留空则不出现在前端）
    ocrModel: 'qwen-vl-ocr',
    scoreModel: 'qwen-max',
    cozeUrl: 'https://www.coze.cn/space/7681245914807828522/bot/7681303617945075747',
    edgeUrl: 'https://gqlwspxcyhjtzhikcexj.supabase.co/functions/v1',
    edgeAnonKey: 'sb_publishable_PqN5m9yOrWZzBazFjO7Y_w_pfIMO1PI', // 英语网站项目 publishable key（公开可放前端）
    edgeVerified: false,                               // 启动时 ping 函数验通
    mode: 'edge'                                       // 复用英语网站 Supabase 项目的 Edge Functions
  }
};

/* ====================================================================
 * 步骤导航
 * ==================================================================== */
function goStep(n) {
  state.step = n;
  // 落地页时隐藏步骤指示器
  $('steps').classList.toggle('hidden-on-landing', n === 0);
  document.querySelectorAll('.step').forEach((s) => {
    const idx = +s.dataset.step;
    s.classList.toggle('active', idx === n);
    s.classList.toggle('done', idx < n && idx > 0);
  });
  document.querySelectorAll('.step-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${n}`);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ====================================================================
 * 图片上传：拖拽 + 点击
 * ==================================================================== */
function setupDropzone(type) {
  const dz = $(`dropzone${type === 'question' ? 'Question' : 'Essay'}`);
  const input = $(`file${type === 'question' ? 'Question' : 'Essay'}`);
  const thumbs = $(`thumbs${type === 'question' ? 'Question' : 'Essay'}`);
  const counter = $(`${type}Count`);

  const addFiles = (files) => {
    Array.from(files).forEach((file, i) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const id = `${type}-${Date.now()}-${i}`;
        state.images[type].push({ id, dataUrl: e.target.result, name: file.name });
        renderThumbs(type);
        refreshGoStep2();
      };
      reader.readAsDataURL(file);
    });
  };

  dz.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); })
  );
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
}

function renderThumbs(type) {
  const thumbs = $(`thumbs${type === 'question' ? 'Question' : 'Essay'}`);
  const counter = $(`${type}Count`);
  const arr = state.images[type];
  counter.textContent = `${arr.length} 张`;
  thumbs.innerHTML = arr.map((img, i) => `
    <div class="thumb">
      <img src="${img.dataUrl}" alt="">
      <span class="idx">#${i + 1}</span>
      <button class="remove" data-id="${img.id}" data-type="${type}">✕</button>
    </div>
  `).join('');
  thumbs.querySelectorAll('.remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const t = btn.dataset.type;
      state.images[t] = state.images[t].filter((x) => x.id !== id);
      renderThumbs(t);
      refreshGoStep2();
    });
  });
}

function refreshGoStep2() {
  // 只要有作文图片即可进入下一步
  $('btnGoStep2').disabled = state.images.essay.length === 0;
}

/* ====================================================================
 * 载入示例数据（演示用）
 * ==================================================================== */
function loadDemo() {
  state.images.question = [];
  state.images.essay = [];
  renderThumbs('question');
  renderThumbs('essay');
  $('essayTitle').value = '《"失意"是磨砺，"诗意"是超越》';
  $('studentName').value = '';

  // 题目
  state.ocr.question = '阅读下面的材料，根据要求写作。\n\n"金南金北皆春水，但见群鸥日日来"是颠沛流离的杜甫；"莫听穿林打叶声，何妨吟啸且徐行"是被贬黄州的苏轼；"亦余心之所善兮，虽九死其犹未悔"是官场失意的屈原…… 中华上下五千年历史，千古名诗更是层出不穷，其中又有多少带有"失意"的诗篇，有多少人历经困境用"诗意"超越自我，完成对自我的历练呢？自然是数不胜数。\n\n请结合材料内容，写一篇文章，体现你的感悟与认识。要求：选准角度，确定立意，明确文体，自拟标题；不要套作，不得抄袭；不得泄露个人信息；不少于 800 字。';

  // 作文正文（用浪浪给的示例）
  state.ocr.essay = '"金南金北皆春水，但见群鸥日日来"是颠沛流离的杜甫；"莫听穿林打叶声，何妨吟啸且徐行"是被贬黄州的苏轼；"亦余心之所善兮，虽九死其犹未悔"是官场失意的屈原…… 中华上下五千年历史，千古名诗更是层出不穷，其中又有多少带有"失意"的诗篇，有多少人历经困境用"诗意"超越自我，完成对自我的历练呢？自然是数不胜数。\n\n可曾听过一句话："苦难是文学的沃土。" 而文学是精神的超越。人生往往都有困难的时刻，也可以说"失意"是人生的常态，但重要的是如何在"失意"中寻求"诗意"，如何在困境中寻得突破，超越自我，认可自我人生价值。\n\n在失意中寻觅诗意，在迷惘中完成对自我灵魂的升华。外卖诗人王计兵，就算生活艰苦也未曾放弃对诗歌的追求，用质朴的诗句触及人心，用不曾被生活所麻痹的灵魂抒发对诗歌赤诚的热爱。虽然别无长物，却拥有一颗饱满丰富的灵魂，正是由"失"转"诗"的完美诠释。可见就算人生穷困、失意常常，我们也要在困境中怀抱对美好的热爱，用强大的精神力走出困境，以饱满充实的灵魂应对人生每一次的失意。\n\n调整个人心态，在失意中获得对生命的感悟。同样是秋日，晏殊看到的是"高楼目尽欲黄昏，梧桐叶上萧萧雨"的凄清，而刘禹锡所见却是"晴空一鹤排云上，便引诗情到碧霄"的爽朗。可见，个人心境不同，所见所感亦有天差地别。有人在下雨天埋怨沾湿衣裤的雨水，也有人在下雨天感受雨声带来的宁静，当我们失意时，比起沉浸在一时失意的痛苦印象之中，用超越功利的淡然之心，将其转化为"诗意"的观念，能给予我们更多对生命的感悟，用平静的心品位生活的苦，兴许也能尝出一丝甜头，而这甜头正能支撑我们走出失意，品出生活诗意的滋味。\n\n将个人命运融入时代洪流，以家国情怀超越个人失意。红日初升，其道大光，杜工部与苏东坡吟诵失意之悲歌，林则徐与孟晚舟面临命运之威胁，可见诗意之花的重量。而吾辈之青年应担翻涌澎湃之重任，集今人之智，仿古人之长，直面人生的失意，持"武能上马安天下，文能提笔定乾坤"之信念，举青年之力，投身于国家事业，贡献自己的诗意之花。';

  // 把示例直接放进「识别结果」textarea 里，让用户能进入下一步
  alert('已载入示例作文「"失意"是磨砺，"诗意"是超越」。\n点击「下一步」可跳过 OCR 直接进入编辑评分。');
  state.ocr.confirmed = true;
  $('ocrQuestion').value = state.ocr.question;
  $('ocrEssay').value = state.ocr.essay;
  refreshGoStep2();
  goStep(2);
}

/* ====================================================================
 * 通义千问 DashScope HTTP 调用（纯 HTTPS，国内直连，无需 WebSocket）
 * ====================================================================
 * 识别：qwen-vl-ocr（手写识别），评分：qwen-max / qwen-plus。
 * 走阿里云百炼兼容 OpenAI 格式 REST 接口。
 * -------------------------------------------------------------------- */
const DASH_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// 鉴权头：DashScope 用 Bearer token，与讯飞三件套完全不同
function dashAuth() {
  const key = state.config.dashKey;
  if (!key) throw new Error('请先在【设置】里填入通义千问 API Key（sk- 开头）');
  return { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
}

/* ====================================================================
 * Supabase Edge Function 代理调用（部署后默认走这条）
 * 不暴露 DashScope Key，前端只带 anon key（公开 key，无风险）
 * ==================================================================== */
function edgeBase() {
  const url = (state.config.edgeUrl || '').replace(/\/+$/, '');
  if (!url) throw new Error('请先在【设置】里填写 Supabase Function 地址，例如 https://xxxx.supabase.co/functions/v1');
  return url;
}
function edgeAuth() {
  const k = state.config.edgeAnonKey;
  if (!k) throw new Error('请先在【设置】里填写 Supabase publishable key（sb_publishable_ 开头）');
  // ⚠️ 新版 publishable key 不是 JWT，只能放 apikey 头；绝不能放 Authorization: Bearer
  //（平台会把 Bearer 里的 sb_... 当 JWT 解析 → Invalid JWT）。函数需设 verify_jwt=false。
  return { 'apikey': k, 'Content-Type': 'application/json' };
}

async function edgeOcr(dataUrl) {
  const resp = await fetch(edgeBase() + '/ocr', {
    method: 'POST',
    headers: edgeAuth(),
    body: JSON.stringify({ image: dataUrl })
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Edge OCR ' + resp.status + '：' + (json.error || JSON.stringify(json).slice(0, 200)));
  if (!json.text) throw new Error('OCR 未识别出文字：' + JSON.stringify(json).slice(0, 200));
  return json.text;
}

async function edgeScore(title, content, question) {
  const resp = await fetch(edgeBase() + '/score', {
    method: 'POST',
    headers: edgeAuth(),
    body: JSON.stringify({ title, content, question })
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('Edge Score ' + resp.status + '：' + (json.error || JSON.stringify(json).slice(0, 200)));

  // 把后端返回的新版 JSON 对齐到前端渲染字段
  // 后端字段（新版）: total, basic, basicReason, develop, developReason, tier,
  //                   summary, highlights, dimension_scores, polish_examples,
  //                   gain_plan, issues, suggestions
  // 兼容老格式（issues/suggestions 是字符串数组时）
  const normIssues = (json.issues || []).map((it) => {
    if (typeof it === 'string') return { title: '问题', body: it, gain: '' };
    return { title: it.title || '问题', body: it.body || '', gain: it.gain || '' };
  });
  const normSuggestions = (json.suggestions || []).map((s) => {
    if (typeof s === 'string') return { title: '建议', body: s, aiFix: '' };
    return { title: s.title || '建议', body: s.body || s || '', aiFix: s.aiFix || '' };
  });
  return {
    total: json.total || 0,
    basic: json.basic || 0,
    basicReason: json.basicReason || json.summary || '',
    develop: json.develop || 0,
    developReason: json.developReason || '',
    tier: json.tier || '未评定',
    summary: json.summary || '',
    highlights: json.highlights || [],
    dimensionScores: json.dimension_scores || [],
    polishExamples: json.polish_examples || [],
    gainPlan: json.gain_plan || [],
    issues: normIssues,
    suggestions: normSuggestions
  };
}

async function edgeTest() {
  // 用 OCR 函数发一张 1x1 透明 PNG，看返回
  const tinyPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const resp = await fetch(edgeBase() + '/ocr', {
    method: 'POST',
    headers: edgeAuth(),
    body: JSON.stringify({ image: tinyPng })
  });
  const text = await resp.text();
  return resp.ok
    ? '✅ Edge Function 连接成功（HTTP ' + resp.status + '）'
    : '❌ Edge Function 异常（HTTP ' + resp.status + '）：' + text.slice(0, 200);
}

// 单图识别：qwen-vl-ocr 直接读图回文字
async function dashOcr(dataUrl) {
  const model = state.config.ocrModel || 'qwen-vl-ocr';
  const body = {
    model: model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: '请识别这张图片中的全部文字（含手写中文），保持原文顺序和段落换行。图片如果是作文就输出作文正文，如果是试题就输出题目。只输出文字本身，不要任何解释或前缀。' }
      ]
    }],
    max_tokens: 3000
  };
  const resp = await fetch(DASH_URL, {
    method: 'POST', headers: dashAuth(), body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.error) throw new Error('OCR 接口错误：' + (json.error.message || JSON.stringify(json.error)));
  const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  return String(text).trim();
}

// 评分：qwen-max 按高考 60 分标准出 JSON
async function dashScore(title, content) {
  const model = state.config.scoreModel || 'qwen-max';
  const prompt = SCORE_PROMPT.replace('{TITLE}', title || '（未提供题目）').replace('{CONTENT}', content);
  const body = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 4096
  };
  const resp = await fetch(DASH_URL, {
    method: 'POST', headers: dashAuth(), body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.error) throw new Error('评分接口错误：' + (json.error.message || JSON.stringify(json.error)));
  let text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  text = String(text).replace(/```json|```/g, '').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('评分 JSON 解析失败，原文: ' + text.slice(0, 300));
  return JSON.parse(text.slice(start, end + 1));
}

// 一键自检：验证 Key 是否有效（用 qwen-turbo 最快）
async function dashTest() {
  const body = {
    model: 'qwen-turbo',
    messages: [{ role: 'user', content: '只回复两个字：正常' }],
    max_tokens: 10
  };
  const resp = await fetch(DASH_URL, {
    method: 'POST', headers: dashAuth(), body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.error) throw new Error('Key 无效：' + (json.error.message || JSON.stringify(json.error)));
  const t = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  return '✅ 通义千问连接成功，模型返回：' + String(t).trim();
}

/* ====================================================================
 * OCR 识别：mock / live（直连 DashScope）/ edge（Supabase Function 代理）
 * ==================================================================== */
async function ocrRecognize(type) {
  const imgs = state.images[type];
  if (imgs.length === 0) return '';

  const mode = state.config.mode;

  if (mode === 'mock') {
    await new Promise((r) => setTimeout(r, 1500));
    if (type === 'essay') return state.ocr.essay || '';
    if (type === 'question') return state.ocr.question || '';
    return '';
  }

  if (mode === 'edge') {
    let allText = '';
    for (const img of imgs) {
      allText += (await edgeOcr(img.dataUrl)) + '\n';
    }
    return allText.trim();
  }

  if (mode === 'live') {
    // 真实通义千问 OCR：每张图独立调用，结果拼接
    let allText = '';
    for (const img of imgs) {
      allText += (await dashOcr(img.dataUrl)) + '\n';
    }
    return allText.trim();
  }

  return '';
}

/* ====================================================================
 * 评分（Mock + 接口预留）
 * ====================================================================
 * Prompt 已按教育部高考语文作文评分标准（参照桌面「高考语文评分标准.docx」、
 * 分四等精细化给分）写好，接入真实星火时把这段 prompt 直接发过去即可。
 * -------------------------------------------------------------------- */
const SCORE_PROMPT = `你是一位资深高考语文阅卷老师（特级教师标准）。请严格按 2025 教育部高考语文作文 60 分制评分（基础 40 + 发展 20），融合"八要和八不要"+湖北阅卷组细则。只输出一个 JSON 对象，禁止任何前后缀解释。

【阅卷三大法则】真情·思考·逻辑 — 缺一不可
【八要和八不要】逻辑清晰/言之有物/准确真诚/事例契合/灵活运用/风格和谐/文从字顺/自然得体；任何"不要"条款触发则对应维度压分

【评分维度】（与 Edge Function 一致）
一、基础等级 40 分 = 内容 20 + 表达 20
  内容项（审题/立意/中心/素材/思想）：一等 17-20 | 二等 13-16 | 三等 9-12 | 四等 0-8
  表达项（文体/结构/语言/卷面）：一等 17-20 | 二等 13-16 | 三等 9-12 | 四等 0-8

二、发展等级 20 分（深刻/丰富/有文采/有创意，单项满分 5）
  封顶：基础一二等⇒最高 20；三等⇒封顶 10；四等⇒封顶 6

三、硬性扣分
  无标题 −2 | 字数不足 800：每少 50 字 −1；600 字以下基础三等及以下；400 字以内最高 20 分
  错别字每 1 字 −1（最多 −5）；标点 3 处错误以上 −1（最多 −2）
  套作：基础降一等+发展减半；全盘抄袭⇒基础四等+发展 0
  ⚠️ 泄露真实校名/姓名：酌情 −3 ~ −5 分

【升格方法论】（必读）
1. 定位问题：从原文找最致命的 1-3 个问题（论点脱节/论据堆砌/套话收束/标题不扣题/段间过渡生硬）
2. 升格要点：对每个问题给出具体改法（改标题/改开头/加论据/删凑字数的话/改收束方式）
3. 示范改写：从原文引用原句，给"换上就能用"的升格版（30-80 字），填 technique 说明手法
4. 提分幅度：每条示范预估 +几分（基于 60 分卷常见档位差）

【输出 JSON】（必填）
{
  "total": <总分 0-60，含硬性扣分>,
  "basic": <基础 0-40>,
  "basicReason": "<120-200 字，逐项对应内容/表达两档，对照'八要和八不要'点明触发的'不要'条款>",
  "develop": <发展 0-20，已封顶>,
  "developReason": "<100-150 字，逐项对应深刻/丰富/文采/创意，点明封顶依据>",
  "tier": "<一类卷/二类卷/三类卷/四类卷>",
  "summary": "<一句话 30-60 字>",
  "highlights": ["亮点1","亮点2","亮点3"],
  "dimension_scores": [
    {"name":"切合题意","score":0-10,"reason":"..."},
    {"name":"中心突出","score":0-10,"reason":"..."},
    {"name":"内容充实","score":0-10,"reason":"..."},
    {"name":"结构严谨","score":0-10,"reason":"..."},
    {"name":"语言流畅","score":0-10,"reason":"..."},
    {"name":"字数书写","score":0-10,"reason":"..."},
    {"name":"深刻","score":0-5,"reason":"..."},
    {"name":"丰富","score":0-5,"reason":"..."},
    {"name":"文采","score":0-5,"reason":"..."},
    {"name":"有创意","score":0-5,"reason":"..."}
  ],
  "polish_examples": [
    {"original":"原文原句","issue":"具体毛病 10-25 字","polished":"升格示范 30-80 字","technique":"改写手法","gain":"换上多拿几分"}
  ],
  "gain_plan": [
    {"step":1,"task":"具体修改动作","expected":"+3~5 分（注明维度）","difficulty":"简单/中等/困难"}
  ],
  "issues": [
    {"title":"问题标题","body":"问题描述","gain":"修好可多得几分"}
  ],
  "suggestions": ["可操作建议1","建议2","建议3"]
}

## 题目 / 材料
{TITLE}

## 作文正文
{CONTENT}`;

/* ====================================================================
 * 评分：mock / live / edge
 * ==================================================================== */
async function scoreEssay(title, content, question) {
  const mode = state.config.mode;

  if (mode === 'mock') {
    await new Promise((r) => setTimeout(r, 1500));
    return MOCK_SCORE;
  }

  if (mode === 'edge') {
    return await edgeScore(title, content, question);
  }

  if (mode === 'live') {
    return await dashScore(title, content);
  }

  return MOCK_SCORE;
}

const MOCK_SCORE = {
  total: 48,
  basic: 35,
  basicReason: '切合题意，核心论点明确且贯穿全文，符合议论文文体要求，采用递进式结构逻辑清晰，古今素材搭配充实，语言流畅字迹工整，仅有个别错别字和细节疏漏，属于基础等级一类卷。',
  develop: 13,
  developReason: '古诗文引用自然有文采，能够关联个人价值与时代青年担当，有初步的思辨意识，但辩证深度不足、部分素材和观点的衔接稍显空泛，属于发展等级二类卷。',
  tier: '二类卷',
  suggestions: [
    { title: '补全论据"搭桥分析"', body: '现有素材多为"人物 + 品质"的罗列。', aiFix: '示例：...' }
  ]
};

/* ====================================================================
 * 报告渲染
 * ==================================================================== */
function renderReport(score, meta, essayText, essayTitle) {
  const root = $('reportCard');
  const cfgs = [
    { name: '基础等级', cls: 'basic', points: score.basic, total: 40, reason: score.basicReason },
    { name: '发展等级', cls: 'develop', points: score.develop, total: 20, reason: score.developReason }
  ];

  // ============== 细评横条（仅 edge 模式有新字段） ==============
  const dimHtml = (score.dimensionScores && score.dimensionScores.length)
    ? `
      <div class="report-section">
        <h4>🎯 十维细评（按 60 分总分定位你的失分点）</h4>
        <div class="dim-grid">
          ${score.dimensionScores.map((d) => {
            const pct = Math.round((Number(d.score || 0) / Number(d.max || 10)) * 100);
            const isLow = pct < 60;
            return `
              <div class="dim-row ${isLow ? 'dim-low' : ''}">
                <div class="dim-name">${escapeHtml(d.name)}</div>
                <div class="dim-bar"><div class="dim-fill" style="width:${pct}%"></div></div>
                <div class="dim-pts">${d.score}<span class="dim-max">/${d.max}</span></div>
              </div>
              ${d.reason ? `<div class="dim-reason">${escapeHtml(d.reason)}</div>` : ''}
            `;
          }).join('')}
        </div>
      </div>
    `
    : '';

  // ============== 升格示范（最实用 ★） ==============
  const polishHtml = (score.polishExamples && score.polishExamples.length)
    ? `
      <div class="report-section">
        <h4>✍ 原文升格示范（复制粘贴即可用）</h4>
        <p class="hint" style="margin-bottom:14px;">从你的原文中挑出最值得改的句子，按下面的示范对照修改。<b style="color:var(--accent);">${score.polishExamples.length}</b> 处范例，改完预计提分 <b style="color:var(--accent);">+${score.polishExamples.reduce((s, p) => s + (Number(String(p.gain || '').match(/\d+/)?.[0]) || 0), 0)} 分</b>。</p>
        <div class="polish-list">
          ${score.polishExamples.map((p, idx) => `
            <div class="polish-card">
              <div class="polish-head">
                <span class="polish-num">改写 ${idx + 1}</span>
                ${p.gain ? `<span class="polish-gain">💰 ${escapeHtml(p.gain)}</span>` : ''}
              </div>
              <div class="polish-original">
                <span class="po-label">原文</span>
                <div class="po-text">${escapeHtml(p.original)}</div>
              </div>
              <div class="polish-issue">
                ⚠ <b>问题</b>：${escapeHtml(p.issue || '—')}
              </div>
              <div class="polish-fixed">
                <span class="po-label po-label-fix">升格</span>
                <div class="po-text po-text-fix">${escapeHtml(p.polished)}</div>
              </div>
              ${p.technique ? `<div class="polish-tech">🔧 <b>改写手法</b>：${escapeHtml(p.technique)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `
    : '';

  // ============== 提分路径（要顶替之前的"修改升格建议"位置） ==============
  const planHtml = (score.gainPlan && score.gainPlan.length)
    ? `
      <div class="report-section">
        <h4>🚀 你的提分路径（按性价比从高到低）</h4>
        <p class="hint">挑 1-2 个简单的先改，能立刻见效。</p>
        <div class="gain-plan">
          ${score.gainPlan.map((g) => `
            <div class="gain-step">
              <div class="gain-step-num">STEP ${g.step}</div>
              <div class="gain-step-body">
                <div class="gain-task">${escapeHtml(g.task)}</div>
                <div class="gain-meta">
                  ${g.expected ? `<span class="gain-expected">📈 ${escapeHtml(g.expected)}</span>` : ''}
                  ${g.difficulty ? `<span class="gain-difficulty gain-difficulty-${escapeHtml(g.difficulty)}">难度：${escapeHtml(g.difficulty)}</span>` : ''}
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `
    : '';

  // ============== 主要问题（带 gain） ==============
  const issuesHtml = (score.issues && score.issues.length)
    ? `
      <div class="report-section">
        <h4>🔍 主要问题诊断</h4>
        <div class="suggestion-list">
          ${score.issues.map((it) => `
            <div class="suggestion-item">
              <div class="si-head">
                <div class="si-title">⚠ ${escapeHtml(it.title)}</div>
                ${it.gain ? `<span class="si-tag">${escapeHtml(it.gain)}</span>` : ''}
              </div>
              <div class="si-body">${escapeHtml(it.body)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `
    : '';

  // ============== 一句话核心评价 + 亮点 ==============
  const summaryHtml = (score.summary || (score.highlights && score.highlights.length))
    ? `
      <div class="report-section">
        <h4>📌 一句话评价与亮点</h4>
        ${score.summary ? `<div class="summary-quote">${escapeHtml(score.summary)}</div>` : ''}
        ${score.highlights && score.highlights.length ? `
          <div class="highlights">
            ${score.highlights.map((h) => `<span class="highlight-tag">✨ ${escapeHtml(h)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `
    : '';

  root.innerHTML = `
    <div class="report-head">
      <h3>语文作文批改报告</h3>
      <div class="report-meta">
        <span>🏫 学校：<b>${escapeHtml(meta.school || '—')}</b></span>
        <span>👤 学生：<b>${escapeHtml(meta.student || '—')}</b></span>
        <span>📅 批改时间：<b>${formatDate(meta.createdAt)}</b></span>
      </div>
    </div>

    <div class="score-overview">
      <div class="score-big">
        <div class="total">${score.total}<small>/60</small></div>
        <div class="tier">${escapeHtml(score.tier)}</div>
      </div>
      <div class="score-breakdown">
        ${cfgs.map((c) => `
          <div class="score-row ${c.cls}">
            <div>
              <div class="name">${c.name}</div>
              <div class="reason">${escapeHtml(c.reason)}</div>
            </div>
            <div class="points">${c.points}<span style="font-size:13px;color:var(--text-3);">/${c.total}</span></div>
          </div>
        `).join('')}
      </div>
    </div>

    ${summaryHtml}
    ${dimHtml}
    ${polishHtml}
    ${planHtml}
    ${issuesHtml}

    <div class="report-section">
      <h4>📝 题目</h4>
      <div class="essay-title">${escapeHtml(essayTitle || meta.title || '未提供标题')}</div>
    </div>

    <div class="report-section">
      <h4>📄 修正识别误差后的作文文本</h4>
      <div class="essay-text">${escapeHtml(essayText)}</div>
    </div>

    <div class="report-section" style="text-align:center;font-size:12px;color:var(--text-3);background:#fafbfd;">
      📊 报告生成时间：${formatDate(new Date())} · 评分标准：教育部高考语文作文评分标准 · 驱动：${driverLabel()}
    </div>
  `;
  root.hidden = false;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

// 驱动说明：按当前运行模式显示真实后端，避免误导
function driverLabel() {
  if (state.config.mode === 'mock') return 'Mock 模拟（未接大模型）';
  if (state.config.mode === 'live') return '通义千问直连';
  if (state.config.mode === 'edge') return '通义千问（Edge 代理）';
  return '通义千问';
}

/* ====================================================================
 * Word 报告生成（docx-js）
 * ==================================================================== */
async function downloadWord() {
  if (!state.score) {
    alert('请先完成评分');
    return;
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = window.docx;
  const score = state.score;
  const meta = state.meta;
  const essayText = $('ocrEssay').value.trim();
  const essayTitle = $('essayTitle').value.trim() || meta.title || '未提供标题';

  // 各段落
  const children = [];

  // 标题
  children.push(new Paragraph({
    text: '语文作文批改报告',
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 }
  }));

  // 元数据
  const metaInfo = [
    `学校：${meta.school || '—'}`,
    `学生：${meta.student || '—'}`,
    `批改时间：${formatDate(meta.createdAt)}`
  ].join('    ');
  children.push(new Paragraph({
    children: [new TextRun({ text: metaInfo, size: 20, color: '666666' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
    border: { bottom: { color: '1E3A8A', size: 6, style: BorderStyle.SINGLE, space: 4 } }
  }));

  // 总分
  children.push(new Paragraph({
    children: [
      new TextRun({ text: '总分：', size: 32 }),
      new TextRun({ text: `${score.total}`, size: 48, bold: true, color: 'F59E0B' }),
      new TextRun({ text: ' / 60', size: 32, color: '999999' }),
      new TextRun({ text: `    （${score.tier}）`, size: 24, color: 'F59E0B' })
    ],
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 200 }
  }));

  // 分项
  children.push(new Paragraph({ text: '一、评分结果', heading: HeadingLevel.HEADING_2, spacing: { after: 100 } }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: '基础等级（40 分）：', bold: true, size: 24 }),
      new TextRun({ text: `${score.basic} 分`, bold: true, color: '1E3A8A', size: 24 })
    ],
    spacing: { after: 80 }
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: score.basicReason, size: 22 })],
    spacing: { after: 200 }
  }));

  children.push(new Paragraph({
    children: [
      new TextRun({ text: '发展等级（20 分）：', bold: true, size: 24 }),
      new TextRun({ text: `${score.develop} 分`, bold: true, color: 'F59E0B', size: 24 })
    ],
    spacing: { after: 80 }
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: score.developReason, size: 22 })],
    spacing: { after: 300 }
  }));

  // 修改升格建议
  children.push(new Paragraph({ text: '四、原文升格示范（最实用）', heading: HeadingLevel.HEADING_2, spacing: { after: 100, before: 200 } }));
  if (score.polishExamples && score.polishExamples.length) {
    score.polishExamples.forEach((p, i) => {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `改写 ${i + 1}`, bold: true, color: '1E3A8A', size: 24 }),
          p.gain ? new TextRun({ text: `    💰 ${p.gain}`, color: 'F59E0B', bold: true, size: 22 }) : new TextRun('')
        ],
        spacing: { before: 150, after: 80 }
      }));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: '【原文】', bold: true, color: 'DC2626', size: 20 }),
          new TextRun({ text: p.original, size: 22 })
        ],
        spacing: { after: 60 }, indent: { left: 200 }
      }));
      if (p.issue) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: '【问题】', bold: true, color: 'F59E0B', size: 20 }),
            new TextRun({ text: p.issue, size: 22 })
          ],
          spacing: { after: 60 }, indent: { left: 200 }
        }));
      }
      children.push(new Paragraph({
        children: [
          new TextRun({ text: '【升格】', bold: true, color: '10B981', size: 20 }),
          new TextRun({ text: p.polished, size: 22 })
        ],
        spacing: { after: 60 }, indent: { left: 200 }
      }));
      if (p.technique) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: '【改写手法】', bold: true, color: '1E3A8A', size: 20 }),
            new TextRun({ text: p.technique, size: 22 })
          ],
          spacing: { after: 200 }, indent: { left: 200 }
        }));
      }
    });
  } else {
    children.push(new Paragraph({
      children: [new TextRun({ text: '（无）', size: 22, color: '999999' })],
      spacing: { after: 100 }
    }));
  }

  // 提分路径
  children.push(new Paragraph({ text: '五、提分路径（按性价比从高到低）', heading: HeadingLevel.HEADING_2, spacing: { after: 100, before: 200 } }));
  if (score.gainPlan && score.gainPlan.length) {
    score.gainPlan.forEach((g) => {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `STEP ${g.step}  `, bold: true, color: 'F59E0B', size: 24 }),
          new TextRun({ text: g.task, size: 22, bold: true })
        ],
        spacing: { before: 100, after: 60 }
      }));
      const metaParts = [];
      if (g.expected) metaParts.push('📈 ' + g.expected);
      if (g.difficulty) metaParts.push('难度：' + g.difficulty);
      if (metaParts.length) {
        children.push(new Paragraph({
          children: [new TextRun({ text: metaParts.join('    '), size: 20, color: '10B981' })],
          spacing: { after: 150 }, indent: { left: 200 }
        }));
      }
    });
  }

  // 问题诊断
  children.push(new Paragraph({ text: '六、主要问题诊断', heading: HeadingLevel.HEADING_2, spacing: { after: 100, before: 200 } }));
  if (score.issues && score.issues.length) {
    score.issues.forEach((it, i) => {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${i + 1}. ${it.title}`, bold: true, size: 24 }),
          it.gain ? new TextRun({ text: `    ${it.gain}`, color: 'F59E0B', size: 22 }) : new TextRun('')
        ],
        spacing: { before: 100, after: 60 }
      }));
      children.push(new Paragraph({
        children: [new TextRun({ text: it.body, size: 22 })],
        spacing: { after: 150 }, indent: { left: 200 }
      }));
    });
  }

  // 兼容字段
  children.push(new Paragraph({ text: '七、修改升格建议（短建议）', heading: HeadingLevel.HEADING_2, spacing: { after: 100, before: 200 } }));
  (score.suggestions || []).forEach((s, i) => {
    children.push(new Paragraph({
      children: [new TextRun({ text: `${i + 1}. ${s.title}`, bold: true, size: 24 })],
      spacing: { before: 100, after: 80 }
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: s.body || s, size: 22 })],
      spacing: { after: 200 }
    }));
  });

  // 题目
  children.push(new Paragraph({ text: '八、题目', heading: HeadingLevel.HEADING_2, spacing: { after: 100, before: 200 } }));
  children.push(new Paragraph({
    children: [new TextRun({ text: essayTitle, bold: true, size: 24 })],
    spacing: { after: 200 }
  }));

  // 作文正文
  children.push(new Paragraph({ text: '九、修正识别误差后的作文文本', heading: HeadingLevel.HEADING_2, spacing: { after: 100 } }));
  essayText.split(/\n+/).forEach((para) => {
    if (!para.trim()) return;
    children.push(new Paragraph({
      children: [new TextRun({ text: para.trim(), size: 22 })],
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 120, line: 360 }
    }));
  });

  // 页脚
  children.push(new Paragraph({
    children: [new TextRun({ text: '\n—— 报告生成时间：' + formatDate(new Date()) + ' · 驱动：' + driverLabel() + ' ——', size: 18, color: '999999' })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 400 }
  }));

  const doc = new Document({
    creator: '语文作文智能批改平台',
    title: `${meta.student || '学生'}_作文批改报告`,
    sections: [{
      properties: { page: { margin: { top: 1000, right: 1200, bottom: 1000, left: 1200 } } },
      children
    }]
  });

  const blob = await Packer.toBlob(doc);
  const filename = `${meta.student || '学生'}_${score.total}分_${formatDate(new Date()).split(' ')[0]}.docx`;
  saveAs(blob, filename);
}

/* ====================================================================
 * 历史记录（localStorage）
 * ==================================================================== */
const HISTORY_KEY = 'composition_platform_history_v1';

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (e) { return []; }
}

function saveHistoryList(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

function addToHistory(record) {
  const list = loadHistory();
  list.unshift(record);
  saveHistoryList(list.slice(0, 50));
  renderHistory();
}

function deleteFromHistory(id) {
  const list = loadHistory().filter((x) => x.id !== id);
  saveHistoryList(list);
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  const root = $('historyList');
  if (list.length === 0) {
    root.innerHTML = '<div class="history-empty">暂无记录</div>';
    return;
  }
  root.innerHTML = list.map((r) => `
    <div class="history-item" data-id="${r.id}">
      <div class="hi-top">
        <span class="hi-name">${escapeHtml(r.student)}</span>
        <span class="hi-score">${r.total} 分</span>
      </div>
      <div class="hi-meta">
        <span>${escapeHtml(r.school || '—')}</span>
        <span>${formatDate(r.createdAt).slice(5, 16)}</span>
      </div>
      <div class="hi-actions">
        <button data-act="view">查看</button>
        <button data-act="del">删除</button>
      </div>
    </div>
  `).join('');

  root.querySelectorAll('.history-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('[data-act="view"]').addEventListener('click', () => {
      const r = loadHistory().find((x) => x.id === id);
      if (!r) return;
      state.meta = r.meta;
      state.score = r.score;
      $('schoolName').value = r.meta.school || '';
      $('studentName').value = r.meta.student || '';
      $('essayTitle').value = r.meta.title || '';
      $('ocrQuestion').value = r.question || '';
      $('ocrEssay').value = r.essay || '';
      updateCharCount();
      renderReport(r.score, r.meta, r.essay, r.meta.title);
      goStep(3);
    });
    item.querySelector('[data-act="del"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('确认删除这条历史记录？')) deleteFromHistory(id);
    });
  });
}

/* ====================================================================
 * 字数统计
 * ==================================================================== */
function updateCharCount() {
  const txt = $('ocrEssay').value.replace(/\s/g, '');
  $('charCount').textContent = txt.length;
}

/* ====================================================================
 * 设置弹窗
 * ==================================================================== */
function openSettings() {
  $('cfgDashKey').value = state.config.dashKey || '';
  $('cfgOcrModel').value = state.config.ocrModel;
  $('cfgScoreModel').value = state.config.scoreModel;
  $('cfgCozeUrl').value = state.config.cozeUrl || '';
  $('cfgEdgeUrl').value = state.config.edgeUrl || '';
  $('cfgEdgeKey').value = state.config.edgeAnonKey || '';
  $('cfgMode').value = state.config.mode;
  $('settingsModal').hidden = false;
}
function closeSettings() {
  $('settingsModal').hidden = true;
}

/* ====================================================================
 * 学生端 Coze 入口
 * ==================================================================== */
function openCozePortal() {
  const url = state.config.cozeUrl;
  if (!url) {
    flashToast('⚠️ 暂未配置学生入口链接，请在设置中填入');
    openSettings();
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function refreshStudentPortalLink() {
  const a = $('btnStudentPortal');
  if (a) a.href = state.config.cozeUrl || '#';
}

/* ====================================================================
 * 启动
 * ==================================================================== */

// 全局调试入口：浏览器 F12 → Console 直接调用
window.cp = {
  config: () => state.config,
  test: () => dashTest(),
  testEdge: () => edgeTest(),
  ocr: (dataUrl) => state.config.mode === 'edge' ? edgeOcr(dataUrl) : dashOcr(dataUrl),
  score: (title, content) => state.config.mode === 'edge' ? edgeScore(title, content, '') : dashScore(title, content),
  // 切换模式（控制台一行）
  setMode: (m) => { if (['mock','live','edge'].includes(m)) { state.config.mode = m; $('apiStatus').textContent = m; return 'mode=' + m; } }
};

window.addEventListener('DOMContentLoaded', () => {
  // 1. 步骤指示器可点击（落地页时不响应）
  document.querySelectorAll('.step').forEach((s) => {
    s.addEventListener('click', () => {
      const idx = +s.dataset.step;
      if (state.step === 0) return;  // 落地页时不能跳
      if (idx <= state.step || s.classList.contains('done')) goStep(idx);
    });
  });

  // 2. 上传区
  setupDropzone('question');
  setupDropzone('essay');

  // 3. 第一步按钮
  $('btnLoadDemo').addEventListener('click', loadDemo);
  $('btnGoStep2').addEventListener('click', async () => {
    $('btnGoStep2').disabled = true;
    $('btnGoStep2').textContent = '🔄 OCR 识别中...';
    try {
      // 如果已有 OCR 结果（载入示例的情况），跳过识别
      if (state.ocr.essay && state.ocr.confirmed) {
        $('ocrEssay').value = state.ocr.essay;
        $('ocrQuestion').value = state.ocr.question;
      } else {
        // 真实识别
        const [qText, eText] = await Promise.all([
          state.images.question.length ? ocrRecognize('question') : Promise.resolve(''),
          ocrRecognize('essay')
        ]);
        $('ocrQuestion').value = qText;
        $('ocrEssay').value = eText;
        state.ocr.question = qText;
        state.ocr.essay = eText;
      }

      // 渲染左侧原图
      const strip = $('imgStrip');
      const allImgs = [...state.images.question, ...state.images.essay];
      strip.innerHTML = allImgs.map((img, i) => `<img src="${img.dataUrl}" alt="原图 ${i + 1}">`).join('');

      updateCharCount();
      goStep(2);
    } catch (e) {
      alert('OCR 识别失败：' + e.message);
    } finally {
      $('btnGoStep2').disabled = false;
      $('btnGoStep2').textContent = '下一步：识别文字 →';
    }
  });

  // 4. 第二步交互
  $('ocrEssay').addEventListener('input', () => {
    updateCharCount();
    $('fixStatus').textContent = '是';
    $('ocrEssayMeta').textContent = '✓ 已修正';
    $('ocrEssayMeta').classList.add('confirmed');
  });
  $('btnBack1').addEventListener('click', () => goStep(1));
  $('btnReOcr').addEventListener('click', async () => {
    if (!confirm('重新识别将覆盖当前编辑文本，确定吗？')) return;
    $('btnReOcr').disabled = true;
    $('btnReOcr').textContent = '🔄 识别中...';
    try {
      const [qText, eText] = await Promise.all([
        state.images.question.length ? ocrRecognize('question') : Promise.resolve(''),
        ocrRecognize('essay')
      ]);
      $('ocrQuestion').value = qText;
      $('ocrEssay').value = eText;
      $('fixStatus').textContent = '否';
      $('ocrEssayMeta').textContent = 'AI 识别 · 待确认';
      $('ocrEssayMeta').classList.remove('confirmed');
      updateCharCount();
    } catch (e) {
      alert('识别失败：' + e.message);
    } finally {
      $('btnReOcr').disabled = false;
      $('btnReOcr').textContent = '🔄 重新识别';
    }
  });
  $('btnGoStep3').addEventListener('click', async () => {
    const essayText = $('ocrEssay').value.trim();
    if (essayText.length < 50) {
      alert('作文正文太短（少于 50 字），请检查识别结果');
      return;
    }
    state.edits.essay = essayText;
    state.edits.question = $('ocrQuestion').value.trim();
    state.meta = {
      school: $('schoolName').value.trim(),
      student: $('studentName').value.trim(),
      title: $('essayTitle').value.trim(),
      createdAt: new Date()
    };

    goStep(3);
    $('reportCard').hidden = true;
    $('reportLoading').hidden = false;
    $('btnGoStep3').disabled = true;

    try {
      const question = state.edits.question || state.meta.title || '';
      const score = await scoreEssay(state.meta.title || question, essayText, question);
      state.score = score;
      const essayTitle = state.meta.title || extractTitle(essayText) || question;
      state.meta.title = essayTitle;
      renderReport(score, state.meta, essayText, essayTitle);
    } catch (e) {
      alert('评分失败：' + e.message);
      goStep(2);
    } finally {
      $('reportLoading').hidden = true;
      $('btnGoStep3').disabled = false;
    }
  });

  // 5. 第三步按钮
  $('btnBack2').addEventListener('click', () => goStep(2));
  $('btnDownloadWord').addEventListener('click', () => downloadWord().catch((e) => alert('生成失败：' + e.message)));
  $('btnSaveHistory').addEventListener('click', () => {
    if (!state.score) return;
    const record = {
      id: 'r_' + Date.now(),
      meta: { ...state.meta, createdAt: new Date() },
      score: state.score,
      question: state.edits.question,
      essay: state.edits.essay
    };
    addToHistory(record);
    flashToast('✅ 已保存到历史记录');
  });
  $('btnNew').addEventListener('click', () => {
    if (state.score && !confirm('开始新批改？当前页面数据将清空（已保存的不影响）。')) return;
    state.images = { question: [], essay: [] };
    state.ocr = { question: '', essay: '', confirmed: false };
    state.edits = { question: '', essay: '' };
    state.score = null;
    state.meta = { school: '', student: '', title: '', createdAt: null };
    renderThumbs('question');
    renderThumbs('essay');
    $('ocrQuestion').value = '';
    $('ocrEssay').value = '';
    $('charCount').textContent = '0';
    $('fixStatus').textContent = '否';
    $('essayTitle').value = '';
    refreshGoStep2();
    goStep(0);  // 新批改 → 回到落地页选身份
  });

  // 6.1 落地页入口
  $('btnHome').addEventListener('click', (e) => { e.preventDefault(); goStep(0); });
  $('btnStudentPortal2').addEventListener('click', () => openCozePortal());
  $('btnTeacherPortal').addEventListener('click', () => goStep(1));

  // 6. 设置弹窗
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnCancelSettings').addEventListener('click', closeSettings);
  $('btnSaveSettings').addEventListener('click', () => {
    state.config.dashKey = $('cfgDashKey').value.trim();
    state.config.ocrModel = $('cfgOcrModel').value;
    state.config.scoreModel = $('cfgScoreModel').value;
    state.config.cozeUrl = $('cfgCozeUrl').value.trim() || state.config.cozeUrl;
    state.config.edgeUrl = $('cfgEdgeUrl').value.trim();
    state.config.edgeAnonKey = $('cfgEdgeKey').value.trim();
    const wantMode = $('cfgMode').value;
    // 防呆：选了 live/edge 但没填对应 key 时给提示再回退
    if (wantMode === 'live' && !state.config.dashKey) {
      alert('选择了「通义直连」但没填 DashScope Key，已改回 Mock。');
      state.config.mode = 'mock';
    } else if (wantMode === 'edge' && (!state.config.edgeUrl || !state.config.edgeAnonKey)) {
      alert('选择了「Edge 代理」但没填 Supabase 地址/anon key，已改回 Mock。');
      state.config.mode = 'mock';
    } else {
      state.config.mode = wantMode;
    }
    $('cfgMode').value = state.config.mode;
    refreshStudentPortalLink();
    closeSettings();
    const labels = { mock: '⚙ Mock 模拟模式', live: '✓ 通义千问直连', edge: '✓ Edge 代理（推荐部署）' };
    $('apiStatus').textContent = labels[state.config.mode];
    $('apiStatus').style.background = state.config.mode === 'mock' ? '' : 'rgba(16, 185, 129, .18)';
    $('apiStatus').style.color = state.config.mode === 'mock' ? '' : '#10b981';
    flashToast('✅ 设置已保存，当前模式：' + labels[state.config.mode]);
  });

  // 学生端 Coze 入口（仅落地页「学生入口」大卡片使用）
  $('btnShareStudent').addEventListener('click', async () => {
    const url = state.config.cozeUrl;
    if (!url) {
      flashToast('⚠️ 暂未配置学生入口链接');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      flashToast('✅ Coze 链接已复制到剪贴板，发给学生吧');
    } catch (e) {
      // 兜底：选中后弹窗显示
      prompt('复制以下链接发给学生：', url);
    }
  });

  // 初始化学生端链接
  refreshStudentPortalLink();
  $('btnClearHistory').addEventListener('click', () => {
    if (confirm('确认清空全部历史记录？此操作不可恢复。')) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });

  // 7. 启动渲染
  renderHistory();
  refreshGoStep2();
  goStep(0);  // 默认显示落地页
});

function extractTitle(text) {
  const m = text.match(/《([^》]+)》/);
  return m ? m[1] : '';
}

function flashToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:80px;right:24px;background:#1e3a8a;color:#fff;padding:10px 18px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:300;font-size:13px;animation:slideIn .3s ease;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
