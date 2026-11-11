# 高考语文作文分层辅导与智能批阅 · 教师端

高考 60 分制（基础 40 + 发展 20）智能批改平台。前端纯静态，部署到 GitHub Pages，DashScope API Key 通过 Supabase Edge Functions 隔离保存，**前端永不暴露密钥**。

## 教师登录与安全架构（2026-11-11 安全改造）

### 账号

| 姓名 | 账号（姓名全拼） |
|------|------------------|
| 李海峰 | `lihaifeng` |
| 周念 | `zhounian` |
| 祁正伟 | `qizhengwei` |

初始密码三人统一（**不在本仓库记录明文**），由管理员告知；登录后可在右上角「改密码」自助修改。
密码哈希存 `public.teacher_accounts` 表，`TEACHER_ACCOUNTS` Secret 只作首次登录的引导数据。

> ⚠️ 账号是姓名拼音、初始密码是弱口令，等于没有密码强度。任何人知道网址就能登进来用你的额度批改，
> 所以**阿里云侧的月度消费上限必须设**——那是目前唯一真正兜底的一道。

### 为什么改成这样

旧架构把 publishable key 当"通行证"：凡是拿着这个 key 的请求一律放行。可 publishable key 天生就要公开在网页里（F12 一看就有），
结果是**任何人打开网页、复制那个 key，就能无限调用 ocr / score 刷掉 DashScope 额度**。2026-09-07 的密钥泄露事故就是这么发生的。

2026-11-11 起改为「服务端签发令牌」：

```
浏览器 ──账号+密码──> login 函数 ──校验 PBKDF2 哈希──> 签发 8 小时 JWT
   │                                                      │
   └──后续请求带 Authorization: Bearer <JWT> ──> ocr / score / report 验签放行
```

- 签名密钥 `AUTH_JWT_SECRET` 只存在 Supabase Secrets，前端伪造不了；令牌里带 `exp`，8 小时自动失效。
- 前端代码里**没有任何能换到调用权的字符串**——拿到源码、拿到 publishable key，都调不动接口。
- 密码用 PBKDF2-SHA256（100000 次迭代 + 随机盐）存哈希，同一实例内同一账号连错 5 次锁 10 分钟。
- 兜底护栏：单张图片超约 3MB、单篇正文超 8000 字直接拒绝，防止令牌万一外泄被拿来跑大批量。

> ⚠️ 平台层的 **Verify JWT 要保持 Disable**：我们用的是自签令牌，不是 Supabase Auth 签发的，
> 打开平台层校验会把所有请求当"Invalid JWT"拦掉。真正的校验在函数内部（`_shared/auth.ts`）。

### 哪些地方要登录

| 入口 | 是否需要登录 |
|------|--------------|
| 教师入口 / 批改流程（上传、识别、评分） | ✅ 需要 |
| 分享报告（生成短链接） | ✅ 需要 |
| 查看分享报告（`?r=xxxx` 链接） | ❌ 不需要，短 ID 本身就是凭据 |
| 学生入口（跳 Coze 智能体） | ❌ 不需要 |

### 改密码 / 加账号

密码哈希在 Supabase Secret `TEACHER_ACCOUNTS`（JSON 数组）里，不在代码中。改法：

```bash
# 1. 生成新哈希
node -e "const c=require('crypto');const p=process.argv[1];const s=c.randomBytes(16);const h=c.pbkdf2Sync(p,s,100000,32,'sha256');console.log('pbkdf2$100000$'+s.toString('base64')+'$'+h.toString('base64'))" '新密码'

# 2. 替换 TEACHER_ACCOUNTS 里对应账号的 hash，重新设置 Secret 并重部署 login
supabase secrets set --project-ref gqlwspxcyhjtzhikcexj TEACHER_ACCOUNTS='[...]'
supabase functions deploy login --project-ref gqlwspxcyhjtzhikcexj --no-verify-jwt
```

### 成本兜底（强烈建议同时做）

即便架构再严，令牌仍可能经老师本机外泄。建议去**阿里云百炼控制台**给这把 Key 绑一个月度消费上限（或换成 RAM 子账号 + 配额），
这样就算真出事，损失也有天花板。

## 目录结构

