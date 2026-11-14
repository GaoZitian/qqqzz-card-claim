#!/usr/bin/env node
/**
 * qqqzz.cc 免费名片赞自动领取
 *
 * 站点: https://qqqzz.cc   (原 fk.555655.cn 已迁移至此)
 * 商品: 快刷名片赞100个     (id=83, price=0, login_required=0)
 *
 * 实测流程 (Playwright 真浏览器, 与真人点击路径完全一致):
 *   1. GET  https://qqqzz.cc/           -> 访问验证 meta-refresh 自动跟随, 无需干预
 *   2. 进   #/order-confirm/83          -> 商品页显示 "限时 免费"
 *   3. 填   input[placeholder=请输入QQ号码]
 *   4. 点   按钮 "免费领取"
 *      -> POST /api/PreviewPrice   {"is_free":true,"final_price":0}
 *      -> POST /api/add             {"code":200,"msg":"订单创建成功"}
 *
 * 用法（QQ_NUMBER 一律从环境变量读取，不走 CONFIG；**一次只跑 1 个 QQ 号**）:
 *   QQ_NUMBER=123456789 node claim.js              真实领取（单号）
 *   QQ_NUMBER=123456789 node claim.js --dry-run     演练到提交前, 不产生订单
 *   node claim.js                                   未设 QQ_NUMBER → 打印「跳过」并 exit 0（矩阵序号超配属正常）
 *
 * **为什么一次只跑 1 个号**：站点按「出口 IP + 会话」限额度（提示「名额不足」）。
 *   同一个 IP 连续领多个号，第 2 个起就会撞限额。GitHub Actions 矩阵模式每个 job 是
 *   独立虚拟机 = 独立出口 IP，所以多号在 Actions 里没问题；**本地是同一个 IP 同一个会话，
 *   跑多号必然撞限额**，因此本地限定一次 1 个号。要在本地连续领多个号，请分次运行、
 *   每次换一个 QQ 号，并留出站点的额度恢复窗口。
 *
 * GitHub Actions 矩阵模式: workflow 按 vars.QQ_IDX 展开多个 job（max-parallel:1 串行），
 *   每个 job 注入 QQ_NUMBER=secrets.QQ_NUMBER_{matrix.idx}（独立虚拟机 = 独立出口 IP，避开「名额不足」限流），
 *   并传 QQ_IDX=<序号> 用于结果文件命名（result-<序号>.json）和日志标识。
 *
 * 退出码: 0 领取成功/今日已领过/未配置 QQ_NUMBER(跳过)  1 领取失败/额度限制或配置错
 *          2 需登录  3 需验证码  10 异常
 *
 * 推送: PUSH_MODE=none 时不推送，只写结果文件（RESULT_DIR/result-<QQ_IDX>.json），
 *       交由 GitHub Actions 的 aggregate 汇总 job 合并成一条消息推送（见 aggregate.js）。
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('./config');
const { createNotifier } = require('./notify');
const { buildReport, meta } = require('./report');

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1';

const SITE = 'https://qqqzz.cc';
const GOODS_ID = 83;

const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================
// 统一配置
//
//   QQ_NUMBER 不走 CONFIG：一律从环境变量读取（**一次只跑 1 个号**）
//     - 本地: export QQ_NUMBER=123456789
//     - GitHub Actions: workflow 注入 secrets.QQ_NUMBER_{matrix.idx}（每个号一个 Secret）
//
//   方式 A（推荐）：GitHub Secret 只配一个 CONFIG，内容为 JSON（不含 QQ_NUMBER）：
//     CONFIG='{"TELEGRAM_BOT_TOKEN":"",
//              "TELEGRAM_CHAT_ID":"","WXPUSH_URL":"","WXPUSH_TOKEN":"",
//              "WXPUSH_USERID":"","WXPUSH_TEMPLATE_ID":"","WXPUSH_BASE_URL":""}'
//
//   方式 B（本地调试方便）：不配 CONFIG，改为逐个设置同名环境变量
//
//   注意：CONFIG 存在时，方式 B 的同名环境变量会被**完全忽略**（不会合并覆盖）。
//
//   原来的 BATCH_SIZE / QQ_PAUSE / BATCH_PAUSE / FAIL_STOP 是「一次跑多个 QQ」专用的分批参数，
//   本地已改为一次只跑 1 个号，这 4 项已全部移除（配置里写了也不再生效）。
// ============================================================
const CONFIG = loadConfig();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 通知配置（全部可选；未配置则只打印预览）
//   TELEGRAM_BOT_TOKEN  Telegram bot token
//   TELEGRAM_CHAT_ID    Telegram 目标 chat id
//   WXPUSH_URL          wxpush Worker 基础地址（不含 /wxsend，代码自动拼接）
//                       项目：https://github.com/frankiejun/wxpush
//   WXPUSH_TOKEN        wxpush 部署时设置的 API_TOKEN
//   WXPUSH_USERID       可选，覆盖默认接收用户（多个 OpenID 用半角 | 分隔）
//   WXPUSH_TEMPLATE_ID  可选，覆盖默认模板 ID
//   WXPUSH_BASE_URL     可选，覆盖点击消息后的跳转地址
// ============================================================
const notifier = createNotifier(CONFIG);

/** 脱敏 QQ：只显示前 4 位，其余用 * 代替（不泄露完整号码） */
function maskQQ(q) {
    return String(q).replace(/^(.{4}).*$/, '$1****');
}

