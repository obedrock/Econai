import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

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

If you end with ⚠️ Unexpected - possible data or model issue, append one additional line in this exact format:
SUGGESTED_FIX: <a short imperative follow-up the user should send to fix the issue>
Example: SUGGESTED_FIX: Re-run using month-over-month changes for all macro variables instead of levels
Do NOT add a SUGGESTED_FIX line for ✅ or 🔍 results.

Reply with only your validation text, no extra heading.`;

const MODEL = "claude-haiku-4-5-20251001";

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }
  try {
    const body = (await request.json()) as { output?: string; prompt?: string };
    const output = body.output ?? "";
    const prompt = body.prompt ?? "";
    if (!output.trim()) {
      return NextResponse.json({ economicValidation: "", suggestedFix: "" });
    }
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: ECONOMIC_VALIDATION_PROMPT,
      messages: [
        { role: "user", content: `User's regression request: ${prompt}\n\nRegression output:\n${output}` },
      ],
    });
    const textBlock = msg.content.find((b) => b.type === "text");
    const raw = (textBlock && "text" in textBlock ? (textBlock as { text: string }).text : "").trim();

    // Parse out the SUGGESTED_FIX line (only present for ⚠️ results)
    const fixMatch = raw.match(/\nSUGGESTED_FIX:\s*(.+)$/);
    const suggestedFix = fixMatch ? fixMatch[1].trim() : "";
    const economicValidation = fixMatch ? raw.slice(0, fixMatch.index).trim() : raw;

    return NextResponse.json({ economicValidation, suggestedFix });
  } catch (err) {
    console.error("Economic validation error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Validation failed" },
      { status: 500 }
    );
  }
}
