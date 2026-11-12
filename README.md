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

## 快速开始

### 第一步：Fork 本仓库

1. 进入仓库主页，点击右上角 **Fork**
2. 进入你 Fork 后的仓库

### 第二步：设置 QQ 号（Repository Secret）

1. **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. 名称：`QQ_NUMBER`，值：你的 QQ 号（支持多号，用**半角竖线 `|` 分隔**，如 `123456789|987654321`）
4. **Add secret**

> 多号时每个 QQ 独立走完整流程（进下单页 → 填号 → 点免费领取 → 等结果），互不影响；单个 QQ 失败不阻断其余 QQ。
> 每个 QQ 使用独立浏览器页签 + 独立响应捕获，响应不会串号；日志每条判定都带 `QQ=xxxxxx` 标识。

### 第三步：启用 GitHub Actions

- Actions 默认每天自动运行
- 也可在 **Actions** → **免费名片赞自动领取** → **Run workflow** 手动触发

## 本地运行

```bash
npm install
npx playwright install chromium

QQ_NUMBER=123456789 node claim.js            # 真实领取（单号）
QQ_NUMBER=123456789|987654321 node claim.js  # 真实领取（多号，竖线分隔）
QQ_NUMBER=123456789 node claim.js --dry-run  # 演练：走到提交前拦截，不产生订单
```

可选环境变量：

| 变量 | 说明 |
| --- | --- |
| `QQ_NUMBER` | 必填，目标 QQ 号（支持多号，半角竖线 `\|` 分隔，每个独立领取） |
| `QQ_PAUSE` | 可选，批次内 QQ 之间休息秒数，默认 10 |
| `BATCH_SIZE` | 可选，每批领取的 QQ 数，默认 3（主动分批，降低风控） |
| `BATCH_PAUSE` | 可选，批次间休息秒数，默认 45 |
| `FAIL_STOP` | 可选，连续失败 N 个即中止，默认 2（防风控升级） |

> **分批说明**：脚本自动按 `BATCH_SIZE`（默认 3）分批；**批次内**每个 QQ 之间休息 `QQ_PAUSE`（默认 10 秒），**批次之间**休息 `BATCH_PAUSE`（默认 45 秒），降低站点风控风险。单个 QQ 失败不中断其余 QQ。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 全部成功 / 今日已领过 |
| 1 | 已跑完，但有 QQ 领取失败 |
| 2 | 需要登录（站点级封禁，已中止剩余 QQ） |
| 3 | 需要验证码（站点级封禁，已中止剩余 QQ） |
| 4 | 连续失败中止（疑似风控） |
| 10 | 流程异常 |

## 注意事项

- 站点下单页要求：**同一个 QQ 一次性下好数量**，且需开启「允许任何人赞我」
- 免费商品每天限领一次
- 若商品改为收费/需要登录，脚本会中止并在日志中说明
- **自动分批**：每批 3 个（`BATCH_SIZE`）；批次内 QQ 之间休息 10 秒（`QQ_PAUSE`），批次间休息 45 秒（`BATCH_PAUSE`），降低站点风控风险
- **保护逻辑**：需登录/需验证码（站点级封禁）会立即中止；连续 2 个 QQ 失败也会中止，避免风控升级
- **排障**：若本地启动报浏览器版本不匹配错误，可设 `CHROME_EXECUTABLE` 指向具体浏览器路径（正常使用无需设置）
- 请遵守网站使用条款

---

**⭐ 喜欢这个项目？**

如果这个项目对你有帮助，请点个 **Star** 支持一下！你的支持是持续维护的动力。

## License

MIT