/**
 * 写领取结果文件（供 GitHub Actions 汇总 job 合并成一条消息推送）
 *
 * 文件名：result-<序号>.json（序号来自 QQ_IDX 环境变量；没有则用 matrix-index / 0）
 * 内容：{ idx, results: [{ qq(脱敏), status, code, msg }], stopReason, stopCode, unprocessed }
 *
 * 只有设置了 RESULT_DIR（或默认 ./results 目录可写）时才写；写失败不影响退出码。
 */
function writeResultFile(results, opts = {}) {
    const dir = (process.env.RESULT_DIR || './results').trim();
    let idx = (process.env.QQ_IDX || process.env.MATRIX_INDEX || '').trim();
    if (!/^\d+$/.test(idx)) idx = '0';
    try {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `result-${idx}.json`);
        const payload = {
            idx: Number(idx),
            results: results.map((r) => ({
                qq: r.qqMask || maskQQ(r.qq),
                status: r.status || 'failed',
                code: r.code,
                msg: r.msg || '',
            })),
            stopReason: opts.stopReason || '',
            stopCode: opts.stopCode || 0,
            unprocessed: opts.unprocessed || 0,
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
        return file;
    } catch (e) {
        console.error(`⚠️ 写结果文件失败（不影响领取结果）：${e.message}`);
        return null;
    }
}

/** 在 ms-playwright 缓存里找一个可用的 chromium 可执行文件 */
function findChrome() {
    const envPath = process.env.CHROME_EXECUTABLE;
    if (envPath && fs.existsSync(envPath)) return envPath;

    const roots = [
        process.env.PLAYWRIGHT_BROWSERS_PATH,
        path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
        path.join(os.homedir(), '.cache', 'ms-playwright'),
    ].filter(Boolean);

    for (const root of roots) {
        let dirs;
        try { dirs = fs.readdirSync(root); } catch (_) { continue; }
        for (const d of dirs) {
            if (!d.startsWith('chromium')) continue;
            const base = path.join(root, d);
            const candidates = [
                path.join(base, 'chrome-mac-arm64',
                    'Google Chrome for Testing.app', 'Contents', 'MacOS',
                    'Google Chrome for Testing'),
                path.join(base, 'chrome-mac',
                    'Google Chrome for Testing.app', 'Contents', 'MacOS',
                    'Google Chrome for Testing'),
                path.join(base, 'chrome-linux', 'headless_shell'),
                path.join(base, 'chrome-linux', 'chrome'),
                path.join(base, 'chrome-linux64', 'chrome'),
                path.join(base, 'chrome-win', 'chrome.exe'),
                path.join(base, 'chrome-headless-shell-mac-arm64',
                    'chrome-headless-shell'),
                path.join(base, 'chrome-headless-shell-linux64',
                    'chrome-headless-shell'),
            ];
            for (const c of candidates) {
                if (fs.existsSync(c)) return c;
            }
        }
    }
    return null;
}

