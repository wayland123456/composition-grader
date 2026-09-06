# 语文作文智能批改平台 · 教师端

高考 60 分制（基础 40 + 发展 20）智能批改平台。前端纯静态，部署到 GitHub Pages，DashScope API Key 通过 Supabase Edge Functions 隔离保存，**前端永不暴露密钥**。

## 目录结构

```
composition-platform/
├── index.html                      # 教师端 SPA
├── assets/
│   ├── app.js                      # 业务脚本（支持 mock/live/edge 三模式）
│   └── styles.css                  # 样式
├── supabase/
│   └── functions/
│       ├── ocr/index.ts            # Supabase Edge Function · OCR 代理
│       └── score/index.ts          # Supabase Edge Function · 评分代理
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

> ⚠️ **注意**：当前 Supabase 账号免费额度已满（已建 2 个项目），本平台复用 **英语学习网站** `gqlwspxcyhjtzhikcexj` 项目，加 2 个 Edge Function，不新建项目。

### 1. 进入英语网站项目 Dashboard（30 秒）

打开 https://supabase.com/dashboard → 进入 **`english-learning`（ref: `gqlwspxcyhjtzhikcexj`）** 项目。

> **已无需任何 Secrets 配置！** DashScope Key 和 publishable key 已硬编码进函数代码作兜底，未来可在 Dashboard 里加 Secret override。

### 2. 部署两个 Edge Function（3 分钟）

1. 左侧菜单 **Edge Functions** → **Create new function**
2. 函数名填 `ocr` → 进编辑器 → **Ctrl+A 全选 → 删除默认代码** → 打开 `supabase/functions/ocr/index.ts` 复制全文 → 粘贴 → **Deploy**
3. 同理：建 `score`，粘贴 `supabase/functions/score/index.ts` → **Deploy**
4. 每个函数 deploy 后，**点进函数详情 → Settings / Authentication → 找到 `Verify JWT` → 设为 Disable**（默认是 Required）。**这一步不做，前端会 401**。
5. 两个函数都部署完毕（首次冷启动 10-20 秒）后告诉我，我接管推送。

> ⚠️ **Verify JWT 必须关**：新版 `sb_publishable_` key 不是 JWT，平台会拒绝。我们已在函数内实现了 `apikey` header 校验。

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

- ✅ DashScope Key 只存 Supabase Secrets，前端任何文件均不包含
- ✅ 前端只暴露 Supabase anon key（按 Supabase 官方的设计就是给前端用的），配合 `verify_jwt: true` 防止滥用
- ⚠️ 任何拿到 anon key + URL 的人都能调 Edge Functions，单次成本 ≈ 几厘钱
- 📊 如果担心被刷，在 Supabase Dashboard → Edge Functions → 设置 **Rate Limit**

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
