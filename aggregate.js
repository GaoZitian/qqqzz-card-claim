#!/usr/bin/env node
/**
 * 汇总推送脚本：把各矩阵 job 上传的领取结果合并成【一条】消息推送
 *
 * 背景：
 *   GitHub Actions 矩阵模式下，每个 QQ 一个独立 job（独立虚拟机 = 独立出口 IP）。
 *   如果每个 job 各自推送，就会每个 QQ 收到一条消息。这里改成：
 *     - 领取 job 只跑领取，把结果写成 result-<序号>.json 并上传为 artifact，不发消息
 *     - 汇总 job 下载所有 artifact，合并成一条汇总消息，统一推送
 *
 * 用法：
 *   RESULT_DIR=results QQ_IDX_LIST='[1,2,3]' node aggregate.js
 *
 * 环境变量：
 *   RESULT_DIR    结果文件目录（默认 ./results）
 *   QQ_IDX_LIST   预期序号 JSON 数组（默认取 vars.QQ_IDX），用于发现「应该有结果却没结果」的序号
 *   CONFIG        通知配置 JSON（与领取脚本同一套规则）
 *
 * 退出码：
 *   0  汇总完成（推送成功，或所有通道都未配置 → 只打印预览）
 *   1  汇总本身出错（读不到结果 / 推送失败）
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createNotifier } = require('./notify');
const { buildReport, meta } = require('./report');

const RESULT_DIR = (process.env.RESULT_DIR || './results').trim();
const QQ_IDX_LIST = (process.env.QQ_IDX_LIST || '').trim();

/** 读取所有结果文件 */
function loadResults() {
    const results = [];
    let aborted = false;

    if (!fs.existsSync(RESULT_DIR)) {
        return { results, aborted, missingDir: true };
    }
    const files = fs.readdirSync(RESULT_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
        const full = path.join(RESULT_DIR, f);
        try {
            const data = JSON.parse(fs.readFileSync(full, 'utf8'));
            const idx = data.idx ?? null;
            for (const r of (data.results || [])) {
                results.push({ ...r, idx });
            }
            if (data.stopReason) aborted = true;
        } catch (e) {
            console.error(`⚠️ 读取结果文件失败：${f}（${e.message}）`);
        }
    }
    return { results, aborted, missingDir: false };
}

/** 从预期序号列表里找出「没有结果文件」的序号 */
function findMissingIdx(existingIdx) {
    if (!QQ_IDX_LIST) return [];
    let expected = [];
    try {
        const parsed = JSON.parse(QQ_IDX_LIST);
        if (Array.isArray(parsed)) expected = parsed.map((v) => String(v));
    } catch (e) {
        console.error(`⚠️ QQ_IDX_LIST 不是合法 JSON 数组：${e.message}`);
        return [];
    }
    return expected.filter((idx) => !existingIdx.has(idx));
}

async function main() {
    const cfg = loadConfig({ warnQqNumber: false });
    const notifier = createNotifier(cfg);

    const { results, aborted, missingDir } = loadResults();
    if (missingDir) {
        // 目录不存在 = 所有领取 job 都没产出结果（artifact 为空或上传失败）。
        // 这属于「领取失败」，不是「汇总出错」——汇总 job 不该因此变红，
        // 否则真正的故障信号（消息没发出去）会被淹没。改成走「全部缺失」汇总路径。
        console.log(`⚠️ 结果目录不存在：${RESULT_DIR}（所有领取 job 均未产出结果）`);
        console.log('   请查看各 claim job 的日志确认失败原因（通常是站点不可达）。');
    }

    // 已有结果涉及的序号
    const existingIdx = new Set(results.map((r) => String(r.idx)));

    // 预期序号里没有结果的 → 补一条「失败」说明（通常是该 job 崩了）
    const missing = findMissingIdx(existingIdx);
    for (const idx of missing) {
        console.log(`⚠️ 序号 ${idx} 没有结果文件（对应 job 可能异常退出）`);
        results.push({ qq: `序号 ${idx}`, status: 'failed', msg: `序号 ${idx} 未返回结果`, idx });
    }

    if (results.length === 0) {
        // 连预期序号列表都没有 → 无法确定该汇总哪些号，属于汇总本身配置问题
        if (missing.length === 0) {
            console.error('❌ 没有任何领取结果，且无法确定预期序号（QQ_IDX_LIST 为空或格式错）');
            console.error('   请确认仓库变量 QQ_IDX 已配置，以及领取 job 是否上传了 artifact。');
            process.exit(1);
        }
    }

    // 按序号排序，序号小的在前；无序号的排在最后
    results.sort((a, b) => {
        const ai = a.idx === null || a.idx === undefined ? Number.MAX_SAFE_INTEGER : Number(a.idx);
        const bi = b.idx === null || b.idx === undefined ? Number.MAX_SAFE_INTEGER : Number(b.idx);
        return ai - bi;
    });

    const unprocessed = results.reduce((s, r) => s + (r.unprocessed || 0), 0);
    const report = buildReport(results, { unprocessed, aborted });

    console.log('\n════════ 汇总 ════════');
    console.log(report.text);
    console.log('══════════════════════\n');

    console.log('📤 推送汇总通知...');
    const sent = await notifier.notify(report.title, report.text);

    // 推送结果判定：配了通道却发失败 → 退出码 1（汇总本身出错）
    const failed = sent.filter((s) => !s.skipped && !s.ok);
    const skipped = sent.filter((s) => s.skipped);
    if (failed.length > 0) {
        console.error('❌ 推送失败：' + failed.map((f) => `${f.channel}（${f.error}）`).join('，'));
        process.exit(1);
    }
    if (skipped.length > 0 && skipped.length === sent.length) {
        console.log('ℹ️ 所有通知通道都未配置，只打印了推送预览（不影响领取结果）');
    }
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ 汇总异常:', e.message);
    process.exit(1);
});