async function main() {
    // QQ_NUMBER 一律从环境变量读取（不走 CONFIG）：本地 export；Actions 由 workflow 按 matrix 序号注入。
    // **一次只跑 1 个号**：站点按 IP/会话限额度，同 IP 连续领多个号从第 2 个起就会「名额不足」。
    const qq = (process.env.QQ_NUMBER || '').trim();
    if (!qq) {
        const idx = (process.env.QQ_IDX || process.env.GH_MATRIX_IDX || '').trim();
        if (idx) {
            console.log(`⏭️ QQ_NUMBER_${idx} 未配置（矩阵序号 ${idx} 没有对应的 Secret），跳过该号`);
        } else {
            console.log('⏭️ 未配置 QQ_NUMBER，跳过（本地调试请 export QQ_NUMBER=123456789，一次一个）');
        }
        process.exit(0);
    }
    // 只接受单个 QQ 号；带竖线 | 一律拒绝并提示原因（避免本地同 IP 连撞限额）
    if (qq.includes('|')) {
        console.error('❌ QQ_NUMBER 只能填 1 个 QQ 号（一次只跑 1 个号），检测到竖线 | 多号写法：', qq);
        console.error('   原因：站点按「出口 IP + 会话」限额度，同一个 IP 连续领多个号，第 2 个起就会「名额不足」。');
        console.error('   做法：要领多个号就分次运行、每次换一个号（GitHub Actions 矩阵模式各 job 独立 IP，无此限制）。');
        process.exit(1);
    }
    if (!/^[1-9][0-9]{4,11}$/.test(qq)) {
        console.error('❌ QQ_NUMBER 格式不合法（5-12 位纯数字、首位不能为 0）:', qq);
        process.exit(1);
    }

    log(DRY_RUN ? '=== DRY-RUN: 不会真正提交订单 ===' : '=== 正式模式 ===');
    log('本次 QQ:', maskQQ(qq), '（一次只跑 1 个号）');

    const execPath = findChrome();
    const launchOpts = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };
    if (execPath) {
        launchOpts.executablePath = execPath;
        log('浏览器:', execPath);
    }

    const browser = await chromium.launch(launchOpts);
    let code = 10;

    try {
        const context = await browser.newContext({
            userAgent: UA,
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        });

        // --- 1. 首页: 等访问验证自然通过（用临时 page，验证后关闭）---
        const homePage = await context.newPage();
        log('步骤 1: 打开首页...');
        await homePage.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        let passed = false;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            const title = await homePage.title().catch(() => '');
            const blocked = title.includes('验证') || title.includes('稍候')
                || title.includes('Bad Gateway') || title.includes('502');
            if (title && !blocked) {
                passed = true;
                log(`   访问验证通过 (${i + 1}s), 标题: ${title}`);
                break;
            }
            if (i === 0) log('   等待访问验证...');
        }
        if (!passed) {
            throw new Error('访问验证未通过: ' + await homePage.title().catch(() => '?'));
        }
        await homePage.close();

        // --- 单号领取（一次只跑 1 个 QQ） ---
        const results = [];
        let stopReason = '';   // 中止原因（空 = 未中止）
        let stopCode = 0;      // 中止退出码
        {
            const page = await context.newPage();
            const api = { preview: null, add: null, addStatus: null };

            page.on('response', async (resp) => {
                const url = resp.url();
                try {
                    if (url.includes('/api/PreviewPrice')) {
                        api.preview = await resp.json();
                    } else if (url.includes('/api/add')) {
                        api.addStatus = resp.status();
                        api.add = await resp.json();
                    }
                } catch (_) { /* ignore non-json */ }
            });

            page.on('request', async (req) => {
                if (DRY_RUN && req.method() === 'POST' && req.url().includes('/api/add')) {
                    log('🛑 [DRY-RUN] 拦截 POST /api/add, 不提交');
                    log('   body:', req.postData());
                }
            });

            if (DRY_RUN) {
                await page.route('**/api/add', async (route) => {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            code: 200,
                            data: { id: 0, out_trade_no: 'DRY_RUN_NO_ORDER' },
                            msg: '订单创建成功(模拟未提交)',
                        }),
                    });
                });
            }

            log('\n════════════════════════════════════');
            const qqMask = maskQQ(qq);
            log('处理 QQ:', qqMask);
            log('════════════════════════════════════');

            // --- 2. 下单确认页 ---
            log('步骤 2: 进入下单确认页 #/order-confirm/' + GOODS_ID + '...');
            await page.goto(`${SITE}/#/order-confirm/${GOODS_ID}`,
                { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
            await sleep(2500);

            // --- 3. 填 QQ ---
            log('步骤 3: 填写 QQ 号...');
            const qqInput = page.locator('input[placeholder="请输入QQ号码"]').first();
            await qqInput.waitFor({ state: 'visible', timeout: 25000 });
            await qqInput.fill(qq);
            await sleep(800);

            // 触发一次价格预览, 确认商品仍免费
            await qqInput.blur().catch(() => {});
            await sleep(1500);
            if (api.preview) {
                log('   PreviewPrice:', JSON.stringify(api.preview.data || api.preview));
                const d = api.preview.data || {};
                if (d.is_free === false) {
                    throw new Error(`该商品已非免费 (final_price=${d.final_price}), 中止`);
                }
            }

            // --- 4. 点免费领取 ---
            log('步骤 4: 点击「免费领取」...');
            const claimBtn = page.locator('button', { hasText: '免费领取' }).first();
            await claimBtn.waitFor({ state: 'visible', timeout: 15000 });
            await sleep(400);
            await claimBtn.click({ force: true });

            // --- 5. 等结果 ---
            log('步骤 5: 等待服务器响应...');
            for (let i = 0; i < 30; i++) {
                await sleep(1000);
                if (api.add) break;
            }

            let pageText = '';
            try { pageText = await page.innerText('body'); } catch (_) {}

            log('\n--- PreviewPrice ---');
            log(api.preview ? JSON.stringify(api.preview, null, 1) : '(未捕获)');
            log('\n--- add ---');
            log(api.add ? JSON.stringify(api.add, null, 1) : '(未捕获)');

            // 判定（qqCode 用于退出码；status 用于文案区分：领取成功 / 今日已领过 / 额度限制…）
            // 额度限制可能出现在**任一阶段**：
            //   - PreviewPrice 阶段：「检查免费商品失败: 本商品可购买或领取的名额不足，请稍后重试」
            //   - /api/add 阶段：「名额不足」
            // 两个阶段都要查，否则会被误判成「领取失败」。
            const addMsg = api.add && api.add.msg ? String(api.add.msg) : '';
            const previewMsg = api.preview && api.preview.msg ? String(api.preview.msg) : '';
            const isQuota = addMsg.includes('名额不足') || previewMsg.includes('名额不足');
            let qqCode = 1;
            let qqStatus = 'failed';
            if (isQuota) {
                // 额度限制：站点会话/IP 短窗口额度已用尽（非风控、非每日一次）。
                // 优先于「成功」判定：PreviewPrice 阶段报名额不足时，后续 /api/add 不会真正下单，
                // 但页面上可能仍出现 add 的请求/响应，不能据此判成「领取成功」。
                qqCode = 1;
                qqStatus = 'quota';
                const quotaMsg = addMsg.includes('名额不足') ? addMsg : previewMsg;
                log(`\n⚠️ 额度限制  QQ=${qqMask}  ${quotaMsg}`);
                log('   （站点会话/IP 短窗口领取额度已用尽，非风控；矩阵模式下后续 job 会用新 IP）');
            } else if (api.add && (api.add.code === 200 || api.add.succ === 1)) {
                qqCode = 0;
                qqStatus = 'success';
                const d = api.add.data || {};
                const outNo = DRY_RUN ? '(dry-run, 未真实提交)' : (d.out_trade_no || '?');
                log(`\n✅ 领取成功  QQ=${qqMask}  订单id=${d.id ?? '?'}  out_trade_no=${outNo}`);
            } else if (addMsg.includes('已') && (addMsg.includes('领取') || addMsg.includes('下单') || addMsg.includes('购买'))) {
                qqCode = 0;
                qqStatus = 'already';
                log(`\n⏭️ 今日已领过  QQ=${qqMask}  ${addMsg}`);
            } else if (addMsg.includes('登录') || (api.add && api.add.code === 4)) {
                qqCode = 2;
                qqStatus = 'login';
                log(`\n🔒 需要登录  QQ=${qqMask}  ${addMsg || 'code=4'}`);
            } else if (addMsg.includes('验证') || addMsg.includes('验证码') || (api.add && api.add.code === 2)) {
                qqCode = 3;
                qqStatus = 'captcha';
                log(`\n🔐 需要验证码  QQ=${qqMask}  ${addMsg || 'code=2'}`);
            } else if (pageText.includes('订单创建成功')) {
                qqCode = 0;
                qqStatus = 'success';
                log(`\n✅ 订单创建成功  QQ=${qqMask}  (页面确认)`);
            } else {
                qqCode = 1;
                qqStatus = 'failed';
                log(`\n❌ 领取失败  QQ=${qqMask}  ${addMsg || JSON.stringify(api.add) || '未捕获到结果'}`);
            }
            // msg 存「本次状态的原因」：额度限制取额度相关的消息（可能来自 PreviewPrice 阶段），
            // 其余状态取 /api/add 的消息；成功/已领过不需要额外说明，留空。
            let resultMsg = '';
            if (qqStatus === 'quota') {
                resultMsg = addMsg.includes('名额不足') ? addMsg : previewMsg;
            } else if (qqStatus !== 'success' && qqStatus !== 'already') {
                resultMsg = addMsg || '';
            }
            results.push({ qq, qqMask, code: qqCode, status: qqStatus, msg: resultMsg });
            // 关闭 page，释放资源
            await page.close().catch(() => {});
        }

        // 汇总
        const ok = results.filter((r) => r.code === 0).length;
        const fail = results.length - ok;
        const unprocessed = 0;   // 一次只跑 1 个号，不存在未处理的号
        log('\n════════ 汇总 ════════');
        for (const r of results) {
            const m = meta(r.status);
            log(`  ${m.mark} ${r.qqMask || maskQQ(r.qq)}  ${m.label}`);
        }
        if (stopReason) {
            log(`⚠️ 已中止：${stopReason}，${unprocessed} 个 QQ 未处理`);
            code = stopCode;
        } else if (fail === 0) {
            code = 0;
        } else {
            // 一次只跑 1 个号：保留具体退出码（2=需要登录 / 3=需要验证码 / 1=其它失败），
            // 便于调用方区分「要人工处理」和「普通失败」。
            const last = results[results.length - 1];
            code = (last && last.code) || 1;
        }

        // 写结果文件（供 GitHub Actions 汇总 job 合并成一条消息推送）
        const resultFile = writeResultFile(results, { stopReason, stopCode, unprocessed });
        if (resultFile) {
            log(`📄 结果已写入：${resultFile}`);
        }

        // 推送通知（Telegram + wxpush）
        // PUSH_MODE=none 时不推送（GitHub Actions 矩阵模式：worker 只写结果，由汇总 job 统一推一条）
        {
            const pushMode = (process.env.PUSH_MODE || 'all').trim().toLowerCase();
            if (pushMode === 'none' || pushMode === 'off' || pushMode === '0') {
                log('\n🔇 PUSH_MODE=none，本次不推送（结果已写文件，交由汇总 job 统一推送）');
            } else {
                const report = buildReport(
                    results.map((r) => ({ qq: r.qqMask || maskQQ(r.qq), status: r.status, msg: r.msg })),
                    { unprocessed, aborted: !!stopReason }
                );
                log('\n📤 推送通知...');
                await notifier.notify(report.title, report.text);
            }
        }
    } catch (e) {
        code = 10;
        console.error('\n❌ 流程异常:', e.message);
        try {
            const pushMode = (process.env.PUSH_MODE || 'all').trim().toLowerCase();
            if (pushMode !== 'none' && pushMode !== 'off' && pushMode !== '0') {
                await notifier.notify('🛑 名片赞领取异常', `流程异常：${e.message}`);
            }
        } catch (_) { /* 推送失败不影响退出码 */ }
    } finally {
        await browser.close();
    }

    process.exit(code);
}

main();