// Engineering blogs — the browser side hasn't ported the CRUD UI yet, but the
// dashboard queries daily counts so the widget wires cleanly when it does.

import { exec } from '../db/client.mjs';

// created_at is UTC ISO; the bucket uses 'localtime' so late-evening entries
// stay on the local day instead of rolling to the UTC-next day.
export const listDailyCreatedCounts = (startISO, endISO) => exec(`
  SELECT substr(datetime(created_at, 'localtime'), 1, 10) AS day, COUNT(*) AS n
  FROM engineering_blog_notes
  WHERE datetime(created_at) >= datetime(?)
    AND datetime(created_at) <  datetime(?)
  GROUP BY day
  ORDER BY day
`, [startISO, endISO]);
