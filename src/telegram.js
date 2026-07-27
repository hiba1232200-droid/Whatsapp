// لوحة تلجرام لعرض ترتيب أكثر الأعضاء إضافةً في مجموعات واتساب المتتبَّعة.
//
// مهم: هذا البوت "واجهة عرض" فقط — يقرأ نفس قاعدة بيانات SQLite التي يملؤها
// عميل واتساب (Baileys). العدّ الفعلي يحدث في جهة واتساب، وتلجرام يعرض النتيجة.

import { Bot } from 'grammy';
import { jidToDisplay } from './utils.js';

export function createTelegramBot(db, config) {
  if (!config.telegramToken) {
    console.log('ℹ️ لم يُضبط TELEGRAM_TOKEN — لوحة تلجرام معطّلة (واتساب يعمل عادياً).');
    return null;
  }

  const bot = new Bot(config.telegramToken);
  const admins = config.telegramAdminIds || [];

  // السماح فقط للمشرفين المحدّدين (إن وُجدت قائمة). وإلا يُسمح للجميع.
  function isAllowed(ctx) {
    if (admins.length === 0) return true;
    return admins.includes(String(ctx.from?.id));
  }

  bot.use(async (ctx, next) => {
    if (!isAllowed(ctx)) {
      await ctx.reply('⛔ هذه اللوحة خاصة. معرّفك غير مصرّح له.');
      return;
    }
    await next();
  });

  const help =
    '🤖 لوحة ترتيب إضافات واتساب\n\n' +
    '/groups — عرض مجموعات واتساب المتتبَّعة وأرقامها\n' +
    '/top — ترتيب أكثر الأعضاء إضافةً (إن كانت مجموعة واحدة)\n' +
    '/top رقم — ترتيب مجموعة محددة حسب رقمها في /groups\n' +
    '/help — هذه القائمة\n\n' +
    'ملاحظة: يبدأ العدّ بعد ربط واتساب وإضافة رقم البوت للمجموعة.';

  bot.command(['start', 'help'], (ctx) => ctx.reply(help));

  bot.command('groups', (ctx) => {
    const groups = db.getGroups();
    if (groups.length === 0) {
      return ctx.reply('📭 لا توجد مجموعات متتبَّعة بعد. تأكد أن عميل واتساب مرتبط ورقمه مضاف للمجموعة، وأنه سُجّلت إضافة واحدة على الأقل.');
    }
    const lines = groups.map((g, i) => {
      const when = g.last_add_at ? new Date(g.last_add_at).toISOString().slice(0, 10) : '—';
      return `${i + 1}. ${g.name}\n   الإجمالي: ${g.total_adds} إضافة · أعضاء نشطون: ${g.members} · آخر إضافة: ${when}`;
    });
    return ctx.reply('📋 مجموعات واتساب المتتبَّعة:\n\n' + lines.join('\n\n') + '\n\nاستخدم /top رقم لعرض ترتيب مجموعة.');
  });

  bot.command('top', (ctx) => {
    const groups = db.getGroups();
    if (groups.length === 0) {
      return ctx.reply('📭 لا توجد بيانات بعد.');
    }

    // تحديد المجموعة المطلوبة
    const arg = (ctx.match || '').trim();
    let target;
    if (arg) {
      const idx = Number(arg) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= groups.length) {
        return ctx.reply('⚠️ رقم غير صحيح. استخدم /groups لرؤية الأرقام المتاحة.');
      }
      target = groups[idx];
    } else if (groups.length === 1) {
      target = groups[0];
    } else {
      return ctx.reply('📋 يوجد أكثر من مجموعة. استخدم /groups ثم /top رقم لاختيار واحدة.');
    }

    const rows = db.getTop(target.group_id, config.topLimit);
    if (rows.length === 0) {
      return ctx.reply(`📊 لا توجد إضافات بعد في: ${target.name}`);
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
      const rank = medals[i] || `${i + 1}.`;
      const label = r.display_name || jidToDisplay(r.participant_id);
      return `${rank} ${label} — ${r.adds_count} إضافة`;
    });
    return ctx.reply(`🏆 ترتيب أكثر الأعضاء إضافةً\nالمجموعة: ${target.name}\n\n${lines.join('\n')}`);
  });

  // معالجة أخطاء البوت حتى لا يتوقف
  bot.catch((err) => {
    console.error('خطأ في بوت تلجرام:', err?.error || err);
  });

  return bot;
}
