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
 * 用法:
 *   QQ_NUMBER=123456789 node claim.js              真实领取
 *   QQ_NUMBER=123456789 node claim.js --dry-run     演练到提交前, 不产生订单
 *
 * 退出码 img: 0 成功/已领过  1 失败  2 需登录  3 需验证码  10 异常
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

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const qq = (process.env.QQ_NUMBER || '').trim();
    if (!qq) {
        console.error('❌ 缺少环境变量 QQ_NUMBER');
        process.exit(1);
    }
    if (!/^[-model 1-9][0-9]{4,11}$/.test(qq)) {
        console.error('❌ QQ_NUMBER 格式不合法:', qq);
        process.exit(1);
    }

    log(DRY_RUN ? '=== DRY-RUN: 不会真正提交订单 ===' : '=== 正式模式 ===');
    log('QQ:', qq.replace(/^(.).*$/, '$1********'));

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

        // --- 1. 首页: 等访问验证自然通过 ---
        log('步骤 1: 打开首页...');
        await page.goto(SITE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        let passed = false;
        for (let i = 0; i < 15; i++) {
            await sleep(1000);
            const title = await page.title().catch(() => '');
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
            throw new Error('访问验证未通过: ' + await page.title().catch(() => '?'));
        }

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
        for (let i = 0; i < 20; i++) {
            await sleep(1000);
            if (api.add) break;
        }

        let pageText = '';
        try { pageText = await page.innerText('body'); } catch (_) {}

        log('\n--- PreviewPrice ---');
        log(api.preview ? JSON.stringify(api.preview, null, 1) : '(未捕获)');
        log('\n--- add ---');
        log(api.add ? JSON.stringify(api.add, null, 1) : '(未捕获)');

        // 判定
        const addMsg = api.add && api.add.msg ? String(api.add.msg) : '';

        if (api.add && (api.add.code === 200 || api.add.succ === 1)) {
            const d = api.add.data || {};
            code = 0;
            const outNo = DRY_RUN ? '(dry-run, 未真实提交)' : (d.out_trade_no || '?');
            log(`\n✅ 领取成功  订单id=${d.id ?? '?'}  out_trade_no=${outNo}`);
        } else if (addMsg.includes('已') && (addMsg.includes('领取') || addMsg.includes('下单') || addMsg.includes('购买'))) {
            code = 0;
            log(`\n⚠️ 今日已领过: ${addMsg}`);
        } else if (addMsg.includes('登录') || (api.add && api.add.code === 4)) {
            code = 2;
            log(`\n🔒 需要登录: ${addMsg || 'code=4'}`);
        } else if (addMsg.includes('验证') || addMsg.includes('验证码') || (api.add && api.add.code === 2)) {
            code = 3;
            log(`\n🔐 需要验证码: ${addMsg || 'code=2'}`);
        } else if (pageText.includes('订单创建成功')) {
            code = 0;
            log('\n✅ 订单创建成功 (页面确认)');
        } else {
            code = 1;
            log('\n❌ 领取失败:', addMsg || JSON.stringify(api.add) || '未捕获到结果');
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