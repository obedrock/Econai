import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const INTERPRETATION_PROMPT = `You are a senior analyst explaining regression output to a client. Given raw R output below, write a plain-English interpretation that:
1. Is 3-5 sentences, written like a senior analyst to a client.
2. Highlights the most important findings (key coefficients, significance, R-squared).
3. Flags any concerns (low R-squared, insignificant variables, etc.).
4. Ends with one practical "so what" takeaway.

Reply with only the interpretation text, no heading or markdown.`;

const MODEL = "claude-3-5-haiku-20241022";

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }
  try {
    const body = (await request.json()) as { output?: string };
    const output = body.output ?? "";
    if (!output.trim()) {
      return new Response("", { status: 200 });
    }
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 512,
      system: INTERPRETATION_PROMPT,
      messages: [{ role: "user", content: output }],
    });
    const readable = new ReadableStream({
      async start(controller) {
        try {
          stream.on("text", (textDelta: string) => {
            controller.enqueue(new TextEncoder().encode(textDelta));
          });
          await stream.finalMessage();
        } catch (e) {
          controller.error(e);
        } finally {
          controller.close();
        }
      },
    });
    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    console.error("Interpret stream error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Stream failed" },
      { status: 500 }
    );
  }
}
