// Career sparks — freeform criteria the user cares about. Ordered list.
// Stored flat; the Overview wizard groups them by theme for reflection, but
// the storage is a single ordered list.

import { exec } from '../db/client.mjs';

export const listSparks = () => exec(
  `SELECT id, body, sort_order, created_at, updated_at
   FROM career_sparks
   ORDER BY sort_order ASC, id ASC`,
);

export const countSparks = async () => {
  const rows = await exec('SELECT COUNT(*) AS n FROM career_sparks');
  return Number(rows[0]?.n ?? 0);
};

// createSpark inserts a spark. When a priority is provided, it is stored
// directly as sort_order (lower number = higher priority; ties are allowed).
// When omitted, the spark is appended at the end (max sort_order + 1).
export const createSpark = async (body, priority) => {
  let sortOrder;
  if (priority == null || Number.isNaN(Number(priority))) {
    const rows = await exec('SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM career_sparks');
    sortOrder = Number(rows[0]?.next ?? 0);
  } else {
    sortOrder = Number(priority);
  }
  await exec(
    `INSERT INTO career_sparks (body, sort_order) VALUES (?, ?)`,
    [(body || '').toString(), sortOrder],
  );
  const idRows = await exec('SELECT last_insert_rowid() AS id');
  return idRows[0].id;
};

export const deleteSpark = (id) =>
  exec('DELETE FROM career_sparks WHERE id = ?', [id]);
