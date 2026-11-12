# qqqzz 免费名片赞自动领取（每天100个）

通过 GitHub Actions + Playwright 浏览器自动化，每天自动领取 qqqzz.cc 的免费名片赞。

> 原站 `fk.555655.cn` 已迁移至 `https://qqqzz.cc`，本项目适配新站。

## 原理

商品：**快刷名片赞100个**（id=83，价格 0，无需登录，无验证码）

脚本用 Playwright 真浏览器走与手动完全相同的路径：

1. 打开 `https://qqqzz.cc/`（首页访问验证为 meta-refresh 自动跳转，真浏览器自动通过）
2. 进入下单确认页 `#/order-confirm/83`
3. 填写 QQ 号
4. 点击「免费领取」
    - `POST /api/PreviewPrice` → `is_free: true`（确认免费）
    - `POST /api/add` → `订单创建成功`

脚本同时内置两级保护：商品变为收费时中止；站点返回「需登录 / 需验证码」（站点级封禁）或连续 2 个 QQ 失败时立即中止剩余 QQ，避免风控升级。多号时每个 QQ 独立走完整流程，单个失败不阻断其余 QQ。

## 快速开始

### 第一步：Fork 本仓库

1. 进入仓库主页，点击右上角 **Fork**
2. 进入你 Fork 后的仓库

### 第二步：设置配置（Repository Secret）

1. **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. 名称：`CONFIG`，值：一整段 JSON（见下方模板）
4. **Add secret**

**推荐：一个 `CONFIG` 统一配置**。JSON 里的值全部用**双引号**包裹：

```json
{
  "QQ_NUMBER": "123456789|987654321",
  "BATCH_SIZE": "3",
  "QQ_PAUSE": "10",
  "BATCH_PAUSE": "45",
  "FAIL_STOP": "2",
  "TELEGRAM_BOT_TOKEN": "",
  "TELEGRAM_CHAT_ID": "",
  "WXPUSH_URL": "",
  "WXPUSH_TOKEN": "",
  "WXPUSH_USERID": "",
  "WXPUSH_TEMPLATE_ID": "",
  "WXPUSH_BASE_URL": ""
}
```

> **只有 `QQ_NUMBER` 是必填**，其余留空即用默认值（`BATCH_SIZE=3`、`QQ_PAUSE=10`、`BATCH_PAUSE=45`、`FAIL_STOP=2`）；通知项留空则不推送。
> JSON 的键**必须用双引号**，值可以是字符串（双引号）或数字（如 `"BATCH_SIZE": 3`）。
> `QQ_NUMBER` 支持多号，用**半角竖线 `|` 分隔**（如 `123456789|987654321`），**每个 QQ 号必须是 5-12 位纯数字、首位不能是 0**。
> `CONFIG` 格式写错会直接报错退出（exit 1），不会静默用错配置。
> **同一批内不要出现重复的 QQ 号**——脚本按 `batch.indexOf(qq)` 定位休息时机，重复号会打乱批次内休息节奏。

<details>
<summary>不想用 CONFIG？也可以逐个设置同名 Secret（兼容方式）</summary>

不用 `CONFIG` 时，可以把上面 JSON 里的每个 key 单独加成同名 Secret（`QQ_NUMBER`、`BATCH_SIZE`、`QQ_PAUSE`、`BATCH_PAUSE`、`FAIL_STOP`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`WXPUSH_URL`、`WXPUSH_TOKEN`、`WXPUSH_USERID`、`WXPUSH_TEMPLATE_ID`、`WXPUSH_BASE_URL`），效果完全一致。

> ⚠️ **两种方式不要同时用**：一旦 `CONFIG` 存在，逐个设置的同名 Secret 会被**完全忽略**（不会合并覆盖）。日志开头会打印一行 `⚠️` 提醒你哪些被忽略了。
</details>

> 多号时每个 QQ 独立走完整流程（进下单页 → 填号 → 点免费领取 → 等结果），互不影响；单个 QQ 失败不阻断其余 QQ。
> 每个 QQ 使用独立浏览器页签 + 独立响应捕获，响应不会串号；日志每条判定都带 `QQ=xxxxxx` 标识（QQ 号**只显示前 4 位**，其余用 `****` 代替，仅影响日志，请求里仍是完整 QQ 号）。

#### 可选：配置通知

想让运行结果推送消息，在 `CONFIG` 里填对应项（两个通道**互相独立**，可只配一个，也可都配；都不配则只在 Actions 日志里看结果）：

