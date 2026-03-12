import Database from "better-sqlite3";
import { join } from "path";

const dbPath = join(process.cwd(), "econai.db");
const db = new Database(dbPath);

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

export function saveRegression(params: {
  prompt: string;
  r_code: string;
  output: string;
  interpretation: string;
  economic_validation?: string | null;
  chart_data: string | null;
}): void {
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
  const stmt = db.prepare(`
    SELECT id, prompt, r_code, output, interpretation, economic_validation, chart_data, created_at
    FROM regressions
    ORDER BY created_at DESC
  `);
  return stmt.all() as RegressionRow[];
}
