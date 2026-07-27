// أدوات مساعدة للتعامل مع معرّفات واتساب.
//
// ملاحظة تقنية مهمة:
// واتساب انتقل مؤخراً لاستخدام معرّف داخلي يُسمى LID (ينتهي بـ @lid)
// بدلاً من رقم الهاتف الصريح (@s.whatsapp.net) في المجموعات، حمايةً للخصوصية.
// إصدارات Baileys الحديثة تعطينا الحقلين معاً في حدث تحديث المشاركين:
//   author      = المعرّف الذي نفّذ الإجراء (قد يكون @lid أو @s.whatsapp.net)
//   authorPn    = رقم الهاتف المقابل (إن توفّر)
// لذلك نختار معرّفاً "ثابتاً" للتخزين: نفضّل رقم الهاتف عند توفره، وإلا نستخدم author.

import { jidNormalizedUser } from '@whiskeysockets/baileys';

// يحوّل أي معرّف إلى صيغة موحّدة، ويعيد null للقيم الفارغة.
export function normId(jid) {
  if (!jid || typeof jid !== 'string') return null;
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

// يستخرج الجزء الرقمي/المعرّف من الـ JID لعرضه بشكل ودّي.
export function jidToDisplay(jid) {
  if (!jid) return 'مجهول';
  const at = jid.indexOf('@');
  return at === -1 ? jid : jid.slice(0, at);
}

// يبني معرّفاً ثابتاً للعضو الذي نفّذ الإضافة.
// نمرّر author و authorPn القادمين من الحدث.
export function stableActorId(author, authorPn) {
  const pn = normId(authorPn);
  if (pn) return pn;                 // نفضّل رقم الهاتف كمعرّف ثابت
  return normId(author);             // وإلا نستخدم المعرّف المتاح (قد يكون LID)
}

// يستخرج معرّف مشارك واحد من عنصر مصفوفة participants.
// في الإصدارات الحديثة قد يكون العنصر نصاً أو كائناً يحوي { id, jid, lid, phoneNumber }.
export function participantId(p) {
  if (typeof p === 'string') return normId(p);
  if (p && typeof p === 'object') {
    return normId(p.phoneNumber || p.jid || p.id || p.lid);
  }
  return null;
}
