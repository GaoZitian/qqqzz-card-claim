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
 * 用法（QQ_NUMBER 一律从环境变量读取，不走 CONFIG；多号用半角竖线 | 分隔；自动按 BATCH_SIZE 分批）:
 *   QQ_NUMBER=123456789 node claim.js              真实领取（单号）
 *   QQ_NUMBER=123456789|987654321 node claim.js    真实领取（多号，每个独立走流程）
 *   QQ_NUMBER=123456789 node claim.js --dry-run     演练到提交前, 不产生订单
 *   node claim.js                                   未设 QQ_NUMBER → 打印「跳过」并 exit 0（矩阵序号超配属正常）
 *
 * GitHub Actions 矩阵模式: workflow 按 vars.QQ_IDX 展开多个 job（max-parallel:1 串行），
 *   每个 job 注入 QQ_NUMBER=secrets.QQ_NUMBER_{matrix.idx}（独立虚拟机 = 独立出口 IP，避开「名额不足」限流），
 *   并传 GH_MATRIX_IDX=<序号> 用于日志标识。
 *
 * 退出码: 0 全部成功/已领过/未配置 QQ_NUMBER(跳过)  1 有失败或配置错  2 需登录(中止)  3 需验证码(中止)
 *          4 连续失败中止  10 异常
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1';

const SITE = 'https://qqqzz.cc';
const GOODS_ID = 83;

const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================
// 统一配置
//
//   QQ_NUMBER 不走 CONFIG：一律从环境变量读取
//     - 本地: export QQ_NUMBER=123456789
//     - GitHub Actions: workflow 注入 secrets.QQ_NUMBER_{matrix.idx}（每个号一个 Secret）
//
//   方式 A（推荐）：GitHub Secret 只配一个 CONFIG，内容为 JSON（不含 QQ_NUMBER）：
//     CONFIG='{"BATCH_SIZE":"3","QQ_PAUSE":"10",
//              "BATCH_PAUSE":"45","FAIL_STOP":"2","TELEGRAM_BOT_TOKEN":"",
//              "TELEGRAM_CHAT_ID":"","WXPUSH_URL":"","WXPUSH_TOKEN":"",
//              "WXPUSH_USERID":"","WXPUSH_TEMPLATE_ID":"","WXPUSH_BASE_URL":""}'
//
//   方式 B（本地调试方便）：不配 CONFIG，改为逐个设置同名环境变量
//
//   注意：CONFIG 存在时，方式 B 的同名环境变量会被**完全忽略**（不会合并覆盖）。
// ============================================================
const CONFIG_DEFAULTS = {
    BATCH_SIZE: '3',
    QQ_PAUSE: '10',
    BATCH_PAUSE: '45',
    FAIL_STOP: '2',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    WXPUSH_URL: '',
    WXPUSH_TOKEN: '',
    WXPUSH_USERID: '',
    WXPUSH_TEMPLATE_ID: '',
    WXPUSH_BASE_URL: '',
};

/** 读取统一配置：CONFIG 优先，缺失则回落逐个环境变量 */
function loadConfig() {
    const raw = (process.env.CONFIG || '').trim();
    if (!raw) {
        // 方式 B：逐个环境变量（本地调试）
        const cfg = { ...CONFIG_DEFAULTS };
        for (const key of Object.keys(CONFIG_DEFAULTS)) {
            const v = process.env[key];
            if (v !== undefined && v !== '') cfg[key] = String(v).trim();
        }
        return cfg;
    }
    // 方式 A：CONFIG JSON（唯一配置源）
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        console.error('\n❌ CONFIG 格式不正确，请检查 Secret 配置。');
        console.error('   要求：严格 JSON，双引号包裹字段和值，逗号不能多也不能少。');
        console.error('   解析错误：' + e.message);
        process.exit(1);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error('\n❌ CONFIG 必须是 JSON 对象（不能是数组或字符串）');
        process.exit(1);
    }
    // 迁移提醒：QQ_NUMBER 已移出 CONFIG（改从环境变量 / Secret QQ_NUMBER_N 读取）
    if (parsed.QQ_NUMBER !== undefined) {
        console.log('\n⚠️ CONFIG 里的 QQ_NUMBER 已不再读取（QQ 号改从环境变量注入，CONFIG 不含 QQ_NUMBER）。');
        console.log('   GitHub Actions 请把每个号配成 Secret QQ_NUMBER_1、QQ_NUMBER_2…；本地请 export QQ_NUMBER=...');
    }
    const cfg = { ...CONFIG_DEFAULTS };
    for (const [k, v] of Object.entries(parsed)) {
        if (v === null || v === undefined) continue;
        cfg[k] = String(v).trim();
    }
    // 冲突提醒：CONFIG 存在时，同名环境变量会被完全忽略（不合并），提醒用户避免误配
    const ignored = [];
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
        const envVal = (process.env[key] || '').trim();
        if (!envVal) continue;
        ignored.push(`${key}（环境变量=${envVal} → 实际生效=${cfg[key] || '默认值'}）`);
    }
    if (ignored.length > 0) {
        console.log('\n⚠️ 检测到 CONFIG 与环境变量同时配置，环境变量已被忽略（CONFIG 优先，不会合并）：');
        for (const item of ignored) console.log(`   - ${item}`);
        console.log('   建议只保留一种配置方式。');
    }
    return cfg;
}

