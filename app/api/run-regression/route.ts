import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { addLesson, addAutoFix, sanitizeRCode } from "@/lib/claude-lessons";

const R_API_URL = process.env.R_API_URL || "http://localhost:3001";

const COMPLETE_SCRIPT_PROMPT = `You complete truncated R code. The user will paste R code that was cut off. Return ONLY the complete, runnable R script as plain text. Do not wrap in markdown or code fences. Do not add explanations. The script must end with a closing comment: # END OF SCRIPT. Preserve the existing code and add any missing parts (e.g. closing braces, the CHART_DATA block, tryCatch closure).`;

const FIX_CODE_PROMPT = `You fix R code that failed. The user will provide: (1) the R error message, (2) the few lines of R code around where the error occurred (snippet). You must return the FULL corrected R script as plain text — apply the fix in context of the snippet and output the entire script. Do not wrap in markdown or code fences. Do not explain. Fix the specific error (syntax, object not found, wrong column names, special characters in getSymbols). The script must end with # END OF SCRIPT.`;

const ONE_LESSON_PROMPT = `You write one structured lesson from an R error that was just fixed. Output exactly three lines:
ERROR: <short error message, one line>
CAUSE: <what caused it in your words>
FIX: <how to avoid it in future, one concrete rule>

No other text. No "---".`;

const ONE_AUTOFIX_PROMPT = `You suggest a single find-and-replace rule so this R error can be auto-fixed next time without running code. Output exactly three lines using LITERAL strings (no regex):
DESCRIPTION: <short description, e.g. "Use Cl() for forex xts">
PATTERN: <exact substring to find in R code that causes the error>
REPLACEMENT: <exact string to replace it with>

Pattern and replacement must be literal text that would appear in R source. Escape quotes if needed. No other text.`;

const INTERPRETATION_PROMPT = `You are a senior analyst explaining regression output to a client. Given raw R output below, write a plain-English interpretation that:
1. Is 3-5 sentences, written like a senior analyst to a client.
2. Highlights the most important findings (key coefficients, significance, R-squared).
3. Flags any concerns (low R-squared, insignificant variables, etc.).
4. Ends with one practical "so what" takeaway.

Reply with only the interpretation text, no heading or markdown.`;

const ECONOMIC_VALIDATION_PROMPT = `You are an expert economist. Review these regression results and check if the coefficient signs and magnitudes make economic sense.

Consider:
- Supply/demand relationships
- Cost relationships (inputs vs company profits)
- Macro relationships (Okun's law, Fisher effect, purchasing power parity, etc.)
- Finance relationships (CAPM, factor models, yield curves)

If anything looks economically wrong or surprising, flag it with a warning.
If the results make sense, confirm they are economically reasonable.
If results are surprising but could be correct, explain why they might make sense in the current economic environment.

Always end with exactly one of these lines:
✅ Economically reasonable
⚠️ Unexpected - possible data or model issue
🔍 Surprising but explainable - here's why this might make sense

Reply with only your validation text, no extra heading.`;

const MAX_ATTEMPTS = 2;
const FIX_MODEL = "claude-3-5-haiku-20241022";

/** Strip non-ASCII / corrupted chars so Windows encoding doesn't break the response. */
function sanitizeEncoding(s: string): string {
  return (s || "").replace(/\uFFFD/g, "").replace(/[^\x00-\x7F]/g, "");
}

/** Returns true if the error looks fixable by code change (syntax, missing var, wrong name). */
function isErrorFixable(errorText: string): boolean {
  const err = (errorText || "").toLowerCase();
  const dataAvailability = [
    "could not find",
    "not find.*series",
    "series not found",
    "symbol not found",
    "invalid symbol",
    "no data",
    "unable to retrieve",
    "download failed",
    "subscript out of bounds",
    "replacement has",
    "number of rows",
  ];
  if (dataAvailability.some((p) => new RegExp(p).test(err))) return false;
  return true;
}

/** Extract the lines relevant to the error (for token-efficient fix). */
function getBrokenSnippet(fullCode: string, errorText: string): string {
  const lines = fullCode.split("\n");
  const err = errorText || "";
  const lineMatch = err.match(/(?:line|at)\s*[:=]?\s*(\d+)|:(\d+):|\((\d+)\)/i);
  const lineNum = lineMatch
    ? parseInt(lineMatch[1] || lineMatch[2] || lineMatch[3] || "0", 10)
    : 0;
  if (lineNum > 0 && lineNum <= lines.length) {
    const start = Math.max(0, lineNum - 3);
    const end = Math.min(lines.length, lineNum + 6);
    return lines.slice(start, end).join("\n");
  }
  const first = lines.slice(0, 18).join("\n");
  const last = lines.slice(-22).join("\n");
  return first + "\n...\n" + last;
}

