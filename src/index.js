// نقطة تشغيل البوت الرئيسية
// بوت واتساب يبني لوحة ترتيب لأكثر الأعضاء الذين أضافوا أشخاصاً إلى المجموعة.
//
// يعتمد على حقل author في حدث group-participants.update من Baileys
// لمعرفة "من" قام بالإضافة، ويحفظ الأعداد في SQLite لتبقى بعد إعادة التشغيل.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { config } from './config.js';
import { createDb } from './db.js';
import {
  normId,
  jidToDisplay,
  stableActorId,
  participantId,
} from './utils.js';

const logger = pino({ level: 'warn' });
const db = createDb(config.dbPath);

// هل هذه المجموعة مسموح بها حسب الإعدادات؟
function isGroupAllowed(groupId) {
  if (!config.allowedGroups || config.allowedGroups.length === 0) return true;
  return config.allowedGroups.includes(groupId);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);
  const { version } = await fetchLatestBaileysVersion();

  // نستخدم رمز الاقتران إذا حُدّد رقم البوت ولم تُسجَّل الجلسة بعد.
  const usePairingCode = Boolean(config.pairingNumber) && !state.creds.registered;

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // مع رمز الاقتران لا نحتاج QR. وإلا نطبع الـ QR بأنفسنا بالأسفل.
    printQRInTerminal: false,
    browser: ['AddsLeaderboardBot', 'Chrome', '1.0.0'],
  });

  // حفظ بيانات الجلسة عند أي تحديث (يمنع إعادة المسح في كل تشغيل)
  sock.ev.on('creds.update', saveCreds);

  // طلب رمز الاقتران (8 خانات) بدل QR — مناسب للاستضافة بدون شاشة مثل Railway.
  if (usePairingCode) {
    // ننتظر قليلاً حتى يجهز الاتصال قبل طلب الرمز
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(config.pairingNumber);
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n🔗 رمز الاقتران (أدخله في واتساب > الأجهزة المرتبطة > الربط برقم الهاتف):');
        console.log(`\n    ${pretty}\n`);
      } catch (err) {
        console.error('تعذّر توليد رمز الاقتران، سيتم الرجوع إلى QR:', err?.message || err);
      }
    }, 3000);
  }

  // ==== إدارة الاتصال / QR / إعادة الاتصال ====
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 امسح رمز QR التالي من واتساب > الأجهزة المرتبطة:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ تم الاتصال بواتساب بنجاح. البوت يعمل الآن.');
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(
        `⚠️ انقطع الاتصال (code: ${statusCode}).` +
          (loggedOut ? ' تم تسجيل الخروج — احذف مجلد auth وأعد المسح.' : ' إعادة الاتصال...')
      );
      if (!loggedOut) startBot();
    }
  });

  // ==== الحدث الأساسي: تغيّر مشاركي المجموعة ====
  // نحن مهتمون فقط بـ action === 'add' مع معرفة "author" (من نفّذ الإضافة).
  sock.ev.on('group-participants.update', (update) => {
    try {
      handleParticipantsUpdate(update);
    } catch (err) {
      console.error('خطأ في معالجة تحديث المشاركين:', err);
    }
  });

  function handleParticipantsUpdate(update) {
    const { id: groupId, action, participants = [], author, authorPn } = update;

    if (action !== 'add') return;          // نهتم بالإضافة فقط
    if (!isGroupAllowed(groupId)) return;

    const adderId = stableActorId(author, authorPn);
    if (!adderId) {
      // لا يوجد author => لا نستطيع معرفة من أضاف => لا نخمّن، نتجاهل.
      return;
    }

    const adderDisplay = jidToDisplay(authorPn || author);

    for (const p of participants) {
      const addedId = participantId(p);
      if (!addedId) continue;

      // فلترة الانضمام الذاتي عبر رابط الدعوة:
      // إذا كان "من أضاف" هو نفسه "من أُضيف"، فهذا انضمام ذاتي وليس إضافة حقيقية.
      const selfJoin = normId(addedId) === normId(adderId);
      if (selfJoin && !config.countInviteLinkJoins) continue;

      db.recordAdd(groupId, adderId, addedId, adderDisplay);
    }
  }

  // ==== معالجة الرسائل الواردة (الأوامر) ====
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error('خطأ في معالجة الرسالة:', err);
      }
    }
  });

  return sock;
}

