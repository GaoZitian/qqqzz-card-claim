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
3. 名称：`QQ_NUMBER`，值：你的 QQ 号
4. **Add secret**

### 第三步：启用 GitHub Actions

- Actions 默认每天自动运行
- 也可在 **Actions** → **免费名片赞自动领取** → **Run workflow** 手动触发

## 本地运行

```bash
npm install
npx playwright install chromium

QQ_NUMBER=123456789 node claim.js            # 真实领取
QQ_NUMBER=123456789 node claim.js --dry-run  # 演练：走到提交前拦截，不产生订单
```

可选环境变量：

| 变量 | 说明 |
| --- | --- |
| `QQ_NUMBER` | 必填，目标 QQ 号 |
| `CHROME_EXECUTABLE` | 指定 Chrome 可执行文件（本地缓存版本与 playwright-core 不匹配时用） |

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 / 今日已领过 |
| 1 | 领取失败 |
| 2 | 需要登录（站点策略变更） |
| 3 | 需要验证码（站点策略变更） |
| 10 | 流程异常 |

## 注意事项

- 站点下单页要求：**同一个 QQ 一次性下好数量**，且需开启「允许任何人赞我」
- 免费商品每天限领一次
- 若商品改为收费/需要登录，脚本会中止并在日志中说明
- 请遵守网站使用条款

## License

MIT