const CONFIG = loadConfig();

// 保护参数（可由 CONFIG 覆盖）：
//   注意：这 4 项只在「一次运行多个 QQ」时生效（本地 QQ_NUMBER 用 | 分隔多号）。
//         GitHub 矩阵模式每个 job 只跑 1 个号 → 分批/批内休息/批间休息/连续失败计数都用不到。
//         例外：FAIL_STOP=1 时单号失败也会立即中止（退出码 4）。
//   BATCH_SIZE   每批领取的 QQ 数，默认 3（主动分批降低风控）
//   QQ_PAUSE     批次内 QQ 之间休息秒数，默认 10
//   BATCH_PAUSE  批次间休息秒数，默认 45
//   FAIL_STOP    连续失败 N 个即中止（防风控升级）
const BATCH_SIZE = parseInt(CONFIG.BATCH_SIZE, 10) || 3;
const QQ_PAUSE = parseInt(CONFIG.QQ_PAUSE, 10) || 10;
const BATCH_PAUSE = parseInt(CONFIG.BATCH_PAUSE, 10) || 45;
const FAIL_STOP = parseInt(CONFIG.FAIL_STOP, 10) || 2;

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
const TG_BOT_TOKEN = CONFIG.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = CONFIG.TELEGRAM_CHAT_ID;
const WXPUSH_URL = CONFIG.WXPUSH_URL.replace(/\/+$/, '');
const WXPUSH_TOKEN = CONFIG.WXPUSH_TOKEN;
const WXPUSH_USERID = CONFIG.WXPUSH_USERID;
const WXPUSH_TEMPLATE_ID = CONFIG.WXPUSH_TEMPLATE_ID;
const WXPUSH_BASE_URL = CONFIG.WXPUSH_BASE_URL;

