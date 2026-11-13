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

> GitHub 上多号用**矩阵**实现（每个 job 一个独立虚拟机 = 独立出口 IP，串行执行），每个 job 只领 1 个号；分批休息、连续失败计数这类**多号保护参数只在本地多号调试时用得上**，GitHub 不需要配。

## 快速开始

### 第一步：Fork 本仓库

1. 进入仓库主页，点击右上角 **Fork**
2. 进入你 Fork 后的仓库

### 第二步：配置仓库（Settings → Secrets and variables → Actions）

打开 **Settings** → **Secrets and variables** → **Actions**，页面顶部有两个 tab：**Secrets** 和 **Variables**。**配置速查表**先看清哪个进哪个 tab：

<table>
<thead>
<tr>
<th width="120">配置</th>
<th width="120">放哪个 Tab</th>
<th width="70">必填</th>
<th width="480">内容</th>
</tr>
</thead>
<tbody>
<tr><td><code>QQ_NUMBER_N</code></td><td><strong>Secrets</strong></td><td>✅</td><td>每个 QQ 号一个 Secret（N=1,2,3…），5-12 位纯数字、首位不能为 0</td></tr>
<tr><td><code>QQ_IDX</code></td><td><strong>Variables</strong></td><td>✅</td><td>JSON 序号数组，如 <code>[1,2,3]</code>，控制跑哪几个号</td></tr>
<tr><td><code>CONFIG</code></td><td><strong>Secrets</strong></td><td>可选</td><td>推荐方式：一个 JSON 装<b>全部</b>通知项（Telegram + wxpush），见下方「配置通知」；<b>不含 QQ_NUMBER</b></td></tr>
<tr><td><code>TELEGRAM_*</code><br><code>WXPUSH_*</code></td><td><strong>Secrets</strong></td><td>可选</td><td>兼容方式：每个通知项<b>单独</b>建同名 Secret（<code>TELEGRAM_BOT_TOKEN</code>、<code>WXPUSH_URL</code> 等 7 个），效果同 CONFIG</td></tr>
</tbody>
</table>

> **为什么必须分两个 tab**：QQ 号是敏感值，只能放 **Secrets**（加密存储，workflow 用 `secrets.XXX` 读）；`QQ_IDX` 是明文变量，workflow 用它做矩阵展开（`fromJSON(vars.QQ_IDX)`），**只能读 `vars`、读不了 `secrets`**，所以必须放 **Variables**。反过来 QQ 号也不能放 Variables（会明文暴露）。
> **通知项两种方式二选一**：`CONFIG`（一个 JSON 装全部）与 `TELEGRAM_*`/`WXPUSH_*`（逐个单独 Secret）**不要同时用**——`CONFIG` 存在时，逐个同名 Secret 会被**完全忽略**（不会合并覆盖，日志开头有 `⚠️` 提醒）。推荐用 `CONFIG`。

**1. QQ 号（每个号一个 Secret）**

1. **Secrets** tab → **New repository secret**，逐个创建：
   - `QQ_NUMBER_1` = 第一个 QQ 号
   - `QQ_NUMBER_2` = 第二个 QQ 号
   - …以此类推（一个号一个 Secret，序号从 1 开始）
2. QQ 号必须 5-12 位纯数字、首位不能是 0

**2. 序号（仓库变量 `QQ_IDX`）**

1. 同一页面切到 **Variables** tab → **New repository variable**
2. Name：`QQ_IDX`，Value：`[1,2,3]`（要跑几个号就写几个序号）
3. 以后加号 / 减号，只改这里的 `QQ_IDX` + 加/减对应 `QQ_NUMBER_N` Secret，**不用改代码、不用改 workflow 文件**

**3. 统一配置（`CONFIG`，可选）**

1. **Secrets** tab → **New repository secret**，名称 `CONFIG`，值：一整段 JSON（见下方模板）

**推荐：一个 `CONFIG` 统一配置**。JSON 里**只放通知项**（Telegram / wxpush），值全部用**双引号**：

```json
{
  "TELEGRAM_BOT_TOKEN": "",
  "TELEGRAM_CHAT_ID": "",
  "WXPUSH_URL": "",
  "WXPUSH_TOKEN": "",
  "WXPUSH_USERID": "",
  "WXPUSH_TEMPLATE_ID": "",
  "WXPUSH_BASE_URL": ""
}
```

