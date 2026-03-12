import { NextResponse } from "next/server";
import { saveRegression } from "@/lib/db";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      prompt?: string;
      r_code?: string;
      output?: string;
      interpretation?: string;
      economic_validation?: string | null;
      chart_data?: string | null;
    };
    const { prompt, r_code, output, interpretation, economic_validation, chart_data } = body;
    if (!prompt || typeof prompt !== "string" || !r_code || typeof r_code !== "string" || !output) {
      return NextResponse.json({ error: "Missing prompt, r_code, or output" }, { status: 400 });
    }
    saveRegression({
      prompt: prompt.trim(),
      r_code,
      output,
      interpretation: typeof interpretation === "string" ? interpretation : "",
      economic_validation: typeof economic_validation === "string" ? economic_validation : null,
      chart_data: chart_data ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Save regression error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 500 }
    );
  }
}
