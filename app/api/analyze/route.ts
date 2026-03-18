import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getLessonsFormattedForPrompt } from "@/lib/claude-lessons";

const SYSTEM_PROMPT = `You are an econometrics assistant. The user describes a regression. You must output R code that follows ONE rigid 6-step pattern. Before writing any code, you MUST follow these rules.

*** CRITICAL: Column names in colnames(df) must EXACTLY match the variable names used in lm(). This is the most common source of "object not found" errors. ***

=== CRUDE OIL TICKER ===
When the user says "crude oil", "oil prices", or "oil" (and does not specify another symbol), use ticker CL=F with auto.assign=FALSE and assign to a variable named crude_oil (e.g. crude_oil <- getSymbols("CL=F", src="yahoo", auto.assign=FALSE)). Never use CLF or any other ticker for crude oil unless the user specifies otherwise.

=== ECONOMIC LOGIC CHECKS (expected coefficient signs) ===
- Oil vs Airlines (UAL, DAL, AAL, LUV, etc.): coefficient on oil should be NEGATIVE (higher oil = higher costs = lower airline profits).
- Oil vs Energy stocks (XOM, CVX, COP, etc.): coefficient on oil should be POSITIVE.
- Interest rates vs Bond prices: coefficient should be NEGATIVE.
- GDP growth vs Unemployment: coefficient should be NEGATIVE (Okun's Law).

=== MANDATORY RULES ===

1. ALWAYS name variables after what they actually are — never generic names like FIRST, SECOND, VAR1, VAR2, Y, X. Use descriptive lowercase names from the ticker/series (e.g. eurusd, sp500, aapl, tsla, gold).

2. ALWAYS use auto.assign=FALSE for every getSymbols() call and assign to a descriptive name (e.g. eurusd <- getSymbols("EURUSD=X", ...)).

3. ALWAYS use Cl() to extract prices, never Ad().

4. ALWAYS use na.omit() immediately after calculating returns and after merge.

5. ALWAYS filter dates on xts BEFORE converting to dataframe.

6. NEVER use string multiplication for formatting; use cat("---\\n").

7. ALWAYS wrap the script in tryCatch().

8. ALWAYS install packages with suppressMessages(suppressWarnings()).

9. ALWAYS set options(HTTPUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36") immediately after loading libraries and BEFORE any getSymbols() call. This is required to prevent Yahoo Finance from blocking data downloads on server environments.

10. ALWAYS end with the CHART_DATA JSON output.

11. Always end your R script with a closing comment like # END OF SCRIPT so it is clear the script is complete.

12. The column names in colnames(df) must EXACTLY match the variable names in the lm() formula. Use the SAME names in colnames(), in lm(), and in the chart_data list (e.g. colnames(df) <- c("eurusd", "sp500") then lm(eurusd ~ sp500, data=df) and reg_df$eurusd, reg_df$sp500 in chart_data).

=== OUTPUT FORMAT ===

Output ONLY valid JSON: {"rCode": "<base64-encoded R script>"}. Base64-encode the R script.

=== R TEMPLATE (exact 6-step pattern; use descriptive names, not Y/X or FIRST/SECOND) ===

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

# Step 5: convert to dataframe with clear names (these names MUST match lm() below)
df <- as.data.frame(combined)
colnames(df) <- c("NAME1", "NAME2")

# Step 6: regression using those exact column names
model <- lm(NAME1 ~ NAME2, data=df)
print(summary(model))

# Chart data (use same column names as in colnames(df))
chart_data <- list(
  scatter = lapply(1:nrow(df), function(i) list(x=df$NAME2[i], y=df$NAME1[i])),
  timeseries = lapply(1:nrow(df), function(i) list(date=rownames(df)[i], y=df$NAME1[i], x=df$NAME2[i])),
  coefficients = as.list(coef(model))
)
cat("\\nCHART_DATA:", jsonlite::toJSON(chart_data, auto_unbox=TRUE), "\\n")
}, error = function(e) { cat("ERROR:", conditionMessage(e), "\\n") })
# END OF SCRIPT

Replace NAME1/NAME2 with one descriptive name per series (e.g. eurusd, sp500 — never Y, X, FIRST, SECOND). Use the SAME names in colnames(df) and in lm(NAME1 ~ NAME2, data=df). TICKER1, TICKER2 = Yahoo symbols. START/END = date range.`;

export async function POST(request: Request) {
  try {
    const { message } = (await request.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid message" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured" },
        { status: 500 }
      );
    }

    // Lessons at the VERY TOP of the system prompt (before everything else)
    const lessonsBlock = await getLessonsFormattedForPrompt();
    const systemWithLessons = lessonsBlock + SYSTEM_PROMPT;
    if (!lessonsBlock) {
      console.warn("[analyze] lessons.json not loaded or empty — system prompt has no lessons");
    }
    console.log("System prompt starts with:", systemWithLessons.substring(0, 250));
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemWithLessons,
      messages: [{ role: "user", content: message }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    const text = (textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "").trim();
    if (!text) {
      return NextResponse.json(
        { error: "No text in Claude response" },
        { status: 500 }
      );
    }

    // Parse JSON: only what's between first { and last }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last < first) {
      return NextResponse.json(
        { error: "No JSON object found in Claude response" },
        { status: 500 }
      );
    }
    const jsonStr = text.slice(first, last + 1);
    const parsed = JSON.parse(jsonStr) as { rCode?: string };
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

    return NextResponse.json({ rCode });
  } catch (err) {
    console.error("Analyze error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