/** Telegram 推送 */
async function tgSend(title, text) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log(`\n📣 推送预览（未配置 Telegram）\n【${title}】\n${text}\n`);
        return;
    }
    try {
        const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: `【${title}】\n${text}`,
                disable_web_page_preview: true,
            }),
        });
        const j = await r.json().catch(() => ({}));
        log('Telegram 推送:', j.ok ? '成功' : `失败 ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) {
        log('Telegram 推送异常:', e.message);
    }
}

/** wxpush 微信推送（与 Telegram 独立，可同时启用） */
async function wxpushSend(title, text) {
    if (!WXPUSH_URL || !WXPUSH_TOKEN) {
        log(`\n📣 推送预览（未配置 wxpush）\n【${title}】\n${text}\n`);
        return;
    }
    try {
        const params = new URLSearchParams({ token: WXPUSH_TOKEN, title, content: text });
        if (WXPUSH_USERID) params.set('userid', WXPUSH_USERID);
        if (WXPUSH_TEMPLATE_ID) params.set('template_id', WXPUSH_TEMPLATE_ID);
        if (WXPUSH_BASE_URL) params.set('base_url', WXPUSH_BASE_URL);
        const r = await fetch(`${WXPUSH_URL}/wxsend?${params.toString()}`, { method: 'GET' });
        const body = await r.text().catch(() => '');
        const ok = r.status === 200 && body.includes('Successfully sent');
        log('wxpush 推送:', ok ? '成功' : `失败 HTTP ${r.status} ${body.slice(0, 200)}`);
    } catch (e) {
        log('wxpush 推送异常:', e.message);
    }
}

/** 统一通知入口：Telegram + wxpush 双通道（各自独立，未配置则只打印预览） */
async function notify(title, text) {
    await tgSend(title, text);
    await wxpushSend(title, text);
}

/** 脱敏 QQ：只显示前 4 位，其余用 * 代替（不泄露完整号码） */
function maskQQ(q) {
    return String(q).replace(/^(.{4}).*$/, '$1****');
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
    // 多号：QQ1|QQ2|QQ3（竖线分隔），每个 QQ 独立走完整流程（仅本地多号场景；矩阵模式每个 job 只有一个号）
    const raw = (process.env.QQ_NUMBER || '').trim();
    if (!raw) {
        const idx = (process.env.GH_MATRIX_IDX || '').trim();
        if (idx) {
            console.log(`⏭️ QQ_NUMBER_${idx} 未配置（矩阵序号 ${idx} 没有对应的 Secret），跳过该号`);
        } else {
            console.log('⏭️ 未配置 QQ_NUMBER，跳过（本地调试请 export QQ_NUMBER=...）');
        }
        process.exit(0);
    }
    const qqs = raw.split('|').map((s) => s.trim()).filter(Boolean);
    if (qqs.length === 0) {
        console.error('❌ QQ_NUMBER 为空');
        process.exit(1);
    }
    for (const q of qqs) {
        if (!/^[1-9][0-9]{4,11}$/.test(q)) {
            console.error('❌ QQ_NUMBER 格式不合法:', q);
            process.exit(1);
        }
    }

    log(DRY_RUN ? '=== DRY-RUN: 不会真正提交订单 ===' : '=== 正式模式 ===');
    log('QQ 总数:', qqs.length, '→', qqs.map(maskQQ).join(' | '));
    // 分批信息：每批 BATCH_SIZE 个，批次间休息 BATCH_PAUSE 秒
    const totalBatches = Math.ceil(qqs.length / BATCH_SIZE);
    log(`分批: ${totalBatches} 批 × 每批 ${BATCH_SIZE} 个，批次间休息 ${BATCH_PAUSE}s`);

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

        // --- 主动分批：每批 BATCH_SIZE 个，批次间休息 BATCH_PAUSE 秒 ---
        const results = [];
        let stopReason = '';   // 中止原因（空 = 未中止）
        let stopCode = 0;      // 中止退出码
        let consecFail = 0;    // 连续失败计数
        let stopped = false;   // 是否已中止（用于跳出所有批次）
        const batches = [];
        for (let i = 0; i < qqs.length; i += BATCH_SIZE) {
            batches.push(qqs.slice(i, i + BATCH_SIZE));
        }
        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            log(`\n═══ 第 ${b + 1}/${batches.length} 批（${batch.length} 个 QQ）═══`);
            for (const qq of batch) {
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

            // 判定（每个 QQ 独立，结果累计；每行带 QQ 标识避免歧义）
            const addMsg = api.add && api.add.msg ? String(api.add.msg) : '';
            let qqCode = 1;
            if (api.add && (api.add.code === 200 || api.add.succ === 1)) {
                qqCode = 0;
                const d = api.add.data || {};
                const outNo = DRY_RUN ? '(dry-run, 未真实提交)' : (d.out_trade_no || '?');
                log(`\n✅ 领取成功  QQ=${qqMask}  订单id=${d.id ?? '?'}  out_trade_no=${outNo}`);
            } else if (addMsg.includes('已') && (addMsg.includes('领取') || addMsg.includes('下单') || addMsg.includes('购买'))) {
                qqCode = 0;
                log(`\n⚠️ 今日已领过  QQ=${qqMask}  ${addMsg}`);
            } else if (addMsg.includes('名额不足')) {
                // 站点会话/IP 短窗口领取额度限流（非风控、非每日一次）；矩阵模式下后续 job 会用新 IP
                qqCode = 1;
                log(`\n⚠️ 额度限制  QQ=${qqMask}  ${addMsg}`);
                log('   （站点会话/IP 短窗口领取额度已用尽，非风控；矩阵模式下后续 job 会用新 IP）');
            } else if (addMsg.includes('登录') || (api.add && api.add.code === 4)) {
                qqCode = 2;
                log(`\n🔒 需要登录  QQ=${qqMask}  ${addMsg || 'code=4'}`);
            } else if (addMsg.includes('验证') || addMsg.includes('验证码') || (api.add && api.add.code === 2)) {
                qqCode = 3;
                log(`\n🔐 需要验证码  QQ=${qqMask}  ${addMsg || 'code=2'}`);
            } else if (pageText.includes('订单创建成功')) {
                qqCode = 0;
                log(`\n✅ 订单创建成功  QQ=${qqMask}  (页面确认)`);
            } else {
                qqCode = 1;
                log(`\n❌ 领取失败  QQ=${qqMask}  ${addMsg || JSON.stringify(api.add) || '未捕获到结果'}`);
            }
            results.push({ qq, code: qqCode, msg: addMsg || '' });
            // 关闭本 QQ 的 page，避免多号时资源堆积
            await page.close().catch(() => {});

            // 防线 3: 站点级封禁（需登录/需验证码）→ 立即中止，不再发请求
            if (qqCode === 2 || qqCode === 3) {
                stopReason = qqCode === 2
                    ? '需要登录（站点级封禁）'
                    : '需要验证码（站点级封禁）';
                stopCode = qqCode;
                log(`\n🛑 已中止：${stopReason}，剩余 ${qqs.length - results.length} 个 QQ 未处理`);
                stopped = true;
                break;
            }
            // 防线 4: 连续失败 → 中止（防风控升级）
            if (qqCode === 0) {
                consecFail = 0;
            } else if (addMsg.includes('名额不足')) {
                // 额度限制（非风控）不计入连续失败，避免同一 IP 连续限流被误判为风控中止
            } else {
                consecFail += 1;
                if (consecFail >= FAIL_STOP) {
                    stopReason = `连续 ${consecFail} 个 QQ 失败（疑似风控）`;
                    stopCode = 4;
                    log(`\n🛑 已中止：${stopReason}，剩余 ${qqs.length - results.length} 个 QQ 未处理`);
                    stopped = true;
                    break;
                }
            }
            // 批次内 QQ 之间休息（本批最后一个 QQ 不休息，交给批间休息）
            const idxInBatch = batch.indexOf(qq);
            if (idxInBatch < batch.length - 1) {
                log(`⏳ 批次内休息 ${QQ_PAUSE}s（下一个 QQ）...`);
                await sleep(QQ_PAUSE * 1000);
            }
            } // 内层 for

            // 批间休息：未中止且非最后一批才休息
            if (stopped) break;
            if (b < batches.length - 1) {
                log(`\n⏳ 批次间休息 ${BATCH_PAUSE}s（第 ${b + 1} 批完成，还剩 ${batches.length - b - 1} 批）...`);
                await sleep(BATCH_PAUSE * 1000);
            }
        } // 外层 for

        // 汇总
        const ok = results.filter((r) => r.code === 0).length;
        const fail = results.length - ok;
        const unprocessed = qqs.length - results.length;
        log('\n════════ 汇总 ════════');
        log(`成功/已领过: ${ok}  失败: ${fail}  共 ${results.length} 个 QQ`);
        for (const r of results) {
            const mark = r.code === 0 ? '✅' : (r.code === 1 ? '❌' : (r.code === 2 ? '🔒' : '🔐'));
            log(`  ${mark} ${maskQQ(r.qq)} (code=${r.code})`);
        }
        if (stopReason) {
            log(`⚠️ 已中止：${stopReason}，${unprocessed} 个 QQ 未处理`);
            code = stopCode;
        } else if (fail === 0) {
            code = 0;
        } else {
            code = 1;
        }

        // 推送通知（Telegram + wxpush）
        {
            const title = code === 0
                ? '✅ 名片赞领取完成'
                : (code === 1 ? '⚠️ 名片赞领取部分失败' : `🛑 名片赞领取中止（code=${code}）`);
            const lines = [];
            for (const r of results) {
                const mark = r.code === 0 ? '✅' : (r.code === 1 ? '❌' : (r.code === 2 ? '🔒' : '🔐'));
                const suffix = r.code === 0 ? '成功/已领过' : (r.msg || `code=${r.code}`);
                lines.push(`${mark} ${maskQQ(r.qq)}  ${suffix}`);
            }
            if (unprocessed > 0) lines.push(`⏭️ 未处理 ${unprocessed} 个 QQ`);
            const text = lines.join('\n');
            log('\n📤 推送通知...');
            await notify(title, text);
        }
    } catch (e) {
        code = 10;
        console.error('\n❌ 流程异常:', e.message);
        try {
            await notify('🛑 名片赞领取异常', `流程异常：${e.message}`);
        } catch (_) { /* 推送失败不影响退出码 */ }
    } finally {
        await browser.close();
    }

    process.exit(code);
}

main();