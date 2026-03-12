import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const LESSONS_FILE = join(process.cwd(), "lessons.json");

export type Lesson = {
  id: number;
  error: string;
  cause: string;
  fix: string;
  timesEncountered: number;
};

export type AutoFix = {
  id: number;
  description: string;
  pattern: string;
  replacement: string;
  timesApplied: number;
};

type LessonsFile = { lessons: Lesson[]; autoFixes?: AutoFix[] };

async function readFullFile(): Promise<LessonsFile> {
  try {
    const raw = await readFile(LESSONS_FILE, "utf-8");
    const data = JSON.parse(raw) as LessonsFile;
    return {
      lessons: Array.isArray(data.lessons) ? data.lessons : [],
      autoFixes: Array.isArray(data.autoFixes) ? data.autoFixes : [],
    };
  } catch {
    return { lessons: [], autoFixes: [] };
  }
}

async function writeFullFile(data: LessonsFile): Promise<void> {
  await writeFile(
    LESSONS_FILE,
    JSON.stringify(
      { lessons: data.lessons, autoFixes: data.autoFixes ?? [] },
      null,
      2
    ),
    "utf-8"
  );
}

/**
 * Reads lessons.json and returns them formatted as a string to prepend to the system prompt.
 */
export async function getLessonsFormattedForPrompt(): Promise<string> {
  const data = await readFullFile();
  const lessons = data.lessons;
  const sorted = [...lessons].sort(
    (a, b) => (b.timesEncountered ?? 0) - (a.timesEncountered ?? 0)
  );
  if (sorted.length === 0) return "";
  const block = sorted
    .map(
      (l) =>
        `- Error: ${l.error}\n  Cause: ${l.cause}\n  How to avoid: ${l.fix}`
    )
    .join("\n\n");
  return "=== LEARNED FROM PAST FIXES (apply these rules) ===\n" + block + "\n\n";
}

/** Returns the number of lessons (for UI counter). */
export async function getLessonsCount(): Promise<number> {
  const data = await readFullFile();
  return data.lessons.length;
}

/** Returns the number of auto-fixes (for UI indicator). */
export async function getAutoFixesCount(): Promise<number> {
  const data = await readFullFile();
  return (data.autoFixes ?? []).length;
}

/**
 * Appends a new lesson to lessons.json (or increments timesEncountered if same error already exists).
 */
export async function addLesson(lesson: {
  error: string;
  cause: string;
  fix: string;
}): Promise<void> {
  const data = await readFullFile();
  const lessons = data.lessons;
  const normalized = (s: string) =>
    (s || "").trim().split(/\n/)[0].trim().replace(/\s+/g, " ").toLowerCase();
  const errNorm = normalized(lesson.error);
  const existing = lessons.find((l) => normalized(l.error) === errNorm);
  if (existing) {
    existing.timesEncountered = (existing.timesEncountered ?? 1) + 1;
  } else {
    const nextId =
      lessons.length === 0 ? 1 : Math.max(...lessons.map((l) => l.id), 0) + 1;
    lessons.push({
      id: nextId,
      error: (lesson.error || "").trim().split(/\n/)[0].trim(),
      cause: (lesson.cause || "").trim(),
      fix: (lesson.fix || "").trim(),
      timesEncountered: 1,
    });
  }
  lessons.sort(
    (a, b) => (b.timesEncountered ?? 0) - (a.timesEncountered ?? 0)
  );
  await writeFullFile({ ...data, lessons });
}

/**
 * Applies all autoFixes from lessons.json to R code (literal string replace).
 * When a fix is applied, increments timesApplied for that entry in lessons.json.
 * Returns the sanitized code.
 */
export async function sanitizeRCode(code: string): Promise<string> {
  const data = await readFullFile();
  const autoFixes = data.autoFixes ?? [];
  if (autoFixes.length === 0) return code;
  let result = code;
  let changed = false;
  for (const af of autoFixes) {
    const pattern = af.pattern ?? "";
    const replacement = af.replacement ?? "";
    if (!pattern) continue;
    const newResult = result.split(pattern).join(replacement);
    if (newResult !== result) {
      result = newResult;
      af.timesApplied = (af.timesApplied ?? 0) + 1;
      changed = true;
    }
  }
  if (changed) await writeFullFile(data);
  return result;
}

/**
 * Appends a new autoFix to lessons.json.
 */
export async function addAutoFix(fix: {
  description: string;
  pattern: string;
  replacement: string;
}): Promise<void> {
  const data = await readFullFile();
  const autoFixes = data.autoFixes ?? [];
  const nextId =
    autoFixes.length === 0
      ? 1
      : Math.max(...autoFixes.map((a) => a.id), 0) + 1;
  autoFixes.push({
    id: nextId,
    description: (fix.description || "").trim(),
    pattern: fix.pattern ?? "",
    replacement: fix.replacement ?? "",
    timesApplied: 0,
  });
  await writeFullFile({ ...data, autoFixes });
}
