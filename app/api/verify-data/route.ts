import { NextResponse } from "next/server";
import { verifyData } from "@/lib/verify-data";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { source?: string; term?: string };
    const { source, term } = body;
    if (!source || (source !== "FRED" && source !== "yahoo")) {
      return NextResponse.json(
        { error: "Missing or invalid source (must be FRED or yahoo)" },
        { status: 400 }
      );
    }
    if (typeof term !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid term" },
        { status: 400 }
      );
    }
    const fredKey = source === "FRED" ? process.env.FRED_API_KEY ?? "" : undefined;
    const result = await verifyData(source as "FRED" | "yahoo", term, fredKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Verify-data error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Verification failed" },
      { status: 500 }
    );
  }
}
