import { join } from "path";

export type RegressionRow = {
  id: number;
  prompt: string;
  r_code: string;
  output: string;
  interpretation: string;
  economic_validation: string | null;
  chart_data: string | null;
  created_at: string;
};

// better-sqlite3 uses native binaries that don't run on Vercel's serverless
// runtime (read-only filesystem, wrong architecture). We wrap everything so
// the app works even when the DB is unavailable — history just won't persist.
let db: import("better-sqlite3").Database | null = null;

try {
  // Dynamic require so the module itself doesn't crash if the native binary
  // is missing — next.config serverExternalPackages keeps it out of the bundle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const dbPath = join(process.cwd(), "econai.db");
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS regressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt TEXT NOT NULL,
      r_code TEXT NOT NULL,
      output TEXT NOT NULL,
      interpretation TEXT NOT NULL,
      economic_validation TEXT,
      chart_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try {
    db.exec(`ALTER TABLE regressions ADD COLUMN economic_validation TEXT`);
  } catch {
    /* column may already exist */
  }
} catch (e) {
  console.error("DB unavailable (history will not persist):", e);
  db = null;
}

export function saveRegression(params: {
  prompt: string;
  r_code: string;
  output: string;
  interpretation: string;
  economic_validation?: string | null;
  chart_data: string | null;
}): void {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO regressions (prompt, r_code, output, interpretation, economic_validation, chart_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.prompt,
    params.r_code,
    params.output,
    params.interpretation,
    params.economic_validation ?? null,
    params.chart_data
  );
}

export function getAllRegressions(): RegressionRow[] {
  if (!db) return [];
  const stmt = db.prepare(`
    SELECT id, prompt, r_code, output, interpretation, economic_validation, chart_data, created_at
    FROM regressions
    ORDER BY created_at DESC
  `);
  return stmt.all() as RegressionRow[];
}
