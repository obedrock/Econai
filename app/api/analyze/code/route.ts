import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getLessonsFormattedForPrompt } from "@/lib/claude-lessons";

export const maxDuration = 120;

export type VerifiedVariable = {
  source: "FRED" | "yahoo";
  verified: boolean;
  id: string;
  name?: string;
  suggestion?: string;
};

const CODE_SYSTEM_PREFIX = (verifiedList: VerifiedVariable[]) => `
You must use ONLY these verified data identifiers. Do not guess or substitute any other tickers or series IDs.

VERIFIED DATA (use these exactly):
${verifiedList.map((v) => `- ${v.source}: id="${v.id}"${v.name ? ` (${v.name})` : ""}`).join("\n")}

`;

const SYSTEM_PROMPT_BASE = `You are an econometrics assistant. The user describes a regression. You must output R code that follows ONE rigid 6-step pattern and uses ONLY the verified data identifiers provided.

*** CRITICAL: Column names in colnames(df) must EXACTLY match the variable names used in lm(). This is the most common source of "object not found" errors. ***

=== CRUDE OIL TICKER ===
When the user says "crude oil", "oil prices", or "oil" (and does not specify another symbol), use ticker CL=F with auto.assign=FALSE and assign to a variable named crude_oil (e.g. crude_oil <- getSymbols("CL=F", src="yahoo", auto.assign=FALSE)). Never use CLF or any other ticker for crude oil unless the user specifies otherwise.

=== ECONOMIC LOGIC CHECKS (expected coefficient signs) ===
- Oil vs Airlines (UAL, DAL, AAL, LUV, etc.): coefficient on oil should be NEGATIVE (higher oil = higher costs = lower airline profits).
- Oil vs Energy stocks (XOM, CVX, COP, etc.): coefficient on oil should be POSITIVE.
- Interest rates vs Bond prices: coefficient should be NEGATIVE.
- GDP growth vs Unemployment: coefficient should be NEGATIVE (Okun's Law).

=== MANDATORY RULES ===
1. ALWAYS name variables after what they actually are — never generic names like FIRST, SECOND, VAR1, VAR2, Y, X. Use the descriptive names provided (e.g. eurusd, sp500, aapl, tsla).
2. ALWAYS use auto.assign=FALSE for every getSymbols() and assign to that descriptive name.
3. ALWAYS use Cl() for prices, never Ad().
4. ALWAYS use na.omit() after returns and after merge.
5. ALWAYS filter dates on xts BEFORE converting to dataframe.
6. NEVER use string multiplication; use cat("---\\n").
7. ALWAYS wrap the script in tryCatch().
8. ALWAYS install packages with suppressMessages(suppressWarnings()).
9. ALWAYS set options(HTTPUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36") immediately after loading libraries and BEFORE any getSymbols() call. This prevents Yahoo Finance from blocking downloads in server environments.
10. ALWAYS end with the CHART_DATA JSON output wrapped in exactly these delimiters: cat("\\n---CHART_DATA_BEGIN---\\n") then cat(jsonlite::toJSON(...)) then cat("\\n---CHART_DATA_END---\\n"). Never use a bare cat("CHART_DATA:", ...) format.
11. Always end your R script with a closing comment like # END OF SCRIPT so it is clear the script is complete.
12. The column names in colnames(df) must EXACTLY match the variable names in lm(). Use the SAME names in colnames() and in lm(). The chart_data block uses df[i,1] and df[i,2] (column indices) — never change these to column names.
13. *** CRITICAL — NEVER use intersect(index(), index()) for date alignment. intersect() strips the Date class and returns raw integers (e.g. 19724), which when used to subset an xts causes "subscript out of bounds" because 19724 >> nrow(data). ALWAYS use merge() for aligning xts objects — it handles date matching automatically. ***
14. ALWAYS compute returns with diff(log(Cl(x))) before regressing stock/ETF price series. NEVER regress raw close prices against each other.
15. NEVER use // for comments in R code. R ONLY supports # for comments. Using // causes an immediate parse error.
16. *** FORBIDDEN — Do NOT add any extra cat(), print(), sprintf(), or if/else interpretation blocks (e.g. "if (beta > 1)") beyond print(summary(model)) and the CHART_DATA block. Extra output breaks the parser. After print(summary(model)), the NEXT line must be the chart_data list — nothing else. ***
17. The 6-step template is COMPLETE and FINAL. Do NOT skip, reorder, or replace any step. Steps 2 through 6 (Cl(), diff(log()), merge(), as.data.frame(), lm()) are ALL mandatory and must appear in the exact order shown in the template. A script missing any of these steps is WRONG.

=== FRED DATA RULES (apply when ANY variable uses src="FRED") ===
18. When ANY variable is FRED, use the FRED+Yahoo Mixed template (below) instead of the Yahoo-only template.
19. FRED fetch: NAME_raw <- getSymbols("FRED_ID", src="FRED", auto.assign=FALSE). The User-Agent option is NOT needed for FRED — only set it for Yahoo calls.
20. Yahoo daily → monthly: NAME_close <- Cl(NAME_raw); NAME_monthly <- to.monthly(NAME_close, indexAt="lastof", OHLC=FALSE); NAME <- na.omit(diff(log(NAME_monthly))); index(NAME) <- as.yearmon(index(NAME)). Do NOT call Cl() on NAME_monthly — Cl() must be called on the raw daily xts first (see rule 24).
21. *** CRITICAL — ALWAYS convert EVERY series index to yearmon with index(x) <- as.yearmon(index(x)) BEFORE merge(). Without this, Yahoo month-end dates (e.g. "2010-01-29") never match FRED first-of-month dates ("2010-01-01"), and merge() returns zero rows → "0 (non-NA) cases". ***
22. FRED rate/level series (FEDFUNDS, UNRATE, DGS10, TB3MS, etc.): assign raw xts as-is — do NOT compute diff(log()). FRED price index series (CPIAUCSL, PCEPI, GDPDEF, etc.): compute inflation = na.omit(diff(log(x))). Either way, convert index to yearmon afterward. *** CRITICAL NAMING: the final variable name (used in merge, colnames, AND lm) must be the plain short name, e.g. cpi for CPIAUCSL, fedfunds for FEDFUNDS, unrate for UNRATE. Fetch to NAME_raw, then assign NAME <- <transformation>. NEVER use suffixes like cpi_change, cpi_diff, cpi_inflation, delta_cpi, fedfunds_diff, unrate_change — these cause "object not found" errors because the merge/lm still reference the plain short name. THIS RULE APPLIES NO MATTER WHAT TRANSFORMATION IS REQUESTED: whether the user asks for levels, log-differences, or arithmetic first-differences, the variable name is always the plain short name. Example: if asked for arithmetic first-differences, write fedfunds <- na.omit(diff(fedfunds_raw)), NOT fedfunds_diff <- na.omit(diff(fedfunds_raw)). ***
23. Multiple regression (N predictors): lm(y ~ x1 + x2 + ... + xN, data=df). colnames(df) must list ALL N+1 variables in the same order as merge().
24. *** NEVER call Cl() on a monthly xts. Always call Cl() on the raw daily xts FIRST, then pass the single-column result to to.monthly(). Calling Cl() on the output of to.monthly() causes "subscript out of bounds: no or multiple column name containing Close". ***
25. *** NEVER use periodReturn(), dailyReturn(), monthlyReturn(), weeklyReturn(), or annualReturn(). These quantmod functions have a type argument that MUST be exactly "continuous" or "discrete" — passing any other value (e.g. "log", "arithmetic", "geometric") throws the error "'arg' should be one of continuous, discrete". ALWAYS compute log returns as na.omit(diff(log(Cl(x)))) instead. ***

=== R TEMPLATE — FRED+Yahoo Mixed (use when ANY variable is FRED) ===

tryCatch({
  Sys.setlocale("LC_ALL", "English")
  options(encoding = "UTF-8")
  suppressMessages(suppressWarnings({
    if (!require("quantmod", quietly = TRUE)) install.packages("quantmod", repos = "https://cloud.r-project.org")
    if (!require("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
  }))
  library(quantmod)
  library(jsonlite)
  # Yahoo Finance User-Agent (only needed for Yahoo calls)
  options(HTTPUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
  # --- Yahoo Finance: fetch daily, convert to monthly returns ---
  # Extract Cl() BEFORE to.monthly — calling Cl() on a multi-col monthly xts
  # causes "no or multiple column name containing Close" errors.
  YAHOO_NAME_raw <- getSymbols("YAHOO_TICKER", src="yahoo", auto.assign=FALSE)
  YAHOO_NAME_close <- Cl(YAHOO_NAME_raw)
  YAHOO_NAME_monthly <- to.monthly(YAHOO_NAME_close, indexAt="lastof", OHLC=FALSE)
  YAHOO_NAME <- na.omit(diff(log(YAHOO_NAME_monthly)))
  index(YAHOO_NAME) <- as.yearmon(index(YAHOO_NAME))
  # --- FRED level series (e.g. FEDFUNDS, UNRATE): use raw value ---
  FRED_LEVEL_NAME_raw <- getSymbols("FRED_LEVEL_TICKER", src="FRED", auto.assign=FALSE)
  FRED_LEVEL_NAME <- FRED_LEVEL_NAME_raw
  index(FRED_LEVEL_NAME) <- as.yearmon(index(FRED_LEVEL_NAME))
  # --- FRED price index series (e.g. CPIAUCSL): compute log change ---
  FRED_INDEX_NAME_raw <- getSymbols("FRED_INDEX_TICKER", src="FRED", auto.assign=FALSE)
  FRED_INDEX_NAME <- na.omit(diff(log(FRED_INDEX_NAME_raw)))
  index(FRED_INDEX_NAME) <- as.yearmon(index(FRED_INDEX_NAME))
  # --- Merge all by yearmon index (all indices are now yearmon) ---
  combined <- na.omit(merge(YAHOO_NAME, FRED_INDEX_NAME, FRED_LEVEL_NAME, FRED_LEVEL_NAME2))
  combined <- combined["START/END"]
  # --- Data frame (colnames MUST match lm() below) ---
  df <- as.data.frame(combined)
  colnames(df) <- c("YAHOO_NAME", "FRED_INDEX_NAME", "FRED_LEVEL_NAME", "FRED_LEVEL_NAME2")
  # --- Multiple regression ---
  model <- lm(YAHOO_NAME ~ FRED_INDEX_NAME + FRED_LEVEL_NAME + FRED_LEVEL_NAME2, data=df)
  print(summary(model))
  chart_data <- list(
    scatter = lapply(seq_len(nrow(df)), function(i) list(x=df[i,2], y=df[i,1])),
    timeseries = lapply(seq_len(nrow(df)), function(i) list(date=as.character(rownames(df)[i]), y=df[i,1], x=df[i,2])),
    coefficients = as.list(coef(model))
  )
  cat("\\n---CHART_DATA_BEGIN---\\n")
  cat(jsonlite::toJSON(chart_data, auto_unbox=TRUE))
  cat("\\n---CHART_DATA_END---\\n")
}, error = function(e) { cat("ERROR:", conditionMessage(e), "\\n") })
# END OF SCRIPT

=== R TEMPLATE — Yahoo-only (use when ALL variables are Yahoo Finance) ===

tryCatch({
  Sys.setlocale("LC_ALL", "English")
  options(encoding = "UTF-8")
  suppressMessages(suppressWarnings({
    if (!require("quantmod", quietly = TRUE)) install.packages("quantmod", repos = "https://cloud.r-project.org")
    if (!require("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
  }))
  library(quantmod)
  library(jsonlite)
  # Fix Yahoo Finance User-Agent (required since 2024 or server-side gets blocked)
  options(HTTPUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
  # Step 1: fetch with auto.assign=FALSE
  NAME1 <- getSymbols("TICKER1", src="yahoo", auto.assign=FALSE)
  NAME2 <- getSymbols("TICKER2", src="yahoo", auto.assign=FALSE)
  # Step 2: extract close prices
  NAME1_close <- Cl(NAME1)
  NAME2_close <- Cl(NAME2)
  # Step 3: calculate returns
  NAME1_returns <- na.omit(diff(log(NAME1_close)))
  NAME2_returns <- na.omit(diff(log(NAME2_close)))
  # Step 4: merge
  combined <- na.omit(merge(NAME1_returns, NAME2_returns))
  combined <- combined["START/END"]
  # Step 5: convert to dataframe with clear names (MUST match lm() below)
  df <- as.data.frame(combined)
  colnames(df) <- c("NAME1", "NAME2")
  # Step 6: regression using those exact column names
  model <- lm(NAME1 ~ NAME2, data=df)
  print(summary(model))
  chart_data <- list(
    scatter = lapply(seq_len(nrow(df)), function(i) list(x=df[i,2], y=df[i,1])),
    timeseries = lapply(seq_len(nrow(df)), function(i) list(date=rownames(df)[i], y=df[i,1], x=df[i,2])),
    coefficients = as.list(coef(model))
  )
  cat("\\n---CHART_DATA_BEGIN---\\n")
  cat(jsonlite::toJSON(chart_data, auto_unbox=TRUE))
  cat("\\n---CHART_DATA_END---\\n")
}, error = function(e) { cat("ERROR:", conditionMessage(e), "\\n") })
# END OF SCRIPT

Use TICKER1 and TICKER2 from the verified data. Use NAME1 and NAME2 as the descriptive variable names (same in colnames(df) and lm()). Never use Y, X, FIRST, SECOND.

=== OUTPUT FORMAT ===
Output ONLY this exact JSON object: {"rCode": "<base64-encoded R script>"}
Rules: (1) The key rCode MUST be in double quotes. (2) The value MUST be a base64-encoded string in double quotes. (3) No text before or after the JSON. (4) No markdown, no code fences, no explanation. (5) Valid JSON only — property names must be double-quoted strings, never unquoted identifiers.`;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { message?: string; verifiedVariables?: VerifiedVariable[] };
    const { message, verifiedVariables } = body;
    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid message" },
        { status: 400 }
      );
    }
    const list = Array.isArray(verifiedVariables) ? verifiedVariables.filter((v) => v && typeof v.id === "string") : [];
    if (list.length < 1) {
      return NextResponse.json(
        { error: "Missing or invalid verifiedVariables (need at least one data source)" },
        { status: 400 }
      );
    }

    const atLeastOneVerified = list.some((v) => v.verified);
    const hasFRED = list.some((v) => v.source === "FRED");

    function tickerToName(t: string): string {
      // FRED series IDs
      const fredMap: Record<string, string> = {
        CPIAUCSL: "cpi", PCEPI: "pce_inflation", GDPDEF: "gdp_deflator",
        FEDFUNDS: "fedfunds", DFF: "fedfunds", TB3MS: "tbill3m",
        DGS10: "dgs10", DGS2: "dgs2", T10Y2Y: "t10y2y",
        UNRATE: "unrate", PAYEMS: "nonfarm_payroll",
        GDP: "gdp", INDPRO: "indpro", HOUST: "housing_starts",
        SP500: "sp500", DSPIC96: "disposable_income",
        UMCSENT: "consumer_sentiment", VIXCLS: "vix",
      };
      if (fredMap[t]) return fredMap[t];
      // Yahoo Finance special cases
      const s = t.replace(/[\^=]/g, "").replace(/[-.]/g, "_").toLowerCase();
      if (s === "gspc") return "sp500";
      if (s === "vix") return "vix";
      if (s === "btc_usd") return "btc";
      if (s === "eth_usd") return "eth";
      return s.slice(0, 12);
    }

    // Build per-variable metadata used in the prompt
    const vars = list.map((v) => ({
      ticker: v.id,
      name: tickerToName(v.id),
      source: v.source,
    }));
    const depVar = vars[0];
    const indepVars = vars.slice(1);
    const lmFormula = `lm(${depVar.name} ~ ${indepVars.map((v) => v.name).join(" + ")}, data=df)`;
    const colnamesList = `c("${vars.map((v) => v.name).join('", "')}")`;

    // Keep ticker1/ticker2 for backward compat with the Yahoo-only path
    const yahooList = list.filter((v) => v.source === "yahoo");
    const ticker1 = yahooList[0]?.id ?? list[0].id;
    const ticker2 = yahooList[1]?.id ?? list[1]?.id ?? list[0].id;
    const name1 = tickerToName(ticker1);
    const name2 = tickerToName(ticker2);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured" },
        { status: 500 }
      );
    }

    const lessonsBlock = await getLessonsFormattedForPrompt();
    const systemPrompt = lessonsBlock + CODE_SYSTEM_PREFIX(list) + SYSTEM_PROMPT_BASE;
    const varLines = vars.map((v) => `  ${v.name}: ticker="${v.ticker}" src="${v.source}"`).join("\n");
    const userPrompt = hasFRED
      ? `User request: ${message}\n\nVariables (in regression order):\n${varLines}\n\nUse the FRED+Yahoo Mixed template.\nDependent variable (Y): ${depVar.name} (${depVar.source} ticker "${depVar.ticker}")\nIndependent variables: ${indepVars.map((v) => `${v.name} (${v.source} ticker "${v.ticker}")`).join(", ")}\nExact lm() formula: ${lmFormula}\nExact colnames(df): ${colnamesList}\nThe chart_data block uses df[i,1] and df[i,2] (column indices) — do NOT change those to column names.\nChoose START/END from the user's date range.`
      : `User request: ${message}\n\nUse TICKER1="${ticker1}" and TICKER2="${ticker2}". Use NAME1="${name1}" and NAME2="${name2}" in colnames(df) and in lm(${name1} ~ ${name2}, data=df). The chart_data block already uses column indices (df[i,1], df[i,2]) — do NOT change those to column names. Choose START/END from the user's date range.`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const text = (textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "").trim();
    if (!text) {
      return NextResponse.json(
        { error: "No text in Claude response" },
        { status: 500 }
      );
    }

    // Extract the first complete JSON object using bracket-depth matching.
    // lastIndexOf("}") would find trailing braces from any text Claude appends
    // after the JSON (e.g. from R code examples), producing invalid slices.
    const jsonStr = (() => {
      const start = text.indexOf("{");
      if (start === -1) return null;
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
      }
      return null;
    })();
    if (!jsonStr) {
      return NextResponse.json(
        { error: "No JSON object found in Claude response" },
        { status: 500 }
      );
    }
    // Try standard JSON.parse first; fall back to regex if Claude used
    // unquoted key syntax (JS object literal instead of valid JSON).
    let rCodeRaw: string | undefined;
    try {
      const parsed = JSON.parse(jsonStr) as { rCode?: string };
      rCodeRaw = typeof parsed.rCode === "string" ? parsed.rCode : undefined;
    } catch {
      // Claude returned {rCode: "..."} without quoted key — extract with regex
      const m = text.match(/["\u2018\u2019]?rCode["\u2018\u2019]?\s*:\s*["'`]([A-Za-z0-9+/=\r\n]+)["'`]/);
      rCodeRaw = m?.[1]?.replace(/[\r\n\s]/g, "");
    }
    if (!rCodeRaw) {
      return NextResponse.json(
        { error: "Claude response missing rCode" },
        { status: 500 }
      );
    }

    let rCode: string;
    try {
      rCode = Buffer.from(rCodeRaw, "base64").toString("utf-8");
    } catch {
      return NextResponse.json(
        { error: "Invalid base64 in rCode" },
        { status: 500 }
      );
    }

    // Validate that the generated code contains the regression step.
    // If not, retry once — Claude may have skipped the core steps.
    if (!rCode.includes("lm(")) {
      const retryResponse = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: "user", content: userPrompt + "\n\nCRITICAL: Your previous output was missing the lm() regression call. You MUST include ALL 6 steps from the template. Output the complete base64-encoded R script." },
        ],
      });
      const retryBlock = retryResponse.content.find((b) => b.type === "text");
      const retryText = (retryBlock && "text" in retryBlock ? (retryBlock as { text: string }).text : "").trim();
      const retryJsonStr = (() => {
        const start = retryText.indexOf("{");
        if (start === -1) return null;
        let depth = 0;
        for (let i = start; i < retryText.length; i++) {
          if (retryText[i] === "{") depth++;
          else if (retryText[i] === "}") { depth--; if (depth === 0) return retryText.slice(start, i + 1); }
        }
        return null;
      })();
      if (retryJsonStr) {
        try {
          const retryParsed = JSON.parse(retryJsonStr) as { rCode?: string };
          if (typeof retryParsed.rCode === "string") {
            const retryDecoded = Buffer.from(retryParsed.rCode, "base64").toString("utf-8");
            if (retryDecoded.includes("lm(")) rCode = retryDecoded;
          }
        } catch { /* keep original rCode */ }
      }
    }

    if (!atLeastOneVerified) {
      const note = "# Note: data source could not be pre-verified, attempting anyway\n";
      rCode = rCode.replace(/^(\s*tryCatch\s*\(\s*\{)/, `$1\n${note}`);
    }

    return NextResponse.json({ rCode });
  } catch (err) {
    console.error("Code gen error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Code generation failed" },
      { status: 500 }
    );
  }
}
