import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

const IDENTIFY_PROMPT = `You are an econometrics assistant. The user will describe a regression or analysis. Your ONLY job is to list every data series or variable needed to run that analysis.

Output ONLY valid JSON in this exact shape (no other text, no markdown):
{"variables": [{"source": "FRED" or "yahoo", "term": "search term or ticker symbol"}]}

Rules:
- source: Use "FRED" for macroeconomic data (interest rates, GDP, unemployment, inflation, etc.). Use "yahoo" for stocks, indices, forex, crypto, futures (anything from Yahoo Finance/quantmod).
- term: For FRED, use a short search term (e.g. "federal funds rate", "GDP", "unemployment"). For yahoo, use the exact ticker symbol (e.g. "AAPL", "^GSPC", "EURUSD=X", "GC=F", "BTC-USD").
- List every series the regression needs. For a simple "Y on X" regression you typically need 2 variables (e.g. one stock and one index). For interest rate differential you might need 2 FRED series.
- Output only the JSON object.`;

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

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: IDENTIFY_PROMPT,
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

    const first = text.indexOf("{");
    if (first === -1) {
      return NextResponse.json(
        { error: "No JSON object found in Claude response" },
        { status: 500 }
      );
    }
    // Use bracket-depth matching to find the first complete JSON object.
    // lastIndexOf("}") breaks when Claude appends trailing text with "}" chars.
    let depth = 0;
    let last = -1;
    for (let i = first; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { last = i; break; } }
    }
    if (last === -1) {
      return NextResponse.json(
        { error: "No JSON object found in Claude response" },
        { status: 500 }
      );
    }
    const parsed = JSON.parse(text.slice(first, last + 1)) as { variables?: Array<{ source?: string; term?: string }> };
    const variables = Array.isArray(parsed.variables) ? parsed.variables : [];
    const normalized = variables
      .filter((v) => v && (v.source === "FRED" || v.source === "yahoo") && typeof v.term === "string")
      .map((v) => ({ source: v.source as "FRED" | "yahoo", term: (v.term as string).trim() }));

    return NextResponse.json({ variables: normalized });
  } catch (err) {
    console.error("Identify error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Identification failed" },
      { status: 500 }
    );
  }
}
