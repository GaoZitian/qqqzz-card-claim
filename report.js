/**
 * 领取结果的状态定义与汇总文案（中文）
 *
 * 状态枚举：
 *   success  领取成功（服务端返回 code=200 / 订单创建成功）
 *   already  今日已领过（服务端返回「已领取/已下单/已购买」）
 *   quota    额度限制（服务端返回「名额不足」）
 *   login    需要登录（站点级封禁）
 *   captcha  需要验证码（站点级封禁）
 *   failed   领取失败（其它情况）
 *   error    流程异常（浏览器启动失败、访问验证未通过等）
 *   skipped  未配置该 QQ 号，跳过
 */

/** 每个状态对应的图标与文案 */
const STATUS_META = {
    success: { mark: '✅', label: '领取成功' },
    already: { mark: '⏭️', label: '今日已领过' },
    quota: { mark: '⚠️', label: '额度限制' },
    login: { mark: '🔒', label: '需要登录' },
    captcha: { mark: '🔐', label: '需要验证码' },
    failed: { mark: '❌', label: '领取失败' },
    error: { mark: '❌', label: '流程异常' },
    skipped: { mark: '⏭️', label: '未配置，已跳过' },
};

/** 取状态元信息（未知状态按失败处理） */
function meta(status) {
    return STATUS_META[status] || STATUS_META.failed;
}

/** 统计各状态数量 */
function countByStatus(list) {
    const counts = { success: 0, already: 0, quota: 0, login: 0, captcha: 0, failed: 0, error: 0, skipped: 0 };
    for (const r of list) {
        const s = r.status in counts ? r.status : 'failed';
        counts[s] += 1;
    }
    return counts;
}

/**
 * 生成一条汇总消息
 * @param {Array} list 每条结果 { qq: 脱敏QQ, status, msg }
 * @param {object} opts { unprocessed: 未处理数量, aborted: 是否中止 }
 * @returns {object} { title, text }
 */
function buildReport(list, opts = {}) {
    const unprocessed = Number(opts.unprocessed || 0);
    const counts = countByStatus(list);

    // 逐号一行：状态一目了然，不再合并成「成功/已领过」
    const lines = [];
    for (const r of list) {
        const m = meta(r.status);
        const who = r.qq || '未知 QQ';
        let line = `${m.mark} ${who}  ${m.label}`;
        // 失败/额度限制附上服务端原因；成功/已领过只给状态，不加噪音
        if ((r.status === 'failed' || r.status === 'error' || r.status === 'quota') && r.msg) {
            line += `（${r.msg}）`;
        }
        lines.push(line);
    }
    if (unprocessed > 0) {
        lines.push(`⏭️ 未处理 ${unprocessed} 个 QQ`);
    }

    // 汇总计数行
    const parts = [];
    if (counts.success) parts.push(`领取成功 ${counts.success}`);
    if (counts.already) parts.push(`今日已领过 ${counts.already}`);
    if (counts.quota) parts.push(`额度限制 ${counts.quota}`);
    if (counts.login) parts.push(`需要登录 ${counts.login}`);
    if (counts.captcha) parts.push(`需要验证码 ${counts.captcha}`);
    if (counts.failed) parts.push(`失败 ${counts.failed}`);
    if (counts.error) parts.push(`流程异常 ${counts.error}`);
    if (counts.skipped) parts.push(`已跳过 ${counts.skipped}`);
    if (unprocessed) parts.push(`未处理 ${unprocessed}`);
    lines.push(`共 ${list.length} 个 QQ：${parts.join('，') || '无'}`);

    // 标题：中止 > 部分失败 > 全部完成
    const aborted = !!opts.aborted || counts.login > 0 || counts.captcha > 0;
    const hasProblem = counts.quota > 0 || counts.failed > 0 || counts.error > 0;
    const title = aborted
        ? '🛑 名片赞领取中止'
        : (hasProblem ? '⚠️ 名片赞领取部分失败' : '✅ 名片赞领取完成');

    return { title, text: lines.join('\n'), counts };
}

module.exports = { STATUS_META, meta, countByStatus, buildReport };
