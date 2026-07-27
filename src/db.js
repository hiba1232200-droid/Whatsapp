// طبقة تخزين البيانات باستخدام SQLite (better-sqlite3)
// تحفظ عدد الإضافات لكل عضو، وتبقى البيانات موجودة بعد إعادة تشغيل البوت.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function createDb(dbPath) {
  // تأكد من وجود مجلد قاعدة البيانات
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  // إعدادات أداء وأمان للكتابة
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // الجدول الرئيسي: صف واحد لكل (مجموعة + عضو)
  // participant_id: معرّف ثابت للعضو (نستخدم رقم الهاتف كأساس عند توفره).
  db.exec(`
    CREATE TABLE IF NOT EXISTS add_stats (
      group_id       TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      display_name   TEXT,
      adds_count     INTEGER NOT NULL DEFAULT 0,
      last_add_at    INTEGER,
      PRIMARY KEY (group_id, participant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_group_count
      ON add_stats (group_id, adds_count DESC);

    -- سجل خام لكل عملية إضافة (للتدقيق وتفادي الاحتساب المزدوج إن رغبت لاحقاً)
    CREATE TABLE IF NOT EXISTS add_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id     TEXT NOT NULL,
      adder_id     TEXT NOT NULL,
      added_id     TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    -- أسماء مجموعات واتساب (للعرض في لوحة تلجرام)
    CREATE TABLE IF NOT EXISTS wa_groups (
      group_id   TEXT PRIMARY KEY,
      name       TEXT,
      updated_at INTEGER
    );

    -- أسماء الأعضاء (تُلتقط من رسائلهم) لعرضها بدل المعرّف الداخلي عند إخفاء الرقم
    CREATE TABLE IF NOT EXISTS wa_names (
      participant_id TEXT PRIMARY KEY,
      name           TEXT,
      updated_at     INTEGER
    );
  `);

  // زيادة عداد الإضافة لعضو معيّن (عملية ذرّية عبر UPSERT)
  const upsertStmt = db.prepare(`
    INSERT INTO add_stats (group_id, participant_id, display_name, adds_count, last_add_at)
    VALUES (@groupId, @participantId, @displayName, 1, @now)
    ON CONFLICT(group_id, participant_id) DO UPDATE SET
      adds_count   = adds_count + 1,
      last_add_at  = @now,
      display_name = COALESCE(@displayName, display_name)
  `);

  const eventStmt = db.prepare(`
    INSERT INTO add_events (group_id, adder_id, added_id, created_at)
    VALUES (@groupId, @adderId, @addedId, @now)
  `);

  // نستخدم معاملة (transaction) لضمان ترابط الكتابتين
  const recordAddTxn = db.transaction((groupId, adderId, addedId, displayName, now) => {
    upsertStmt.run({ groupId, participantId: adderId, displayName, now });
    eventStmt.run({ groupId, adderId, addedId, now });
  });

  const topStmt = db.prepare(`
    SELECT participant_id, display_name, adds_count
    FROM add_stats
    WHERE group_id = ?
    ORDER BY adds_count DESC, last_add_at ASC
    LIMIT ?
  `);

  const myStatsStmt = db.prepare(`
    SELECT adds_count
    FROM add_stats
    WHERE group_id = ? AND participant_id = ?
  `);

  const rankStmt = db.prepare(`
    SELECT COUNT(*) AS ahead
    FROM add_stats
    WHERE group_id = ? AND adds_count > (
      SELECT adds_count FROM add_stats WHERE group_id = ? AND participant_id = ?
    )
  `);

  const upsertGroupStmt = db.prepare(`
    INSERT INTO wa_groups (group_id, name, updated_at)
    VALUES (@groupId, @name, @now)
    ON CONFLICT(group_id) DO UPDATE SET name = @name, updated_at = @now
  `);

  // قائمة المجموعات المتتبَّعة مع اسمها وإجمالي الإضافات (للوحة تلجرام)
  const groupsStmt = db.prepare(`
    SELECT s.group_id                         AS group_id,
           COALESCE(g.name, s.group_id)       AS name,
           SUM(s.adds_count)                  AS total_adds,
           COUNT(*)                           AS members,
           MAX(s.last_add_at)                 AS last_add_at
    FROM add_stats s
    LEFT JOIN wa_groups g ON g.group_id = s.group_id
    GROUP BY s.group_id
    ORDER BY total_adds DESC
  `);

  const groupNameStmt = db.prepare(`SELECT name FROM wa_groups WHERE group_id = ?`);

  const rememberNameStmt = db.prepare(`
    INSERT INTO wa_names (participant_id, name, updated_at)
    VALUES (@id, @name, @now)
    ON CONFLICT(participant_id) DO UPDATE SET name = @name, updated_at = @now
  `);

  const getNameStmt = db.prepare(`SELECT name FROM wa_names WHERE participant_id = ?`);

  return {
    raw: db,

    // تسجيل عملية إضافة واحدة
    recordAdd(groupId, adderId, addedId, displayName) {
      const now = Date.now();
      recordAddTxn(groupId, adderId, addedId, displayName ?? null, now);
    },

    // أفضل N أعضاء إضافة في المجموعة
    getTop(groupId, limit) {
      return topStmt.all(groupId, limit);
    },

    // إحصائية عضو واحد: عدد إضافاته وترتيبه
    getMyStats(groupId, participantId) {
      const row = myStatsStmt.get(groupId, participantId);
      if (!row) return { count: 0, rank: null };
      const rankRow = rankStmt.get(groupId, groupId, participantId);
      return { count: row.adds_count, rank: (rankRow?.ahead ?? 0) + 1 };
    },

    // حفظ/تحديث اسم مجموعة واتساب
    upsertGroupName(groupId, name) {
      if (!name) return;
      upsertGroupStmt.run({ groupId, name, now: Date.now() });
    },

    // اسم المجموعة المخزّن (أو null)
    getGroupName(groupId) {
      return groupNameStmt.get(groupId)?.name ?? null;
    },

    // حفظ اسم عضو (نتعلّمه من رسائله)
    rememberName(participantId, name) {
      if (!participantId || !name) return;
      rememberNameStmt.run({ id: participantId, name, now: Date.now() });
    },

    // اسم عضو مخزّن (أو null)
    getName(participantId) {
      return getNameStmt.get(participantId)?.name ?? null;
    },

    // كل المجموعات المتتبَّعة (للوحة تلجرام)
    getGroups() {
      return groupsStmt.all();
    },

    close() {
      db.close();
    },
  };
}