<table>
<thead>
<tr>
<th width="180">配置项</th>
<th>说明</th>
</tr>
</thead>
<tbody>
<tr><td><code>TELEGRAM_BOT_TOKEN</code></td><td>Telegram Bot Token；不配则只打印推送预览，不影响领取</td></tr>
<tr><td><code>TELEGRAM_CHAT_ID</code></td><td>Telegram 会话 ID；不配则只打印推送预览，不影响领取</td></tr>
<tr><td><code>WXPUSH_URL</code></td><td>wxpush 微信消息推送 Worker 基础地址（不含 <code>/wxsend</code>，代码自动拼接）；不配则只打印推送预览，不影响领取。项目：<a href="https://github.com/frankiejun/wxpush">frankiejun/wxpush</a></td></tr>
<tr><td><code>WXPUSH_TOKEN</code></td><td>部署 wxpush 时设置的 API_TOKEN（访问令牌）；需同时配置 <code>WXPUSH_URL</code>，否则不发送</td></tr>
<tr><td><code>WXPUSH_USERID</code></td><td>可选：覆盖 wxpush 默认接收用户（多个 OpenID 用半角竖线 <code>|</code> 分隔，勿用全角 <code>｜</code>），示例：<code>OpenID1|OpenID2</code>；不配则用 wxpush 服务端的 <code>WX_USERID</code></td></tr>
<tr><td><code>WXPUSH_TEMPLATE_ID</code></td><td>可选：覆盖 wxpush 默认模板 ID，示例：<code>模板ID</code>；不配则用 wxpush 服务端的 <code>WX_TEMPLATE_ID</code></td></tr>
<tr><td><code>WXPUSH_BASE_URL</code></td><td>可选：点击模板消息后跳转的地址（如 <code>https://your-skin-page.com/skin</code>）；不配则跳 wxpush 服务的 <code>/skin</code> 详情页</td></tr>
</tbody>
</table>

