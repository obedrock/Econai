import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { addLesson, addAutoFix, sanitizeRCode } from "@/lib/claude-lessons";

export const maxDuration = 120;

const R_API_URL = process.env.R_API_URL || "http://localhost:3001";

const COMPLETE_SCRIPT_PROMPT = `You complete or repair incomplete R code. The user will paste R code that is either cut off or is missing variable definitions. Return ONLY the complete, runnable R script as plain text. Do not wrap in markdown or code fences. Do not add explanations. The script must end with a closing comment: # END OF SCRIPT. Preserve the existing code and add any missing parts (e.g. closing braces, the CHART_DATA block, tryCatch closure, missing getSymbols calls for FRED or Yahoo).

CRITICAL RULES — violating any of these will break the pipeline:
- NEVER use synthetic, placeholder, or randomly-generated data (no rnorm, runif, cumsum fake data).
- NEVER wrap getSymbols() calls in tryCatch with NULL fallbacks. Data is injected server-side; if the call is in the code, it WILL succeed.
- ALWAYS use getSymbols("SERIES", src="FRED", auto.assign=FALSE) for FRED data (exact syntax, no spaces around =).
- ALWAYS use getSymbols("TICKER", src="yahoo", auto.assign=FALSE) for Yahoo data (exact syntax, no spaces around =).
- Variable named after the lowercase ticker must hold the final transformed series: spy <- na.omit(diff(log(spy_monthly))).`;

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

const MAX_ATTEMPTS = 2;
const FIX_MODEL = "claude-haiku-4-5-20251001";

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
  const exitCode = response.ok ? (result.exitCode ?? (result.error ? 1 : 0)) : 1;
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
    model: FIX_MODEL,
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

/**
 * Find read.csv() calls that fetch directly from fred.stlouisfed.org.
 * Claude sometimes generates these instead of getSymbols(src="FRED").
 * Returns the full match and extracted series ID so we can replace with inline data.
 * Handles both: read.csv("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES")
 *           and: read.csv(url("https://..."))
 */
function findFredCsvCalls(code: string): Array<{ fullMatch: string; seriesId: string }> {
  const results: Array<{ fullMatch: string; seriesId: string }> = [];
  const regex =
    /read\.csv\s*\(\s*(?:url\s*\(\s*)?["']https?:\/\/fred\.stlouisfed\.org\/graph\/fredgraph\.csv[?][^"']*\bid=([A-Z0-9_]+)[^"']*["']\s*(?:\))?\s*\)/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    results.push({ fullMatch: match[0], seriesId: match[1] });
  }
  return results;
}

function findGetSymbolsCalls(
  code: string,
  source: "yahoo" | "FRED"
): Array<{ fullMatch: string; ticker: string }> {
  const results: Array<{ fullMatch: string; ticker: string }> = [];
  const needle = "getSymbols(";
  let searchFrom = 0;
  while (true) {
    const callStart = code.indexOf(needle, searchFrom);
    if (callStart === -1) break;
    const openParen = callStart + needle.length - 1; // index of '('
    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") {
        depth--;
        if (depth === 0) { closeParen = i; break; }
      }
    }
    if (closeParen === -1) { searchFrom = callStart + 1; continue; }
    const fullMatch = code.slice(callStart, closeParen + 1);
    const argsStr = code.slice(openParen + 1, closeParen);
    const srcRe = new RegExp(`\\bsrc\\s*=\\s*['"]${source}['"]`, "i");
    if (!srcRe.test(argsStr)) { searchFrom = closeParen + 1; continue; }
    // First quoted string in the args is the ticker/series ID
    const tickerMatch = argsStr.match(/^\s*['"]([^'"]+)['"]/);
    if (!tickerMatch) { searchFrom = closeParen + 1; continue; }
    results.push({ fullMatch, ticker: tickerMatch[1] });
    searchFrom = closeParen + 1;
  }
  return results;
}

