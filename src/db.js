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

    close() {
      db.close();
    },
  };
}
