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
 * 用法（QQ_NUMBER 支持多号，用半角竖线 | 分隔；自动按 BATCH_SIZE 分批，批次间休息 BATCH_PAUSE 秒）:
 *   QQ_NUMBER=123456789 node claim.js              真实领取（单号）
 *   QQ_NUMBER=123456789|987654321 node claim.js    真实领取（多号，每个独立走流程）
 *   QQ_NUMBER=123456789 node claim.js --dry-run     演练到提交前, 不产生订单
 *
 * 退出码: 0 全部成功/已领过  1 有失败  2 需登录(中止)  3 需验证码(中止)
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
// 保护参数（环境变量可覆盖）：
//   BATCH_SIZE   每批领取的 QQ 数，默认 3（主动分批降低风控）
//   QQ_PAUSE     批次内 QQ 之间休息秒数，默认 10
//   BATCH_PAUSE  批次间休息秒数，默认 45
//   FAIL_STOP    连续失败 N 个即中止（防风控升级）
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '3', 10) || 3;
const QQ_PAUSE = parseInt(process.env.QQ_PAUSE || '10', 10) || 10;
const BATCH_PAUSE = parseInt(process.env.BATCH_PAUSE || '45', 10) || 45;
const FAIL_STOP = parseInt(process.env.FAIL_STOP || '2', 10) || 2;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    // QQ_NUMBER 支持多号：QQ1|QQ2|QQ3（竖线分隔），每个 QQ 独立走完整流程
    const raw = (process.env.QQ_NUMBER || '').trim();
    if (!raw) {
        console.error('❌ 缺少环境变量 QQ_NUMBER');
        process.exit(1);
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
            results.push({ qq, code: qqCode });
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
    } catch (e) {
        code = 10;
        console.error('\n❌ 流程异常:', e.message);
    } finally {
        await browser.close();
    }

    process.exit(code);
}

main();