/**
 * Read-only access to the ZCode CLI session store.
 *
 * ZCode keeps authoritative session data in a local SQLite database
 * (`<home>/.zcode/cli/db/db.sqlite` by default; override with `--db` or `ZCODE_DB`)
 * with three tables: `session`, `message`, `part`. `message.data` and `part.data`
 * are JSON. This module never writes: the database is opened read-only.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { resolveZcodeDb } from './paths.mjs';

/** Open the ZCode database read-only. */
export function openZcodeDatabase(file = resolveZcodeDb()) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `ZCode database not found at ${file}.\n` +
        `Pass --db <path> or set ZCODE_DB if ZCode stores it elsewhere.`,
    );
  }
  // `readOnly` still lets SQLite recover a hot WAL left by a running ZCode; it cannot
  // write to the main database file.
  return new DatabaseSync(file, { readOnly: true });
}

/**
 * List migratable sessions, newest activity first.
 *
 * ZCode's `task_type` splits three ways, and only two are conversations the user sees:
 *   - `interactive` — primary sessions (`parent_id IS NULL`);
 *   - `fork` — user-visible branches that own a complete message/part history of their
 *     own. ZCode lists them flat beside their parent, so skipping them silently drops
 *     real conversations; they are therefore included by default;
 *   - `subagent_child` — small agent-internal research turns, excluded by default.
 *
 * @param {DatabaseSync} db
 * @param {{includeForks?: boolean, includeSubagents?: boolean}} [options]
 */
export function listSessions(db, options = {}) {
  const includeForks = options.includeForks !== false;
  const includeSubagents = options.includeSubagents === true;
  const kinds = ["'interactive'"];
  if (includeForks) kinds.push("'fork'");
  if (includeSubagents) kinds.push("'subagent_child'");

  return db
    .prepare(
      `select s.id, s.title, s.directory, s.time_created, s.time_updated, s.task_type, s.parent_id,
              (select count(*) from message m where m.session_id = s.id) as message_count
         from session s
        where s.task_type in (${kinds.join(', ')})
        order by s.time_updated desc`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title,
      directory: row.directory,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      messageCount: row.message_count,
      taskType: row.task_type,
      zcodeParentId: row.parent_id ?? null,
    }));
}

/** Load one session's messages with their ordered, decoded parts. */
export function loadSessionMessages(db, sessionId) {
  const messages = db
    .prepare(`select id, sequence, data from message where session_id = ? order by sequence, time_created, id`)
    .all(sessionId);
  const parts = db
    .prepare(
      `select message_id, sequence, data from part
        where session_id = ? order by message_id, sequence, time_created, id`,
    )
    .all(sessionId);

  const partsByMessage = new Map();
  for (const row of parts) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue; // one unreadable part must not sink the session
    }
    const bucket = partsByMessage.get(row.message_id);
    if (bucket === undefined) partsByMessage.set(row.message_id, [{ sequence: row.sequence, data }]);
    else bucket.push({ sequence: row.sequence, data });
  }

  return {
    messages: messages.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      data: JSON.parse(row.data),
      parts: partsByMessage.get(row.id) ?? [],
    })),
  };
}
