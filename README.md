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

脚本内置保护：商品变为收费时中止；站点返回「需登录 / 需验证码」（站点级封禁）时立即中止；额度不足时识别为「额度限制」（不误报成失败）。

> **一次只跑 1 个 QQ 号**：站点按「出口 IP + 会话」限额度（提示「名额不足」）。同一个 IP 连续领多个号，第 2 个起就会撞限额。
> GitHub 上多号用**矩阵**实现（每个 job 一个独立虚拟机 = 独立出口 IP，串行执行），每个 job 只领 1 个号，所以不受这个限制；**本地是同一个 IP 同一个会话，因此本地也限定一次只跑 1 个号**。

> **推送只有一条**：矩阵里每个 job 只领取、不发消息（`PUSH_MODE=none`），结果写成 JSON 上传为 artifact；最后由 `aggregate` 汇总 job 合并成**一条**消息推送（Telegram + wxpush 各一条，各通道独立）。

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

**2. 序号（仓库变量 `QQ_IDX`）**

1. 同一页面切到 **Variables** tab → **New repository variable**
2. Name：`QQ_IDX`，Value：`[1,2,3]`（要跑几个号就写几个序号）
3. 以后加号 / 减号，只改这里的 `QQ_IDX` + 加/减对应 `QQ_NUMBER_N` Secret，**不用改代码、不用改 workflow 文件**

> `QQ_IDX` 配了序号但**没有**对应 `QQ_NUMBER_N` Secret 时，该 job 打印「跳过」并以退出码 0 结束，**不会让整个 run 变红**。

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

#### 配置通知（可选）

想让运行结果推送消息，填对应通知项即可（`CONFIG` 里填或建成同名 Secret 都行；两个通道**互相独立**，可只配一个，也可都配；都不配则只在 Actions 日志里看结果）：

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

1. **Actions** 页签 → 左侧 **免费名片赞自动领取** → **Run workflow** 可手动触发
2. 默认每天自动运行（北京 00:30，即 UTC 16:30）

## 本地运行

先初始化（安装依赖 + 下载 Chromium 浏览器）：

```bash
npm run setup
```

> `npm run setup` = 安装依赖 + 下载 Playwright 的 Chromium 内核（首次运行前必须，之后可跳过）。

**QQ 号必填**，从环境变量读，**一次只填 1 个号**：

```bash
export QQ_NUMBER='123456789'
```

> QQ 号必须 5-12 位纯数字、首位不能为 0，不合法直接报错退出（exit 1）。
> **不能填多个号**（`123456789|987654321` 会被直接拒绝并报错退出）：站点按「出口 IP + 会话」限额度，同一个 IP 连续领多个号，第 2 个起就会撞「名额不足」。要在本地连续领多个号，请**分次运行、每次换一个号**，并留出站点的额度恢复窗口；GitHub Actions 矩阵模式每个 job 独立 IP，没有这个限制。

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
npm start            # 真实领取（1 个号）
npm run dry-run      # 演练：走到提交前拦截，不产生订单
```

**每次运行推一条消息**：一个号一条消息，内容里逐项写明状态（`领取成功` / `今日已领过` / `额度限制` / `失败` 等），不会把「成功」和「已领过」混在一起。

本地只需要配上面那两个：`QQ_NUMBER`（必填）和通知配置（可选）。其余环境变量都是 GitHub Actions 内部用的，**本地不用设**。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 领取成功 / 今日已领过 / 未配置 `QQ_NUMBER`（跳过；矩阵序号超配属正常，不让 run 变红） |
| 1 | 配置错误（`CONFIG` 格式错、QQ 号格式非法）或该号领取失败 / 额度限制 |
| 2 | 需要登录（站点级封禁） |
| 3 | 需要验证码（站点级封禁） |
| 10 | 流程异常（浏览器启动失败、访问验证未通过等） |

> exit 1 有两种来源：看日志开头是 `❌ CONFIG 格式不正确` / `❌ QQ_NUMBER 格式不合法` → 配置问题；否则是领取失败或额度限制。

**汇总 job（`aggregate`）的退出码**：

| 码 | 含义 |
| --- | --- |
| 0 | 汇总完成，消息已推送成功（或所有通知通道都未配置，只打印了预览） |
| 1 | 汇总本身出错：**消息没发出去**（推送失败），或连预期序号列表都没有（`QQ_IDX` 变量缺失 / 格式错） |

> **某个 QQ 没领到，不会让 run 变红**——失败信号在**消息内容**里（逐号列出 `领取成功` / `今日已领过` / `额度限制` / `失败` 等状态）。run 变红只代表「你的通知没送到」这种真正需要修的故障。
> `aggregate` 用 `if: always()`，即使某个 matrix job 崩了也照样汇总推送；崩掉的序号会被标成 `❌ 序号 N 领取失败（序号 N 未返回结果）`。
> **所有领取 job 全崩时**（artifact 为空、结果目录不存在），`aggregate` 仍会正常汇总推送「全部序号领取失败」，自己**不会变红**——故障体现在消息里，不会淹没「消息发不出去」这个真正需要你动手的信号。

## 注意事项

- 站点下单页要求：**同一个 QQ 一次性下好数量**，且需开启「允许任何人赞我」
- **站点限流**：同一出口 IP / 会话在短时间窗口内连续领取免费商品会提示「**名额不足**」——这是**额度限制**，不是风控、也不是「每天限领一次」
- **额度限制的识别**：「名额不足」可能在 `PreviewPrice` 或 `/api/add` 任一阶段返回，两个阶段都会识别成「⚠️ 额度限制」，不会误报成「❌ 领取失败」
- **站点响应偏慢**：下单接口的响应可能延迟 10-20 秒才返回。脚本会等到拿到响应为止（最长等 60 秒）；若仍没收到，会明确报「未收到下单响应（站点响应超时）」——这时**服务端可能已经实际下单**，请到站点核对订单，避免重复领取
- **日志脱敏**：QQ 号只显示前 4 位（如 `1234****`），仅影响日志，请求里仍发送完整 QQ 号
- **排障**：若本地启动报浏览器版本不匹配错误，可设 `CHROME_EXECUTABLE` 指向具体浏览器路径（正常使用无需设置）
- 请遵守网站使用条款

---

**⭐ 喜欢这个项目？**

如果这个项目对你有帮助，请点个 **Star** 支持一下！你的支持是持续维护的动力。

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
