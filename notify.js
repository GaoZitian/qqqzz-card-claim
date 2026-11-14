/**
 * 通知发送（Telegram + wxpush 双通道，各自独立、未配置只打印预览）
 *
 * 用法：const { createNotifier } = require('./notify');
 *       const notifier = createNotifier(CONFIG);
 *       await notifier.notify(title, text);
 *
 * 每个通道返回 { channel, ok, skipped, error }，调用方可据此判断「消息是否真的发出去」。
 */

/**
 * 创建通知器
 * @param {object} cfg 配置对象（含 TELEGRAM_* / WXPUSH_* 七个通知项）
 */
function createNotifier(cfg) {
    const TG_BOT_TOKEN = cfg.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT_ID = cfg.TELEGRAM_CHAT_ID || '';
    const WXPUSH_URL = (cfg.WXPUSH_URL || '').replace(/\/+$/, '');
    const WXPUSH_TOKEN = cfg.WXPUSH_TOKEN || '';
    const WXPUSH_USERID = cfg.WXPUSH_USERID || '';
    const WXPUSH_TEMPLATE_ID = cfg.WXPUSH_TEMPLATE_ID || '';
    const WXPUSH_BASE_URL = cfg.WXPUSH_BASE_URL || '';

    /** Telegram 推送 */
    async function tgSend(title, text) {
        if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
            console.log(`\n📣 推送预览（未配置 Telegram）\n【${title}】\n${text}\n`);
            return { channel: 'telegram', ok: false, skipped: true, error: '未配置 Telegram' };
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
            const ok = !!j.ok;
            console.log('Telegram 推送:', ok ? '成功' : `失败 ${JSON.stringify(j).slice(0, 200)}`);
            return { channel: 'telegram', ok, skipped: false, error: ok ? '' : `Telegram 返回 ${JSON.stringify(j).slice(0, 200)}` };
        } catch (e) {
            console.log('Telegram 推送异常:', e.message);
            return { channel: 'telegram', ok: false, skipped: false, error: e.message };
        }
    }

    /** wxpush 微信推送（与 Telegram 独立，可同时启用） */
    async function wxpushSend(title, text) {
        if (!WXPUSH_URL || !WXPUSH_TOKEN) {
            console.log(`\n📣 推送预览（未配置 wxpush）\n【${title}】\n${text}\n`);
            return { channel: 'wxpush', ok: false, skipped: true, error: '未配置 wxpush' };
        }
        try {
            const params = new URLSearchParams({ token: WXPUSH_TOKEN, title, content: text });
            if (WXPUSH_USERID) params.set('userid', WXPUSH_USERID);
            if (WXPUSH_TEMPLATE_ID) params.set('template_id', WXPUSH_TEMPLATE_ID);
            if (WXPUSH_BASE_URL) params.set('base_url', WXPUSH_BASE_URL);
            const r = await fetch(`${WXPUSH_URL}/wxsend?${params.toString()}`, { method: 'GET' });
            const body = await r.text().catch(() => '');
            const ok = r.status === 200 && body.includes('Successfully sent');
            console.log('wxpush 推送:', ok ? '成功' : `失败 HTTP ${r.status} ${body.slice(0, 200)}`);
            return { channel: 'wxpush', ok, skipped: false, error: ok ? '' : `wxpush 返回 HTTP ${r.status} ${body.slice(0, 200)}` };
        } catch (e) {
            console.log('wxpush 推送异常:', e.message);
            return { channel: 'wxpush', ok: false, skipped: false, error: e.message };
        }
    }

    /** 统一通知入口：Telegram + wxpush 双通道（各自独立，未配置则只打印预览） */
    async function notify(title, text) {
        const tg = await tgSend(title, text);
        const wx = await wxpushSend(title, text);
        return [tg, wx];
    }

    return { tgSend, wxpushSend, notify };
}

module.exports = { createNotifier };