/**
 * Injects real data into R code server-side so the R execution sandbox
 * does not need any outbound network access.
 *
 * Handles three patterns (all with optional whitespace around "="):
 *   1. read.csv("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES")
 *   2. getSymbols("SERIES", src = "FRED", auto.assign = FALSE)
 *   3. getSymbols("TICKER", src = "yahoo", auto.assign = FALSE)
 */
async function injectDataSources(code: string, fredApiKey: string): Promise<string> {
  // --- FRED read.csv() intercept ---
  if (fredApiKey) {
    const fredCsvMatches = findFredCsvCalls(code);
    for (const { fullMatch, seriesId } of fredCsvMatches) {
      try {
        const fredUrl =
          `https://api.stlouisfed.org/fred/series/observations` +
          `?series_id=${encodeURIComponent(seriesId)}&api_key=${fredApiKey}` +
          `&file_type=json&observation_start=1990-01-01&sort_order=asc`;
        const fredRes = await fetch(fredUrl);
        if (!fredRes.ok) continue;
        const fredData = (await fredRes.json()) as { observations?: { date: string; value: string }[] };
        const obs = (fredData.observations ?? []).filter((o) => o.value !== "." && o.value !== "");
        if (obs.length === 0) continue;
        const dates = obs.map((o) => `"${o.date}"`).join(",");
        const values = obs.map((o) => o.value).join(",");
        const inlineR = `data.frame(DATE=as.Date(c(${dates})), ${seriesId}=as.numeric(c(${values})))`;
        code = code.replace(fullMatch, inlineR);
      } catch {
        // Leave unchanged — R will fail with a clear error message
      }
    }
  }

  // --- FRED getSymbols() intercept ---
  // Use regex so "src = "FRED"" (spaces around =) is also detected.
  if (fredApiKey && /src\s*=\s*["']FRED["']/i.test(code)) {
    const fredMatches = findGetSymbolsCalls(code, "FRED");
    for (const { fullMatch, ticker: seriesId } of fredMatches) {
      try {
        const fredUrl =
          `https://api.stlouisfed.org/fred/series/observations` +
          `?series_id=${encodeURIComponent(seriesId)}&api_key=${fredApiKey}` +
          `&file_type=json&observation_start=1990-01-01&sort_order=asc`;
        const fredRes = await fetch(fredUrl);
        if (!fredRes.ok) continue;
        const fredData = (await fredRes.json()) as { observations?: { date: string; value: string }[] };
        const obs = (fredData.observations ?? []).filter((o) => o.value !== "." && o.value !== "");
        if (obs.length === 0) continue;
        const dates = obs.map((o) => `"${o.date}"`).join(",");
        const values = obs.map((o) => o.value).join(",");
        const inlineR = `xts::xts(as.numeric(c(${values})), order.by=as.Date(c(${dates})))`;
        code = code.replace(fullMatch, inlineR);
      } catch {
        // Leave unchanged — R will fail with a clear error message
      }
    }
  }

  // --- Yahoo Finance getSymbols() intercept ---
  // Use regex so "src = "yahoo"" (spaces around =) is also detected.
  if (/src\s*=\s*["']yahoo["']/i.test(code)) {
    const yahooMatches = findGetSymbolsCalls(code, "yahoo");
    if (yahooMatches.length > 0) {
      const injections = await Promise.all(
        yahooMatches.map(async (match) => {
          const { fullMatch, ticker } = match;
          const encoded = encodeURIComponent(ticker);
          const urlCandidates = [
            `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=15y`,
            `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=15y`,
            `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1mo&range=15y`,
          ];
          for (const yahooUrl of urlCandidates) {
            try {
              const yahooRes = await fetch(yahooUrl);
              if (!yahooRes.ok) continue;
              const yahooData = (await yahooRes.json()) as {
                chart?: {
                  result?: Array<{
                    timestamp?: number[];
                    indicators?: { quote?: Array<{ close?: (number | null)[] }>; adjclose?: Array<{ adjclose?: (number | null)[] }> };
                  }>;
                };
              };
              const chartResult = yahooData.chart?.result?.[0];
              const timestamps = chartResult?.timestamp;
              const closes =
                chartResult?.indicators?.adjclose?.[0]?.adjclose ??
                chartResult?.indicators?.quote?.[0]?.close;
              if (!timestamps || !closes || timestamps.length === 0) continue;
              const dailyPairs: { date: string; close: number }[] = [];
              for (let i = 0; i < timestamps.length; i++) {
                const c = closes[i];
                if (c == null || isNaN(c)) continue;
                dailyPairs.push({ date: new Date(timestamps[i] * 1000).toISOString().split("T")[0], close: c });
              }
              if (dailyPairs.length === 0) continue;
              // Aggregate daily → monthly: take last close per YYYY-MM
              const monthlyMap = new Map<string, { date: string; close: number }>();
              for (const p of dailyPairs) {
                const ym = p.date.slice(0, 7);
                monthlyMap.set(ym, p);
              }
              const monthlyPairs = Array.from(monthlyMap.values());
              if (monthlyPairs.length === 0) continue;
              const datesStr = monthlyPairs.map((p) => `"${p.date}"`).join(",");
              const closesStr = monthlyPairs.map((p) => p.close).join(",");
              const colName = `${ticker.replace(/[^A-Za-z0-9]/g, ".")}.Close`;
              const inlineR =
                `local({ tmp <- xts::xts(as.numeric(c(${closesStr})), ` +
                `order.by=as.Date(c(${datesStr}))); colnames(tmp) <- "${colName}"; tmp })`;
              return { fullMatch, inlineR };
            } catch {
              continue;
            }
          }
          return null; // all candidates failed; R falls back to live getSymbols()
        })
      );
      for (const inj of injections) {
        if (inj) code = code.replace(inj.fullMatch, inj.inlineR);
      }
    }
  }

  return code;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      code?: string;
      prompt?: string;
      attempt?: number;
      previousCorrections?: { error: string }[];
    };
    const { code, attempt = 1, previousCorrections = [] } = body;
    if (!code || typeof code !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid code" },
        { status: 400 }
      );
    }

    let codeToRun = code;
    // Convert JS-style // comments to R # comments (Claude sometimes outputs these)
    codeToRun = codeToRun.replace(/^\/\//gm, "#");
    codeToRun = await sanitizeRCode(codeToRun);

    // Server-side data injection: replace all getSymbols() / read.csv(FRED) calls
    // with inline xts/data.frame objects so R needs zero outbound network access.
    const fredApiKey = process.env.FRED_API_KEY ?? "";
    // Guard: if the code needs FRED but the key is absent, fail fast with a clear message.
    // Use a regex so "src = "FRED"" (spaces around =) is caught as well.
    const needsFred =
      /src\s*=\s*["']FRED["']/i.test(codeToRun) ||
      codeToRun.includes("fred.stlouisfed.org");
    if (needsFred && !fredApiKey) {
      return NextResponse.json({
        success: false,
        stdout: "",
        stderr: "",
        exitCode: 1,
        interpretation: "",
        economicValidation: "",
        chartData: null,
        error: "FRED_API_KEY is not configured",
        dataUnavailable: true,
        userMessage:
          "FRED_API_KEY is not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html, then add FRED_API_KEY=your_key to your .env.local file and restart the server.",
      });
    }

    codeToRun = await injectDataSources(codeToRun, fredApiKey);

    // Logical completeness check: find variables used in merge() and verify
    // each has an assignment (<-) earlier in the code. Claude sometimes generates
    // a valid-looking script (with # END OF SCRIPT) that is missing entire sections
    // (e.g. FRED data loading or the log-returns line for Yahoo tickers).
    const mergeVarMatch = codeToRun.match(/\bmerge\s*\(([^)]+)\)/);
    const mergeVars = mergeVarMatch
      ? mergeVarMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => /^[a-z][a-z0-9_.]*$/.test(s))
      : [];
    const undefinedMergeVars = mergeVars.filter(
      (v) => !new RegExp(`\\b${v}\\s*<-`).test(codeToRun)
    );
    const isLogicallyIncomplete =
      undefinedMergeVars.length > 0 ||
      // spy_monthly defined but spy log-return line is missing
      (/spy_monthly\s*<-/.test(codeToRun) && !/\bspy\s*<-/.test(codeToRun));

    if (!codeToRun.includes("# END OF SCRIPT") || isLogicallyIncomplete) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const client = new Anthropic({ apiKey });
          const incompleteMsg = isLogicallyIncomplete && codeToRun.includes("# END OF SCRIPT")
            ? `This R script is structurally complete but logically incomplete — the following variables are used in merge() but never defined: ${undefinedMergeVars.join(", ")}. Add the missing getSymbols() calls (src="FRED" or src="yahoo") and transformations in the correct position. NEVER use synthetic data or NULL fallbacks — use real getSymbols() calls, exact syntax, no spaces around =. Return the full corrected script:`
            : "Your R code was cut off, please complete it. NEVER use synthetic placeholder data:";
          const msg = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            system: COMPLETE_SCRIPT_PROMPT,
            messages: [{ role: "user", content: incompleteMsg + "\n\n" + codeToRun }],
          });
          const textBlock = msg.content.find((b) => b.type === "text");
          if (textBlock && "text" in textBlock) {
            let completed = (textBlock as { text: string }).text.trim();
            const codeFence = completed.match(/```(?:r)?\s*([\s\S]*?)```/);
            if (codeFence) completed = codeFence[1].trim();
            if (completed.length > 0) {
              codeToRun = completed;
              // Re-inject data sources: the completed code may contain new
              // getSymbols() calls that were not yet replaced with inline data.
              codeToRun = await injectDataSources(codeToRun, fredApiKey);
            }
          }
        } catch (e) {
          console.error("Failed to complete truncated R code:", e);
        }
      }
    }

    const result = await runRCode(codeToRun);

    // R scripts use tryCatch which catches errors and exits with code 0.
    // Detect tryCatch-caught errors by looking for "ERROR:" lines in stdout.
    const rTryCatchError = /(?:^|\n)ERROR:/m.test(result.stdout);
    const isFailure = result.exitCode !== 0 || rTryCatchError;
    const runError = result.stderr || (rTryCatchError ? result.stdout : "") || result.stdout || "R script failed";
    if (isFailure && attempt < MAX_ATTEMPTS && isErrorFixable(runError)) {
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

    if (isFailure) {
      const userMessage = !isErrorFixable(runError)
        ? "Data or series unavailable (e.g. symbol/series not found). Check tickers and date range; no automatic fix was attempted."
        : undefined;
      return NextResponse.json({
        success: false,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        interpretation: "",
        economicValidation: "",
        chartData: null,
        error: result.stderr || result.stdout || "R script failed",
        dataUnavailable: !isErrorFixable(runError),
        userMessage,
      });
    }

    let chartData: Record<string, unknown> | null = null;
    const BEGIN = "---CHART_DATA_BEGIN---";
    const END = "---CHART_DATA_END---";
    const beginIdx = result.stdout.indexOf(BEGIN);
    const endIdx = result.stdout.indexOf(END);
    if (beginIdx >= 0 && endIdx > beginIdx) {
      const jsonStr = result.stdout.slice(beginIdx + BEGIN.length, endIdx).trim();
      try {
        chartData = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        // leave chartData null
      }
    } else {
      // Fallback: legacy CHART_DATA: format
      const chartIdx = result.stdout.indexOf("CHART_DATA:");
      if (chartIdx >= 0) {
        const after = result.stdout.slice(chartIdx + "CHART_DATA:".length);
        const first = after.indexOf("{");
        if (first !== -1) {
          let d = 0, last = -1;
          for (let i = first; i < after.length; i++) {
            if (after[i] === "{") d++;
            else if (after[i] === "}") { d--; if (d === 0) { last = i; break; } }
          }
        if (last !== -1) {
          try {
            chartData = JSON.parse(after.slice(first, last + 1)) as Record<string, unknown>;
          } catch {
            // leave chartData null
          }
        }}
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
