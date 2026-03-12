import { NextResponse } from "next/server";
import { getLessonsCount, getAutoFixesCount } from "@/lib/claude-lessons";

export async function GET() {
  try {
    const [count, autoFixes] = await Promise.all([
      getLessonsCount(),
      getAutoFixesCount(),
    ]);
    return NextResponse.json({ count, autoFixes });
  } catch {
    return NextResponse.json({ count: 0, autoFixes: 0 });
  }
}