> **注意：`CONFIG` 里不含 `QQ_NUMBER`**。QQ 号一律通过 `QQ_NUMBER_N` Secret 注入（workflow 按序号动态读取）。JSON 的键**必须用双引号**；格式写错会直接报错退出（exit 1）。
> ⚠️ **GitHub 上不需要配 `BATCH_SIZE` / `QQ_PAUSE` / `BATCH_PAUSE` / `FAIL_STOP`**：每个 job 只领 1 个号，分批、休息、连续失败计数都触发不了；这 4 项只在**本地多号调试**时用得上（见「本地运行」）。
> 不想用 `CONFIG`？也可以把上面每个 key 单独建成同名 Secret（`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`WXPUSH_URL`、`WXPUSH_TOKEN`、`WXPUSH_USERID`、`WXPUSH_TEMPLATE_ID`、`WXPUSH_BASE_URL`），效果一致。**两种方式不要同时用**：`CONFIG` 存在时，逐个同名 Secret 会被**完全忽略**（不会合并覆盖，日志开头有 `⚠️` 提醒）。

**多号怎么跑**：workflow 按 `QQ_IDX` 序号展开成多个 job，**每个 job 一个独立虚拟机 = 独立出口 IP**，串行执行（`max-parallel: 1`）——绕开站点「同一会话/IP 短时间连续领免费商品会被限流（提示『名额不足』）」的限制。

> `QQ_IDX` 配了序号但**没有**对应 `QQ_NUMBER_N` Secret 时，该 job 打印「跳过」并以退出码 0 结束，**不会让整个 run 变红**。
> 每个 QQ 使用独立浏览器页签 + 独立响应捕获，响应不会串号；日志每条判定都带 `QQ=xxxxxx` 标识（QQ 号**只显示前 4 位**，其余用 `****` 代替，仅影响日志，请求里仍是完整 QQ 号）。

#### 配置通知（可选）

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

### 第三步：启用 GitHub Actions

1. **Actions** 页签 → 左侧 **免费名片赞自动领取（多号，独立IP）** → **Run workflow** 可手动触发
2. 默认每天自动运行（北京 00:05，即 UTC 16:05）

> 仓库配置已在**第二步**完成，此处**无需重复设置**。以后改 QQ 号数量，只需改 `QQ_IDX`（Variables）+ 加/减对应 `QQ_NUMBER_N`（Secrets）。

## 本地运行

先初始化（安装依赖 + 下载 Chromium 浏览器）：

```bash
npm run setup
```

> `npm run setup` = 安装依赖 + 下载 Playwright 的 Chromium 内核（首次运行前必须，之后可跳过）。

**QQ 号必填**，从环境变量读（多号用半角竖线 `|` 分隔，**仅本地多号调试**；GitHub 上每个 job 只注入一个号）：

```bash
export QQ_NUMBER='123456789|987654321'
```

> QQ 号必须 5-12 位纯数字、首位不能是 0，不合法直接报错退出（exit 1）。

**通知配置可选**，两种方式任选其一（通知项见上方「配置通知」表；`CONFIG` 优先且独占，两者不要同时用）：

```bash
# 方式一：统一 CONFIG（JSON，与 GitHub CONFIG Secret 同格式，只放通知项）
export CONFIG='{"TELEGRAM_BOT_TOKEN":"xxx","TELEGRAM_CHAT_ID":"xxx"}'

# 方式二：逐个环境变量
export TELEGRAM_BOT_TOKEN='xxx'
export WXPUSH_URL='https://your-worker.workers.dev'   # 不含 /wxsend，代码自动拼接
```

运行：

```bash
node claim.js            # 真实领取（多号，竖线分隔）
node claim.js --dry-run  # 演练：走到提交前拦截，不产生订单
```

### 多号保护参数（仅本地多号调试，GitHub 不需要）

| 参数 | 说明 |
|---|---|
| `BATCH_SIZE` | 每批几个 QQ，默认 3 |
| `QQ_PAUSE` | 批次内 QQ 之间休息秒数，默认 10 |
| `BATCH_PAUSE` | 批次间休息秒数，默认 45 |
| `FAIL_STOP` | 连续失败几个即中止，默认 2；设成 `1` 时单号失败也会立即中止（退出码 4） |

> **生效条件**：一次运行里跑**多个 QQ**（`QQ_NUMBER='QQ1|QQ2|QQ3'` 竖线多号）才用得到。GitHub 每个 job 只领 1 个号，用不到；GitHub 多号靠**矩阵独立 IP**（每个 job 一个独立虚拟机），不靠分批休息。
> **主动分批**：自动按 `BATCH_SIZE` 分批，批次内每个 QQ 之间休息 `QQ_PAUSE`，批次之间休息 `BATCH_PAUSE`（本批最后一个 QQ 不额外休息，最后一批后不休息），降低站点风控；单个 QQ 失败不中断其余 QQ。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 / 今日已领过 / 未配置 `QQ_NUMBER`（跳过，矩阵序号超配属正常） |
| 1 | 配置错误（`CONFIG` 格式错、QQ 号格式非法）或已跑完但有 QQ 领取失败 / 额度限制 |
| 2 | 需要登录（站点级封禁，已中止剩余 QQ） |
| 3 | 需要验证码（站点级封禁，已中止剩余 QQ） |
| 4 | 连续失败中止（疑似风控） |
| 10 | 流程异常（浏览器启动失败、访问验证未通过等） |

> exit 1 有两种来源：看日志开头是 `❌ CONFIG 格式不正确` / `❌ QQ_NUMBER 格式不合法` → 配置问题；否则是领取失败或额度限制。
> 未配置 `QQ_NUMBER` 时返回 exit 0（打印 `⏭️` 跳过），**不是** exit 1——因为矩阵模式序号超配是正常情况，不应让 run 变红。

## 注意事项

- 站点下单页要求：**同一个 QQ 一次性下好数量**，且需开启「允许任何人赞我」
- **站点限流**：同一出口 IP / 会话在短时间窗口内连续领取免费商品会提示「**名额不足**」——这是**额度限制**，不是风控、也不是「每天限领一次」。多号时务必用矩阵模式（每个 job 独立 IP），单号不受影响
- 若商品改为收费/需要登录，脚本会中止并在日志中说明
- **保护逻辑**：需登录/需验证码（站点级封禁）会立即中止；连续 2 个 QQ 失败也会中止，避免风控升级（成功一次即清零连续失败计数；「今日已领过」算成功，不计入失败；「名额不足」算失败但**不计入连续失败**，避免同一 IP 连续限流被误判为风控中止）
- **日志脱敏**：QQ 号只显示前 4 位（如 `1234****`），仅影响日志，请求里仍发送完整 QQ 号
- **排障**：若本地启动报浏览器版本不匹配错误，可设 `CHROME_EXECUTABLE` 指向具体浏览器路径（正常使用无需设置）
- 请遵守网站使用条款

---

**⭐ 喜欢这个项目？**

如果这个项目对你有帮助，请点个 **Star** 支持一下！你的支持是持续维护的动力。

## License

MIT