```
composition-platform/
├── index.html                      # 教师端 SPA
├── assets/
│   ├── app.js                      # 业务脚本（支持 mock/live/edge 三模式）
│   └── styles.css                  # 样式
├── supabase/
│   └── functions/
│       ├── _shared/auth.ts         # 令牌签发/验签、PBKDF2 密码校验（被下面几个函数共用）
│       ├── login/index.ts          # 登录：校验账号密码 → 签发 8 小时 JWT
│       ├── ocr/index.ts            # OCR 代理（需教师令牌）
│       ├── score/index.ts          # 评分代理（需教师令牌）
│       └── report/index.ts         # 分享报告存取（存需令牌，读免登录）
└── .github/
    └── workflows/
        ├── deploy-pages.yml        # GitHub Pages 自动部署
        └── keep-alive.yml          # 每 12 小时 ping Supabase 防止被暂停
```

## 运行模式

平台支持三种模式（设置面板可切换）：

| 模式 | 说明 | 何时用 |
|------|------|--------|
| `mock` | 模拟假数据 | 演示、无 API 时 |
| `live` | 直连 DashScope（Key 写在前端） | **仅本地开发/单机演示** |
| `edge` | 通过 Supabase Edge Function 代理 | **部署后默认，Key 不暴露** |

## 部署步骤（约 10 分钟）

> ⚠️ **密钥绝不能硬编码进代码！**
> 本项目 2026-09-07 曾把 DashScope Key 以 `FALLBACK_DASH_KEY` 形式写进函数代码，
> 而本仓库是 **public**（GitHub Pages 免费版必须公开），导致密钥自 09-07 起公开暴露，
> 被爬虫扫走后盗刷，累计损失 400+ 元。
>
> 现在两个函数都**只从 Edge Function Secrets 读取** `DASHSCOPE_API_KEY`，读不到就报 500 并提示。
> 密钥配置位置：**Project Settings → Edge Functions → Secrets**，切勿再写回代码。

### 推荐：用 CLI 部署（比手贴快，且不会漏配 Verify JWT）

```bash
# 首次使用需登录（令牌会存在系统凭据管理器里）
supabase login

cd composition-platform

# --no-verify-jwt 必须带：新版 sb_publishable_ key 不是 JWT，不带会全线 401
supabase functions deploy ocr   --project-ref gqlwspxcyhjtzhikcexj --no-verify-jwt
supabase functions deploy score --project-ref gqlwspxcyhjtzhikcexj --no-verify-jwt
```

### 或：在 Dashboard 手工部署

1. 左侧菜单 **Edge Functions** → **Create new function**
2. 函数名填 `ocr` → 进编辑器 → **Ctrl+A 全选 → 删除默认代码** → 打开 `supabase/functions/ocr/index.ts` 复制全文 → 粘贴 → **Deploy**
3. 同理：建 `score`，粘贴 `supabase/functions/score/index.ts` → **Deploy**
4. 每个函数 deploy 后，**点进函数详情 → Settings / Authentication → 找到 `Verify JWT` → 设为 Disable**（默认是 Required）。**这一步不做，前端会 401**。
5. 两个函数都部署完毕（首次冷启动 10-20 秒）后告诉我，我接管推送。

### 3. 测试 Edge Functions

部署后约 10 秒，给项目一点启动时间。在浏览器/终端试一下（**注意：publishable key 放 `apikey` 头，不要放 `Authorization: Bearer`**）：

```bash
# OCR 测试（应该返回 200 + JSON）
curl -X POST "https://gqlwspxcyhjtzhikcexj.supabase.co/functions/v1/ocr" \
  -H "apikey: sb_publishable_PqN5m9yOrWZzBazFjO7Y_w_pfIMO1PI" \
  -H "Content-Type: application/json" \
  -d '{"image":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="}'

# Score 测试（应该返回 JSON total:48 basic:35 ...）
curl -X POST "https://gqlwspxcyhjtzhikcexj.supabase.co/functions/v1/score" \
  -H "apikey: sb_publishable_PqN5m9yOrWZzBazFjO7Y_w_pfIMO1PI" \
  -H "Content-Type: application/json" \
  -d '{"title":"测试","content":"失意是磨砺，诗意是超越。"}'
```

### 4. 推送到 GitHub 并启用 Pages

1. 在 GitHub 网页新建仓库 `composition-grader`（public）
2. 把本目录所有文件推送上去：
   ```bash
   cd composition-platform
   git init && git add . && git commit -m "init: composition grader v3"
   git branch -M main
   git remote add origin https://github.com/wayland123456/composition-grader.git
   git push -u origin main
   ```
   （如果 push 时弹 Windows Credential Manager，用之前的 `cmdkey /list` + PowerShell 提取 token 套路）
