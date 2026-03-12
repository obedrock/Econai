export type VerifyResult = {
  source: "FRED" | "yahoo";
  verified: boolean;
  id: string;
  name?: string;
  suggestion?: string;
  matches?: { id: string; name: string; frequency?: string; lastUpdated?: string }[];
};

import { getCachedFRED, setCachedFRED, getCachedYahoo, setCachedYahoo } from "./data-cache";

export async function verifyFRED(term: string, apiKey: string): Promise<VerifyResult> {
  if (!apiKey || !term.trim()) {
    return { source: "FRED", verified: false, id: term.trim() || "?", name: undefined, suggestion: "FRED_API_KEY required" };
  }
  const cached = await getCachedFRED(term);
  if (cached != null && typeof cached === "object" && "source" in cached) {
    return cached as VerifyResult;
  }
  try {
    const url = `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(term.trim())}&api_key=${apiKey}&file_type=json&limit=3`;
    const res = await fetch(url);
    if (!res.ok) return { source: "FRED", verified: false, id: term, name: undefined, suggestion: "FRED search failed" };
    const data = (await res.json()) as { seriess?: Array<{ id: string; title: string; frequency_short?: string; last_updated?: string }> };
    const series = data.seriess ?? [];
    const top3 = series.slice(0, 3).map((s) => ({
      id: s.id,
      name: s.title,
      frequency: s.frequency_short,
      lastUpdated: s.last_updated,
    }));
    if (top3.length === 0) {
      return { source: "FRED", verified: false, id: term, name: undefined, suggestion: `No FRED series found for "${term}"`, matches: [] };
    }
    const best = top3[0];
    const result: VerifyResult = {
      source: "FRED",
      verified: true,
      id: best.id,
      name: best.name,
      suggestion: `Use ${best.id} for ${best.name}`,
      matches: top3,
    };
    await setCachedFRED(term, result);
    return result;
  } catch (e) {
    return {
      source: "FRED",
      verified: false,
      id: term,
      name: undefined,
      suggestion: errMessage(e),
    };
  }
}

export async function verifyYahoo(ticker: string): Promise<VerifyResult> {
  const t = ticker.trim();
  if (!t) return { source: "yahoo", verified: false, id: "?", name: undefined, suggestion: "Ticker required" };
  const cached = await getCachedYahoo(t);
  if (cached != null && typeof cached === "object" && "source" in cached) {
    return cached as VerifyResult;
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=5d`;
    const res = await fetch(url);
    if (!res.ok) return { source: "yahoo", verified: false, id: t, name: undefined, suggestion: "Chart request failed" };
    const data = (await res.json()) as { chart?: { result?: Array<{ meta?: { symbol?: string; shortName?: string } }> } };
    const result = data.chart?.result;
    if (!result || result.length === 0) {
      return { source: "yahoo", verified: false, id: t, name: undefined, suggestion: `No data for ticker "${t}"` };
    }
    const meta = result[0].meta;
    const symbol = meta?.symbol ?? t;
    const name = meta?.shortName ?? symbol;
    const verifyResult: VerifyResult = {
      source: "yahoo",
      verified: true,
      id: symbol,
      name,
      suggestion: `Use ${symbol} for ${name}`,
    };
    await setCachedYahoo(t, verifyResult);
    return verifyResult;
  } catch (e) {
    return { source: "yahoo", verified: false, id: t, name: undefined, suggestion: errMessage(e) };
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Request failed";
}

export async function verifyData(source: "FRED" | "yahoo", term: string, fredApiKey?: string): Promise<VerifyResult> {
  if (source === "FRED") return verifyFRED(term, fredApiKey ?? "");
  return verifyYahoo(term);
}
