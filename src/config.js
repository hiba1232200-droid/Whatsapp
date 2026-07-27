// ملف الإعدادات العام للبوت
// يقرأ القيم من متغيّرات البيئة (مناسب لـ Railway) مع قيم افتراضية للتشغيل المحلي.

// مجلد تخزين البيانات الثابتة (جلسة الدخول + قاعدة البيانات).
// على Railway اربط Volume وحدّد DATA_DIR = مسار الـ Volume (مثال: /data).
const DATA_DIR = process.env.DATA_DIR || '.';

function parseList(v) {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  // بادئة الأوامر
  prefix: process.env.PREFIX || '!',

  // مسار مجلد جلسة تسجيل الدخول (يُنشأ تلقائياً بعد أول ربط)
  authFolder: `${DATA_DIR}/auth`,

  // مسار قاعدة بيانات SQLite
  dbPath: `${DATA_DIR}/data/stats.db`,

  // اقصر البوت على مجموعات محددة عبر المتغيّر ALLOWED_GROUPS (مفصولة بفواصل)،
  // أو اتركه فارغاً ليعمل في كل المجموعات.
  allowedGroups: parseList(process.env.ALLOWED_GROUPS),

  // عدد الأعضاء المعروضين في أمر !top
  topLimit: Number(process.env.TOP_LIMIT || 10),

  // هل نحتسب انضمام العضو عبر رابط الدعوة كإضافة؟ (false موصى به)
  countInviteLinkJoins: process.env.COUNT_INVITE_JOINS === 'true',

  // رقم هاتف البوت للربط عبر "رمز الاقتران" بدل QR (مناسب للاستضافة بدون شاشة).
  // بصيغة دولية بدون + وبدون أصفار بادئة، مثال: 9639xxxxxxxx
  // اتركه فارغاً لاستخدام QR (سيُطبع في السجلّات كرابط QR).
  pairingNumber: (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, ''),

  // توكن بوت تلجرام (من @BotFather). اتركه فارغاً لتعطيل لوحة تلجرام.
  telegramToken: (process.env.TELEGRAM_TOKEN || '').trim(),

  // معرّفات مستخدمي تلجرام المصرّح لهم باستخدام اللوحة (مفصولة بفواصل).
  // احصل على معرّفك من @userinfobot. اتركه فارغاً للسماح للجميع (غير موصى به).
  telegramAdminIds: parseList(process.env.TELEGRAM_ADMIN_ID),
};