3. 仓库 **Settings → Pages → Build and deployment → Source: GitHub Actions**
4. `.github/workflows/deploy-pages.yml` 已配好，push 上去会自动跑一次
5. 第一次跑需要去 **Settings → Pages → 点击授权 GitHub Actions 部署**（一次性）

部署完成后，URL 是：
```
https://wayland123456.github.io/composition-grader/
```

### 5. 配置 keep-alive workflow

为防止 Supabase 免费层项目因 7 天无活动被暂停：

1. 进仓库 **Settings → Secrets and variables → Actions → New repository secret**
2. Name: `SUPABASE_URL`，Value: `https://gqlwspxcyhjtzhikcexj.supabase.co`（**不要带 `/functions/v1` 后缀**）
3. 之后 workflow `keep-alive.yml` 会每 12 小时自动 ping

可以手动触发一次验证：进 Actions → `keep-supabase-alive` → Run workflow。

### 6. 第一次打开前端（默认值已预填）

默认情况下 `assets/app.js` 已把 `edgeUrl = 'https://gqlwspxcyhjtzhikcexj.supabase.co/functions/v1'`、`mode = 'edge'` 预设好，部署后打开就是 Edge 模式。**唯一需要的是 anon key**：

1. 打开 `https://wayland123456.github.io/composition-grader/`
2. 点右上角「⚙ 设置」→ 在「🔒 Edge 代理配置」填入 **anon key**（`eyJ` 开头那串）
3. 保存。弹「✅ Edge 代理已配置」即可。

> 浏览器 F12 → Console 里敲 `cp.testEdge()` 可以测试；`cp.config()` 看当前配置；`cp.setMode('mock')` 临时切回 mock。

## 安全要点

- ✅ DashScope Key 只存 Supabase Secrets（`DASHSCOPE_API_KEY`），前端任何文件均不包含
- ✅ 令牌签名密钥只存 Secrets（`AUTH_JWT_SECRET`），前端伪造不了签名
- ✅ 教师密码只存 PBKDF2 哈希（`TEACHER_ACCOUNTS`），仓库里没有明文
- ✅ **拿到网页源码 + publishable key 也调不动接口**：没有合法令牌一律 401
- ⚠️ 平台层 Verify JWT 必须保持 **Disable**（自签令牌不是 Supabase 签发的），校验在 `_shared/auth.ts` 内部完成
- ⚠️ 仍属"前端 + Serverless"架构，真正的资产（模型 Key、签名密钥、密码哈希）都在服务端
- 📊 成本天花板请在阿里云侧设额度上限，不要只依赖代码

## 部署（2026-11-11 之后的版本必须用 CLI）

`_shared/auth.ts` 被多个函数 import，Dashboard 的单文件粘贴部署**不认相对路径**，必须用 CLI：

```bash
# 首次：登录并关联项目
supabase login
supabase link --project-ref gqlwspxcyhjtzhikcexj

# 设置两个服务端 Secret（值见本机备份文件，不要提交到仓库）
supabase secrets set --project-ref gqlwspxcyhjtzhikcexj \
  AUTH_JWT_SECRET='<48字节随机串>' \
  TEACHER_ACCOUNTS='[{"account":"lihaifeng","name":"李海峰","hash":"pbkdf2$..."},...]'

# 部署四个函数（--no-verify-jwt：平台层校验必须关，函数内自己验签）
for fn in login ocr score report; do
  supabase functions deploy $fn --project-ref gqlwspxcyhjtzhikcexj --no-verify-jwt
done
```

前端改动推 GitHub 即可（Pages 自动部署）。

## 本地开发

```bash
cd composition-platform
python -m http.server 8000
# 打开 http://localhost:8000
```

设置面板里选「Mock 模拟」或「通义直连」即可，无需 Supabase。

## 升级 / 部署新版本

```bash
# 改完代码
git add .
git commit -m "feat: xxx"
git push                       # Pages 自动部署
```

Edge Functions 改完后，在 Supabase Dashboard 的函数编辑器粘贴新代码 → Deploy 即可，无需 CLI。

## 相关链接

- 通义千问 DashScope 控制台：https://dashscope.console.aliyun.com/apiKey
- Supabase Dashboard：https://supabase.com/dashboard
- GitHub Pages 文档：https://docs.github.com/pages