// استخراج النص من أنواع الرسائل المختلفة
function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  ).trim();
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  if (!isJidGroup(remoteJid)) return;       // الأوامر تعمل داخل المجموعات فقط
  if (!isGroupAllowed(remoteJid)) return;

  const text = extractText(msg.message);
  if (!text.startsWith(config.prefix)) return;

  const [rawCmd] = text.slice(config.prefix.length).split(/\s+/);
  const cmd = rawCmd.toLowerCase();

  if (cmd === 'top') {
    await cmdTop(sock, remoteJid);
  } else if (cmd === 'mystats') {
    await cmdMyStats(sock, msg, remoteJid);
  } else if (cmd === 'help' || cmd === 'مساعدة') {
    await sock.sendMessage(remoteJid, {
      text:
        '🤖 *بوت لوحة ترتيب الإضافات*\n\n' +
        `${config.prefix}top — أكثر ${config.topLimit} أعضاء إضافةً\n` +
        `${config.prefix}mystats — عدد الأشخاص الذين أضفتهم\n` +
        `${config.prefix}help — عرض هذه المساعدة`,
    });
  }
}

async function cmdTop(sock, groupId) {
  const rows = db.getTop(groupId, config.topLimit);
  if (rows.length === 0) {
    await sock.sendMessage(groupId, {
      text: '📊 لا توجد بيانات إضافات بعد. سيبدأ البوت بالعدّ من الآن عندما يضيف الأعضاء أشخاصاً جدداً.',
    });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const mentions = [];
  const lines = rows.map((r, i) => {
    const rank = medals[i] || `${i + 1}.`;
    const mentionJid = toMentionJid(r.participant_id);
    if (mentionJid) mentions.push(mentionJid);
    const label = mentionJid ? `@${jidToDisplay(mentionJid)}` : (r.display_name || 'عضو');
    return `${rank} ${label} — *${r.adds_count}* إضافة`;
  });

  await sock.sendMessage(groupId, {
    text: `🏆 *لوحة ترتيب أكثر الأعضاء إضافةً*\n\n${lines.join('\n')}`,
    mentions,
  });
}

async function cmdMyStats(sock, msg, groupId) {
  // معرّف المُرسِل: نفضّل رقم هاتفه إن أتاحته Baileys (participantPn)، وإلا participant.
  const senderRaw =
    msg.key.participantPn || msg.key.participant || msg.participant || msg.key.remoteJid;
  const senderId = normId(senderRaw);

  const { count, rank } = db.getMyStats(groupId, senderId);
  const mentionJid = toMentionJid(senderId);

  let body;
  if (count === 0) {
    body = `📈 لم نسجّل لك أي إضافات بعد. عندما تضيف عضواً جديداً سيُحتسب لك.`;
  } else {
    body = `📈 لقد أضفت *${count}* شخصاً إلى المجموعة.\nترتيبك الحالي: *#${rank}*`;
  }

  await sock.sendMessage(groupId, {
    text: mentionJid ? `@${jidToDisplay(mentionJid)} ${body}` : body,
    mentions: mentionJid ? [mentionJid] : [],
  });
}

// نحوّل المعرّف المخزّن إلى JID صالح للإشارة (mention).
// المعرّفات المخزّنة عادة أرقام هواتف، فنعيدها بصيغة @s.whatsapp.net.
function toMentionJid(id) {
  if (!id) return null;
  if (id.includes('@')) return id;
  return `${id}@s.whatsapp.net`;
}

// ==== إيقاف نظيف ====
function shutdown() {
  console.log('\n👋 يتم إيقاف البوت وحفظ قاعدة البيانات...');
  try {
    db.close();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startBot().catch((err) => {
  console.error('فشل بدء تشغيل البوت:', err);
  process.exit(1);
});
