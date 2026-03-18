import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getLessonsFormattedForPrompt } from "@/lib/claude-lessons";

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

=== OUTPUT FORMAT ===
Output ONLY valid JSON: {"rCode": "<base64-encoded R script>"}. Base64-encode the R script.

=== R TEMPLATE (exact 6-step pattern) ===

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

Use TICKER1 and TICKER2 from the verified data. Use NAME1 and NAME2 as the descriptive variable names (same in colnames(df) and lm()). Never use Y, X, FIRST, SECOND.`;

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
    const yahooList = list.filter((v) => v.source === "yahoo");
    const ticker1 = yahooList[0]?.id ?? list[0].id;
    const ticker2 = yahooList[1]?.id ?? list[1]?.id ?? list[0].id;

    function tickerToName(t: string): string {
      const s = t.replace(/[\^=]/g, "").replace(/[-.]/g, "_").toLowerCase();
      if (s === "gspc") return "sp500";
      if (s === "vix") return "vix";
      if (s === "btc_usd") return "btc";
      if (s === "eth_usd") return "eth";
      return s.slice(0, 12);
    }
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
    const userPrompt = `User request: ${message}\n\nUse TICKER1="${ticker1}" and TICKER2="${ticker2}". Use NAME1="${name1}" and NAME2="${name2}" in colnames(df) and in lm(${name1} ~ ${name2}, data=df). The chart_data block already uses column indices (df[i,1], df[i,2]) — do NOT change those to column names. Choose START/END from the user's date range.`;

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

    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) {
      return NextResponse.json(
        { error: "No JSON object found in Claude response" },
        { status: 500 }
      );
    }
    const parsed = JSON.parse(text.slice(first, last + 1)) as { rCode?: string };
    if (typeof parsed.rCode !== "string") {
      return NextResponse.json(
        { error: "Claude response missing rCode" },
        { status: 500 }
      );
    }

    let rCode: string;
    try {
      rCode = Buffer.from(parsed.rCode, "base64").toString("utf-8");
    } catch {
      return NextResponse.json(
        { error: "Invalid base64 in rCode" },
        { status: 500 }
      );
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
