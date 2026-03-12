import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const CACHE_DIR = process.cwd();
const FRED_CACHE_FILE = join(CACHE_DIR, "fred-cache.json");
const YAHOO_CACHE_FILE = join(CACHE_DIR, "yahoo-cache.json");

const FRED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const YAHOO_TTL_MS = 60 * 60 * 1000; // 1 hour

type FredCacheEntry = { result: unknown; fetchedAt: number };
type YahooCacheEntry = { result: unknown; fetchedAt: number };

async function readFredCache(): Promise<Record<string, FredCacheEntry>> {
  try {
    const raw = await readFile(FRED_CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, FredCacheEntry>;
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

async function readYahooCache(): Promise<Record<string, YahooCacheEntry>> {
  try {
    const raw = await readFile(YAHOO_CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, YahooCacheEntry>;
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

export async function getCachedFRED(term: string): Promise<unknown | null> {
  const key = term.trim().toLowerCase();
  if (!key) return null;
  const cache = await readFredCache();
  const entry = cache[key];
  if (!entry || Date.now() - entry.fetchedAt > FRED_TTL_MS) return null;
  return entry.result;
}

export async function setCachedFRED(term: string, result: unknown): Promise<void> {
  const key = term.trim().toLowerCase();
  if (!key) return;
  const cache = await readFredCache();
  cache[key] = { result, fetchedAt: Date.now() };
  await writeFile(FRED_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export async function getCachedYahoo(ticker: string): Promise<unknown | null> {
  const key = ticker.trim().toUpperCase();
  if (!key) return null;
  const cache = await readYahooCache();
  const entry = cache[key];
  if (!entry || Date.now() - entry.fetchedAt > YAHOO_TTL_MS) return null;
  return entry.result;
}

export async function setCachedYahoo(ticker: string, result: unknown): Promise<void> {
  const key = ticker.trim().toUpperCase();
  if (!key) return;
  const cache = await readYahooCache();
  cache[key] = { result, fetchedAt: Date.now() };
  await writeFile(YAHOO_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}
