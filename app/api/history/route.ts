import { NextResponse } from "next/server";
import { getAllRegressions } from "@/lib/db";

export async function GET() {
  try {
    const rows = getAllRegressions();
    return NextResponse.json(rows);
  } catch (err) {
    console.error("History error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load history" },
      { status: 500 }
    );
  }
}