> Telegram 需先找 [@BotFather](https://t.me/BotFather) 建 bot 并拿到 bot token；wxpush 是自建的 Cloudflare Worker 推送服务，部署后有自己的域名和 `API_TOKEN`。
> wxpush项目用的是 **[frankiejun/wxpush](https://github.com/frankiejun/wxpush)**（`GET /wxsend?token=...`）。

### 第三步：启用 GitHub Actions

- Actions 默认每天自动运行
- 也可在 **Actions** → **免费名片赞自动领取** → **Run workflow** 手动触发

**需配置仓库 Secrets**（Settings → Secrets and variables → Actions → New repository secret）：

- `CONFIG`（✅ 必填，一整段 JSON，见第二步）
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（**可选**：不配则只打印推送预览，不影响领取）
- `WXPUSH_URL`、`WXPUSH_TOKEN`（**可选**：wxpush 微信消息推送；不配则只打印推送预览，不影响领取。需同时配置才发送）
- `WXPUSH_USERID`、`WXPUSH_TEMPLATE_ID`、`WXPUSH_BASE_URL`（**可选**：覆盖 wxpush 服务端的默认接收用户 / 模板 / 跳转页；不配则用服务端默认）

> 💡 **推荐只配一个 `CONFIG`**，通知项一并写在 JSON 里；上面这些单项 Secret 是兼容方式，**与 `CONFIG` 同时存在时会被忽略**（日志开头有 `⚠️` 提醒）。

## 本地运行

```bash
npm install
node node_modules/playwright-core/cli.js install chromium

# 方式一：统一配置（JSON，与 GitHub Secret 同格式）
export CONFIG='{"QQ_NUMBER":"123456789|987654321","BATCH_SIZE":"3","QQ_PAUSE":"10","BATCH_PAUSE":"45","FAIL_STOP":"2"}'
node claim.js            # 真实领取（多号，竖线分隔）
node claim.js --dry-run  # 演练：走到提交前拦截，不产生订单

# 方式二：逐个环境变量（本地调试更方便）
export QQ_NUMBER='123456789|987654321'
export BATCH_SIZE='3'
export QQ_PAUSE='10'
export BATCH_PAUSE='45'
export FAIL_STOP='2'
export TELEGRAM_BOT_TOKEN='xxx'
export TELEGRAM_CHAT_ID='xxx'
# wxpush 微信消息推送（可选，与 Telegram 独立；不配则只打印预览）
export WXPUSH_URL='https://your-worker.workers.dev'   # 不含 /wxsend，代码自动拼接
export WXPUSH_TOKEN='xxx'
export WXPUSH_USERID='OpenID1|OpenID2'   # 可选：覆盖默认接收用户（半角 | 分隔，勿用全角）
export WXPUSH_TEMPLATE_ID='模板ID'       # 可选：覆盖默认模板 ID
export WXPUSH_BASE_URL='https://your-skin-page.com/skin'   # 可选：覆盖跳转地址

node claim.js --dry-run
```

> ⚠️ **两种方式不要同时用**：`CONFIG` 存在时，上面这些同名环境变量会被**完全忽略**（不会合并覆盖）。日志开头会打印一行 `⚠️` 提醒你哪些被忽略了。

配置项（两种方式任选其一，**`CONFIG` 优先**）：

<table>
<thead>
<tr>
<th width="180">配置项</th>
<th>说明</th>
</tr>
</thead>
<tbody>
<tr><td><code>QQ_NUMBER</code></td><td>必填，目标 QQ 号（多号用半角竖线 <code>|</code> 分隔，如 <code>123456789|987654321</code>）。格式要求：<strong>5-12 位纯数字，首位不能是 0</strong>，不合法会直接报错退出（exit 1）</td></tr>
<tr><td><code>BATCH_SIZE</code></td><td>每批领取的 QQ 数，默认 <code>3</code>（主动分批，降低风控）</td></tr>
<tr><td><code>QQ_PAUSE</code></td><td>批次内 QQ 之间休息秒数，默认 <code>10</code></td></tr>
<tr><td><code>BATCH_PAUSE</code></td><td>批次间休息秒数，默认 <code>45</code></td></tr>
<tr><td><code>FAIL_STOP</code></td><td>连续失败 N 个即中止，默认 <code>2</code>（防风控升级）</td></tr>
<tr><td><code>TELEGRAM_BOT_TOKEN</code></td><td>Telegram Bot Token；不配则只打印推送预览，不影响领取</td></tr>
<tr><td><code>TELEGRAM_CHAT_ID</code></td><td>Telegram 会话 ID；不配则只打印推送预览，不影响领取</td></tr>
<tr><td><code>WXPUSH_URL</code></td><td>wxpush 微信消息推送 Worker 基础地址（不含 <code>/wxsend</code>，代码自动拼接）；不配则只打印推送预览，不影响领取。项目：<a href="https://github.com/frankiejun/wxpush">frankiejun/wxpush</a></td></tr>
<tr><td><code>WXPUSH_TOKEN</code></td><td>部署 wxpush 时设置的 API_TOKEN（访问令牌）；需同时配置 <code>WXPUSH_URL</code>，否则不发送</td></tr>
<tr><td><code>WXPUSH_USERID</code></td><td>可选：覆盖 wxpush 默认接收用户（多个 OpenID 用半角竖线 <code>|</code> 分隔，勿用全角 <code>｜</code>），示例：<code>OpenID1|OpenID2</code>；不配则用 wxpush 服务端的 <code>WX_USERID</code></td></tr>
<tr><td><code>WXPUSH_TEMPLATE_ID</code></td><td>可选：覆盖 wxpush 默认模板 ID，示例：<code>模板ID</code>；不配则用 wxpush 服务端的 <code>WX_TEMPLATE_ID</code></td></tr>
<tr><td><code>WXPUSH_BASE_URL</code></td><td>可选：点击模板消息后跳转的地址（如 <code>https://your-skin-page.com/skin</code>）；不配则跳 wxpush 服务的 <code>/skin</code> 详情页</td></tr>
</tbody>
</table>

> **分批说明**：脚本自动按 `BATCH_SIZE`（默认 3）分批；**批次内**每个 QQ 之间休息 `QQ_PAUSE`（默认 10 秒），**批次之间**休息 `BATCH_PAUSE`（默认 45 秒），降低站点风控风险。单个 QQ 失败不中断其余 QQ。

> **通知说明**：运行结束后自动推送结果到 **Telegram**（`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`）和 **wxpush**（`WXPUSH_URL` + `WXPUSH_TOKEN`），两者独立可同时启用；均未配置时只在日志打印预览。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 / 今日已领过 |
| 1 | 配置错误（`CONFIG` 格式错、缺 `QQ_NUMBER`、QQ 号格式非法）或已跑完但有 QQ 领取失败 |
| 2 | 需要登录（站点级封禁，已中止剩余 QQ） |
| 3 | 需要验证码（站点级封禁，已中止剩余 QQ） |
| 4 | 连续失败中止（疑似风控） |
| 10 | 流程异常（浏览器启动失败、访问验证未通过等） |

> exit 1 有两种来源：看日志开头是 `❌ 缺少配置项` / `❌ CONFIG 格式不正确` / `❌ QQ_NUMBER 格式不合法` → 配置问题；否则是领取失败。

## 注意事项

- 站点下单页要求：**同一个 QQ 一次性下好数量**，且需开启「允许任何人赞我」
- 免费商品每天限领一次
- 若商品改为收费/需要登录，脚本会中止并在日志中说明
- **自动分批**：每批 3 个（`BATCH_SIZE`）；批次内 QQ 之间休息 10 秒（`QQ_PAUSE`），批次间休息 45 秒（`BATCH_PAUSE`），降低站点风控风险（本批最后一个 QQ 不额外休息，最后一批后不休息）
- **保护逻辑**：需登录/需验证码（站点级封禁）会立即中止；连续 2 个 QQ 失败也会中止，避免风控升级（成功一次即清零连续失败计数；「今日已领过」算成功，不计入失败）
- **日志脱敏**：QQ 号只显示前 4 位（如 `1234****`），仅影响日志，请求里仍发送完整 QQ 号
- **排障**：若本地启动报浏览器版本不匹配错误，可设 `CHROME_EXECUTABLE` 指向具体浏览器路径（正常使用无需设置）
- 请遵守网站使用条款

---

**⭐ 喜欢这个项目？**

如果这个项目对你有帮助，请点个 **Star** 支持一下！你的支持是持续维护的动力。

## License

MIT
