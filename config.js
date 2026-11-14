/**
 * 统一配置加载（CONFIG 优先且独占；不配 CONFIG 时回落同名环境变量）
 *
 *   QQ_NUMBER 不走 CONFIG：一律从环境变量读取
 *     - 本地: export QQ_NUMBER=123456789
 *     - GitHub Actions: workflow 注入 secrets.QQ_NUMBER_{matrix.idx}（每个号一个 Secret）
 *
 *   方式 A（推荐）：GitHub Secret 只配一个 CONFIG，内容为 JSON（不含 QQ_NUMBER）
 *   方式 B（本地调试方便）：不配 CONFIG，改为逐个设置同名环境变量
 *
 *   注意：CONFIG 存在时，方式 B 的同名环境变量会被**完全忽略**（不会合并覆盖）。
 */

// 只保留通知项；原 BATCH_SIZE / QQ_PAUSE / BATCH_PAUSE / FAIL_STOP 是「一次跑多个 QQ」
// 专用的分批参数，本地已改为一次只跑 1 个号（站点按 IP/会话限额度，同 IP 连领第 2 个起
// 就会「名额不足」），这 4 项已全部移除。
const CONFIG_DEFAULTS = {
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    WXPUSH_URL: '',
    WXPUSH_TOKEN: '',
    WXPUSH_USERID: '',
    WXPUSH_TEMPLATE_ID: '',
    WXPUSH_BASE_URL: '',
};

/**
 * 读取统一配置
 * @param {object} opts
 * @param {boolean} opts.warnQqNumber  是否打印「CONFIG 里的 QQ_NUMBER 已不再读取」提醒
 *                                      （领取脚本要打印；汇总脚本不关心 QQ_NUMBER，不打印）
 */
function loadConfig(opts = {}) {
    const { warnQqNumber = true } = opts;
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
    if (warnQqNumber && parsed.QQ_NUMBER !== undefined) {
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

module.exports = { CONFIG_DEFAULTS, loadConfig };