async function runRCode(code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const response = await fetch(`${R_API_URL}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const result = (await response.json()) as { stdout?: string; output?: string; stderr?: string; error?: string; exitCode?: number };
  const stdout = sanitizeEncoding(result.stdout ?? result.output ?? "");
  const stderr = sanitizeEncoding(result.stderr ?? result.error ?? (response.ok ? "" : "Remote R run failed"));
  const exitCode = response.ok ? (result.exitCode ?? 0) : 1;
  return { stdout, stderr, exitCode };
}

async function askClaudeToFixCode(
  apiKey: string,
  errorOutput: string,
  brokenSnippet: string
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: FIX_MODEL,
    max_tokens: 4096,
    system: FIX_CODE_PROMPT,
    messages: [
      {
        role: "user",
        content: `Error output:\n${errorOutput}\n\nBroken snippet (lines around the error):\n${brokenSnippet}`,
      },
    ],
  });
  const textBlock = msg.content.find((b) => b.type === "text");
  let fixed = (textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "").trim();
  const codeFence = fixed.match(/```(?:r)?\s*([\s\S]*?)```/);
  if (codeFence) fixed = codeFence[1].trim();
  return fixed;
}

async function generateOneLesson(
  apiKey: string,
  errorOutput: string
): Promise<{ error: string; cause: string; fix: string } | null> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 256,
    system: ONE_LESSON_PROMPT,
    messages: [{ role: "user", content: "R error that was fixed:\n" + errorOutput }],
  });
  const textBlock = msg.content.find((b) => b.type === "text");
  const text = (textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "").trim();
  let error = "";
  let cause = "";
  let fix = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.toUpperCase().startsWith("ERROR:")) error = t.replace(/^ERROR:\s*/i, "").trim();
    else if (t.toUpperCase().startsWith("CAUSE:")) cause = t.replace(/^CAUSE:\s*/i, "").trim();
    else if (t.toUpperCase().startsWith("FIX:")) fix = t.replace(/^FIX:\s*/i, "").trim();
  }
  if (error) return { error, cause, fix };
  return null;
}

async function generateOneAutoFix(
  apiKey: string,
  errorOutput: string,
  fixedCodeSnippet: string
): Promise<{ description: string; pattern: string; replacement: string } | null> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: FIX_MODEL,
    max_tokens: 256,
    system: ONE_AUTOFIX_PROMPT,
    messages: [
      {
        role: "user",
        content: `R error:\n${errorOutput}\n\nFixed code (snippet):\n${fixedCodeSnippet}`,
      },
    ],
  });
  const textBlock = msg.content.find((b) => b.type === "text");
  const text = (textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "").trim();
  let description = "";
  let pattern = "";
  let replacement = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.toUpperCase().startsWith("DESCRIPTION:")) description = t.replace(/^DESCRIPTION:\s*/i, "").trim();
    else if (t.toUpperCase().startsWith("PATTERN:")) pattern = t.replace(/^PATTERN:\s*/i, "").trim();
    else if (t.toUpperCase().startsWith("REPLACEMENT:")) replacement = t.replace(/^REPLACEMENT:\s*/i, "").trim();
  }
  if (description && (pattern?.length ?? 0) > 0) return { description, pattern, replacement };
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      code?: string;
      prompt?: string;
      attempt?: number;
      previousCorrections?: { error: string }[];
    };
    const { code, prompt, attempt = 1, previousCorrections = [] } = body;
    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid code" },
        { status: 400 }
      );
    }

    let codeToRun = code;
    codeToRun = await sanitizeRCode(codeToRun);
    if (!codeToRun.includes("# END OF SCRIPT")) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const client = new Anthropic({ apiKey });
          const msg = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            system: COMPLETE_SCRIPT_PROMPT,
            messages: [{ role: "user", content: "Your R code was cut off, please complete it:\n\n" + codeToRun }],
          });
          const textBlock = msg.content.find((b) => b.type === "text");
          if (textBlock && "text" in textBlock) {
            let completed = (textBlock as { text: string }).text.trim();
            const codeFence = completed.match(/```(?:r)?\s*([\s\S]*?)```/);
            if (codeFence) completed = codeFence[1].trim();
            if (completed.length > 0) codeToRun = completed;
          }
        } catch (e) {
          console.error("Failed to complete truncated R code:", e);
        }
      }
    }

    const result = await runRCode(codeToRun);

    const runError = result.stderr || result.stdout || "R script failed";
    if (result.exitCode !== 0 && attempt < MAX_ATTEMPTS && isErrorFixable(runError)) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const snippet = getBrokenSnippet(codeToRun, runError);
          const fixedCode = await askClaudeToFixCode(apiKey, runError, snippet);
          if (fixedCode.length > 0) {
            try {
              const lesson = await generateOneLesson(apiKey, runError);
              if (lesson) await addLesson(lesson);
              const autoFix = await generateOneAutoFix(apiKey, runError, getBrokenSnippet(fixedCode, runError));
              if (autoFix && autoFix.pattern) await addAutoFix(autoFix);
            } catch (e) {
              console.error("Failed to write lesson or autoFix:", e);
            }
            const corrections = [...previousCorrections, { error: runError }];
            return NextResponse.json({
              success: false,
              needsRetry: true,
              fixedCode,
              attempt,
              corrections,
              message: `Fixing code, attempt ${attempt + 1} of ${MAX_ATTEMPTS}...`,
            });
          }
        } catch (e) {
          console.error("Failed to fix R code:", e);
        }
      }
    }

    if (result.exitCode !== 0) {
      const userMessage = !isErrorFixable(runError)
        ? "Data or series unavailable (e.g. symbol/series not found). Check tickers and date range; no automatic fix was attempted."
        : undefined;
      return NextResponse.json({
        success: false,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        interpretation: "",
        chartData: null,
        error: result.stderr || result.stdout || "R script failed",
        dataUnavailable: !isErrorFixable(runError),
        userMessage,
      });
    }

    let chartData: Record<string, unknown> | null = null;
    const chartIdx = result.stdout.indexOf("CHART_DATA:");
    if (chartIdx >= 0) {
      const after = result.stdout.slice(chartIdx + "CHART_DATA:".length);
      const first = after.indexOf("{");
      const last = after.lastIndexOf("}");
      if (first !== -1 && last >= first) {
        try {
          chartData = JSON.parse(after.slice(first, last + 1)) as Record<string, unknown>;
        } catch {
          // leave chartData null
        }
      }
    }

    return NextResponse.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: true,
      interpretation: "",
      economicValidation: "",
      chartData,
      attempts: previousCorrections.length + 1,
      corrected: previousCorrections.length > 0,
    });
  } catch (err) {
    console.error("Run regression error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Run failed" },
      { status: 500 }
    );
  }
}
