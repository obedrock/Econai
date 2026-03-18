"use client";

import { useState, useEffect } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Scatter,
  Line,
  LineChart,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

type Step = "idle" | "analyzing" | "verifying" | "running" | "done" | "error";

type ChartData = {
  scatter?: { x: number; y: number }[];
  timeseries?: { date: string; y: number; x?: number }[];
  coefficients?: Record<string, number>;
};

type TurnOutput = {
  stdout: string;
  stderr: string;
  success: boolean;
  interpretation: string;
  economicValidation: string;
  chartData: ChartData | null;
};

type Turn = {
  prompt: string;
  rCode: string;
  output: TurnOutput;
};

type Conversation = {
  id: string;
  title: string;
  date: string;
  turns: Turn[];
};

type HistoryRow = {
  id: number;
  prompt: string;
  r_code: string;
  output: string;
  interpretation: string;
  economic_validation: string | null;
  chart_data: string | null;
  created_at: string;
};

const EXAMPLE_PROMPTS = [
  "Regress AAPL returns on S&P 500 returns (CAPM beta) since 2020",
  "Does Bitcoin predict gold prices? Test with 2019-2024 data",
  "Regress EUR/USD on the US-EU interest rate differential",
  "Fama-French: regress TSLA on market, SMB, HML factors",
];

function parseRegressionOutput(stdout: string): {
  coefficients: { term: string; estimate: number; stdError: number; tValue: number; pValue: number }[];
  rSquared: number | null;
  adjRSquared: number | null;
  raw: string;
} {
  const result = {
    coefficients: [] as { term: string; estimate: number; stdError: number; tValue: number; pValue: number }[],
    rSquared: null as number | null,
    adjRSquared: null as number | null,
    raw: stdout,
  };
  const lines = stdout.split("\n");
  const coefStart = lines.findIndex((l) => l.trim().startsWith("Coefficients:"));
  if (coefStart >= 0) {
    const dataStart = coefStart + 1;
    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith("---") || line.trim().startsWith("Signif.")) break;
      const match = line.match(/^(\S.+?)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+<]+)/);
      if (match) {
        const [, term, estimate, stdError, tValue, pValStr] = match;
        let pValue = parseFloat(pValStr);
        if (Number.isNaN(pValue) || pValStr.startsWith("<")) pValue = 0;
        result.coefficients.push({
          term: term.trim(),
          estimate: parseFloat(estimate) || 0,
          stdError: parseFloat(stdError) || 0,
          tValue: parseFloat(tValue) || 0,
          pValue,
        });
      }
    }
  }
  const r2Match = stdout.match(/Multiple R-squared:\s*([\d.]+)/);
  const adjMatch = stdout.match(/Adjusted R-squared:\s*([\d.]+)/);
  if (r2Match) result.rSquared = parseFloat(r2Match[1]);
  if (adjMatch) result.adjRSquared = parseFloat(adjMatch[1]);
  return result;
}

function highlightRCode(code: string) {
  const keywords = /\b(if|else|for|while|function|return|in|library|require)\b/g;
  const fnCalls = /\b(getSymbols|fredr_set_key|lm|summary|merge|Ad|Cl|diff|log|head|tail)\b/g;
  const strings = /(["'`])(?:\\.|(?!\1).)*\1/g;
  let html = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(strings, (m) => `<span class="text-emerald-400">${m}</span>`);
  html = html.replace(keywords, (m) => `<span class="text-blue-400">${m}</span>`);
  html = html.replace(fnCalls, (m) => `<span class="text-amber-300">${m}</span>`);
  return html;
}

function historyRowToConversation(row: HistoryRow): Conversation {
  let out: { stdout: string; stderr: string } = { stdout: row.output, stderr: "" };
  try {
    out = JSON.parse(row.output) as { stdout: string; stderr: string };
  } catch {
    // use as-is
  }
  let chartData: ChartData | null = null;
  if (row.chart_data) {
    try {
      chartData = JSON.parse(row.chart_data) as ChartData;
    } catch {
      // leave null
    }
  }
  const title = row.prompt.length > 48 ? row.prompt.slice(0, 48) + "…" : row.prompt;
  return {
    id: String(row.id),
    title,
    date: row.created_at,
    turns: [
      {
        prompt: row.prompt,
        rCode: row.r_code,
        output: {
          stdout: out.stdout,
          stderr: out.stderr,
          success: true,
          interpretation: row.interpretation,
          economicValidation: row.economic_validation ?? "",
          chartData,
        },
      },
    ],
  };
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [followUpMessage, setFollowUpMessage] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState("");
  const [runStatusMessage, setRunStatusMessage] = useState("");
  const [lessonsCount, setLessonsCount] = useState(0);
  const [autoFixesCount, setAutoFixesCount] = useState(0);
  const [activeTab, setActiveTab] = useState<"results" | "data" | "code">("results");
  const [examplePromptsCollapsed, setExamplePromptsCollapsed] = useState(true);
  const [progressMessage, setProgressMessage] = useState("");
  const [streamingInterpretation, setStreamingInterpretation] = useState("");

  const activeConversation = currentConversationId
    ? conversations.find((c) => c.id === currentConversationId) ?? null
    : null;
  const lastTurn = activeConversation?.turns?.length
    ? activeConversation.turns[activeConversation.turns.length - 1]
    : null;

  useEffect(() => {
    fetchHistory();
  }, []);

  useEffect(() => {
    fetch("/api/lessons")
      .then((r) => (r.ok ? r.json() : { count: 0, autoFixes: 0 }))
      .then((d: { count?: number; autoFixes?: number }) => {
        setLessonsCount(d.count ?? 0);
        setAutoFixesCount(d.autoFixes ?? 0);
      })
      .catch(() => {});
  }, []);

  async function fetchHistory(replaceAll = false): Promise<Conversation[]> {
    try {
      const res = await fetch("/api/history");
      if (!res.ok) return [];
      const rows = (await res.json()) as HistoryRow[];
      const fromApi = rows.map(historyRowToConversation);
      setConversations((prev) => {
        // Only replace all when DB actually returned records; if DB is unavailable
      // (empty array) keep local conversations so results don't disappear.
      if (replaceAll && fromApi.length > 0) return fromApi;
        const local = prev.filter((c) => c.id.startsWith("local-"));
        const apiIds = new Set(fromApi.map((c) => c.id));
        const localOnly = local.filter((c) => !apiIds.has(c.id));
        return [...localOnly, ...fromApi];
      });
      return fromApi;
    } catch {
      return [];
    }
  }

  function newChat() {
    setCurrentConversationId(null);
    setMessage("");
    setFollowUpMessage("");
    setError("");
    setStep("idle");
  }

  function loadConversation(conv: Conversation) {
    setCurrentConversationId(conv.id);
    setMessage("");
    setFollowUpMessage("");
    setError("");
    setActiveTab("results");
  }

  async function runAnalysis(promptText: string) {
    const text = promptText.trim();
    if (!text) return;
    setError("");
    setStreamingInterpretation("");
    setStep("analyzing");
    setProgressMessage("Identifying variables...");
    try {
      const identifyRes = await fetch("/api/analyze/identify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const identifyData = await identifyRes.json();
      if (!identifyRes.ok) {
        setError(identifyData.error ?? "Could not identify data sources");
        setStep("error");
        return;
      }
      const variables = identifyData.variables ?? [];
      if (variables.length === 0) {
        setError("No data sources identified for this request.");
        setStep("error");
        return;
      }

      setStep("verifying");
      setProgressMessage("Verifying data sources...");
      const verifyResults = await Promise.all(
        variables.map(async (v: { source: string; term: string }) => {
          try {
            const verifyRes = await fetch("/api/verify-data", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source: v.source, term: v.term }),
            });
            const verifyData = await verifyRes.json();
            return {
              source: verifyData.source ?? v.source,
              verified: verifyData.verified === true,
              id: verifyData.id ?? v.term,
              name: verifyData.name,
              suggestion: verifyData.suggestion,
            };
          } catch {
            return { source: v.source, verified: false, id: v.term } as const;
          }
        })
      );
      const verifiedVariables = verifyResults;

      setStep("analyzing");
      setProgressMessage("Generating code...");
      const codeRes = await fetch("/api/analyze/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, verifiedVariables }),
      });
      const codeData = await codeRes.json();
      if (!codeRes.ok) {
        setError(codeData.error ?? "Code generation failed");
        setStep("error");
        return;
      }
      let currentCode = codeData.rCode ?? "";
      setStep("running");
      setProgressMessage("Running regression...");
      setRunStatusMessage("Running…");
      let currentAttempt = 1;
      let corrections: { error: string }[] = [];
      let runData: {
        success?: boolean;
        needsRetry?: boolean;
        fixedCode?: string;
        attempt?: number;
        corrections?: { error: string }[];
        message?: string;
        error?: string;
        stdout?: string;
        stderr?: string;
        interpretation?: string;
        economicValidation?: string;
        chartData?: ChartData | null;
        userMessage?: string;
        corrected?: boolean;
      } = {};
      while (true) {
        const runRes = await fetch("/api/run-regression", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: currentCode,
            prompt: text,
            attempt: currentAttempt,
            previousCorrections: corrections,
          }),
        });
        runData = await runRes.json();
        if (!runRes.ok) {
          setError(runData.error ?? "Run failed");
          setStep("error");
          return;
        }
        if (runData.needsRetry && runData.fixedCode && currentAttempt < 2) {
          setRunStatusMessage(runData.message ?? `Fixing code, attempt ${currentAttempt + 1} of 2...`);
          currentCode = runData.fixedCode;
          corrections = runData.corrections ?? [];
          currentAttempt += 1;
          continue;
        }
        break;
      }
      setRunStatusMessage("");
      const newTurn: Turn = {
        prompt: text,
        rCode: currentCode,
        output: {
          stdout: runData.stdout ?? "",
          stderr: runData.stderr ?? "",
          success: runData.success ?? false,
          interpretation: runData.interpretation ?? "",
          economicValidation: runData.economicValidation ?? "",
          chartData: (runData.chartData as ChartData) ?? null,
        },
      };
      if (!runData.success && runData.userMessage) {
        setError(runData.userMessage);
        setStep("error");
        return;
      }
      const isFollowUp = currentConversationId != null && activeConversation != null;
      if (isFollowUp) {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === currentConversationId
              ? { ...c, turns: [...c.turns, newTurn] }
              : c
          )
        );
      } else {
        const newId = `local-${Date.now()}`;
        setConversations((prev) => [
          { id: newId, title: text.length > 48 ? text.slice(0, 48) + "…" : text, date: new Date().toISOString(), turns: [newTurn] },
          ...prev,
        ]);
        setCurrentConversationId(newId);
      }
      setStep("done");
      setActiveTab("results");
      setProgressMessage("Interpreting results...");

      // Build interpretation input: extract only the regression summary.
      // The R API may echo the R script before the output, so find "Call:"
      // (from print(summary(model))) and send only from there onwards.
      // Also strip the CHART_DATA JSON block which is not needed by the AI.
      const rawOutput = runData.stdout ?? "";
      const chartDataMarker = rawOutput.indexOf("\n---CHART_DATA_BEGIN---");
      const chartDataEnd = rawOutput.indexOf("---CHART_DATA_END---");
      const withoutChartData = chartDataMarker >= 0 && chartDataEnd > chartDataMarker
        ? rawOutput.slice(0, chartDataMarker) + rawOutput.slice(chartDataEnd + "---CHART_DATA_END---".length)
        : rawOutput.indexOf("\nCHART_DATA:") >= 0
          ? rawOutput.slice(0, rawOutput.indexOf("\nCHART_DATA:"))
          : rawOutput;
      const callIdx = withoutChartData.indexOf("\nCall:");
      const cleanOutput = (callIdx >= 0 ? withoutChartData.slice(callIdx) : withoutChartData).trim();

      // Fire-and-forget: run interpretation + economic validation + save + history refresh
      (async () => {
        try {
          let fullInterpretation = "";
          let economicValidation = "";

          await Promise.all([
            // Interpretation stream
            (async () => {
              try {
                const res = await fetch("/api/interpret-stream", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ output: cleanOutput }),
                });
                if (!res.ok || !res.body) return;
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    fullInterpretation += chunk;
                    setStreamingInterpretation(fullInterpretation);
                  }
                } finally {
                  reader.releaseLock();
                }
              } catch (e) {
                console.error("Interpretation error:", e);
              }
            })(),
            // Economic validation
            (async () => {
              try {
                const r = await fetch("/api/economic-validation", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ output: cleanOutput, prompt: text }),
                });
                const data = (await r.json()) as { economicValidation?: string };
                economicValidation = data.economicValidation ?? "";
              } catch (e) {
                console.error("Economic validation error:", e);
              }
            })(),
          ]);

          setStreamingInterpretation("");
          setConversations((prev) =>
            prev.map((c) => {
              const lastIdx = c.turns.length - 1;
              if (lastIdx < 0) return c;
              const last = c.turns[lastIdx];
              if (last.prompt !== text) return c;
              return {
                ...c,
                turns: c.turns.map((t, i) =>
                  i === lastIdx
                    ? { ...t, output: { ...t.output, interpretation: fullInterpretation, economicValidation } }
                    : t
                ),
              };
            })
          );

          await fetch("/api/save-regression", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: text,
              r_code: currentCode,
              output: JSON.stringify({ stdout: runData.stdout, stderr: runData.stderr }),
              interpretation: fullInterpretation,
              economic_validation: economicValidation || null,
              chart_data: runData.chartData ? JSON.stringify(runData.chartData) : null,
            }),
          });
        } catch (e) {
          console.error("Post-run error:", e);
        } finally {
          setProgressMessage("");
        }
        if (!isFollowUp) {
          const list = await fetchHistory(true);
          if (list[0]?.id) setCurrentConversationId(list[0].id);
        } else {
          fetchHistory();
        }
      })();
      if (runData.corrected) {
        fetch("/api/lessons")
          .then((r) => (r.ok ? r.json() : { count: 0, autoFixes: 0 }))
          .then((d: { count?: number; autoFixes?: number }) => {
            setLessonsCount(d.count ?? 0);
            setAutoFixesCount(d.autoFixes ?? 0);
          })
          .catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setStep("error");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runAnalysis(message);
  }

  function handleFollowUp(e: React.FormEvent) {
    e.preventDefault();
    const follow = followUpMessage.trim();
    if (!follow || !activeConversation?.turns?.length) return;
    const context = `Previous regression: "${activeConversation.turns[0].prompt}". User now asks: ${follow}`;
    runAnalysis(context);
    setFollowUpMessage("");
  }

  const busy = step === "analyzing" || step === "verifying" || step === "running";
  const hasResults = activeConversation != null && activeConversation.turns.length > 0;

  return (
    <div className="min-h-screen flex" style={{ background: "#0a0a0f" }}>
      {/* SIDEBAR - fixed left, dark */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-950/95 fixed left-0 top-0 bottom-0 z-10">
        <div className="p-4 border-b border-zinc-800">
          <h1 className="text-lg font-semibold text-white tracking-tight">EconAI</h1>
          <p className="text-xs text-zinc-500 mt-1">
            <span className="text-emerald-400/90">{lessonsCount}</span> lessons · <span className="text-amber-400/90">⚡ {autoFixesCount}</span> auto-fixes
          </p>
        </div>
        <button
          type="button"
          onClick={newChat}
          className="mx-4 mt-4 flex items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors"
        >
          <span className="text-base leading-none">+</span>
          New Chat
        </button>
        <div className="flex-1 overflow-y-auto mt-4 px-2 min-h-0">
          {conversations.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-500">No past chats yet.</p>
          )}
          {conversations.map((conv) => (
            <button
              key={conv.id}
              type="button"
              onClick={() => loadConversation(conv)}
              className={`w-full text-left px-3 py-2.5 rounded-lg mb-1 transition-colors ${
                currentConversationId === conv.id
                  ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/40"
                  : "text-zinc-300 hover:bg-zinc-800/80 hover:text-white border border-transparent"
              }`}
            >
              <span className="block text-sm line-clamp-2">{conv.title}</span>
              <span className="block text-xs text-zinc-500 mt-1">
                {new Date(conv.date).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-zinc-800 p-2">
          <button
            type="button"
            onClick={() => setExamplePromptsCollapsed((c) => !c)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-400"
          >
            Example prompts
            <span className="text-zinc-600">{examplePromptsCollapsed ? "▼" : "▲"}</span>
          </button>
          {!examplePromptsCollapsed && (
            <ul className="space-y-1 px-1 pb-2">
              {EXAMPLE_PROMPTS.map((prompt, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => runAnalysis(prompt)}
                    disabled={busy}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-200 disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* MAIN AREA - right side */}
      <main className="flex-1 flex flex-col min-w-0 ml-64">
        {/* Top: primary prompt + Run */}
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Ask any econometrics question..."
              className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-3 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !message.trim()}
              className="rounded-xl bg-emerald-600 px-6 py-3 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {step === "analyzing" ? "Analyzing…" : step === "verifying" ? "Verifying…" : step === "running" ? (runStatusMessage || "Running…") : "Run Analysis"}
            </button>
          </form>
          {error && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-950/20 px-4 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
          {(step === "verifying" || step === "running" || progressMessage) && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-2 text-sm text-amber-200">
              {progressMessage || (step === "verifying" ? "Verifying data sources…" : runStatusMessage || "Running…")}
            </div>
          )}
        </div>

        {/* Tabs + content */}
        {hasResults && (
          <>
            <div className="shrink-0 border-b border-zinc-800 px-6 flex gap-1 bg-zinc-900/20">
              {(["results", "data", "code"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-3 text-sm font-medium capitalize border-b-2 transition-colors ${
                    activeTab === tab
                      ? "border-emerald-500 text-emerald-400"
                      : "border-transparent text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab === "results" ? "Results" : tab === "data" ? "Data" : "Code"}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {activeTab === "results" && (
                <div className="space-y-6">
                  {activeConversation?.turns.map((turn, idx) => (
                    <TurnResults
                      key={idx}
                      turn={turn}
                      isLastTurn={idx === (activeConversation.turns.length ?? 1) - 1}
                      streamingInterpretation={streamingInterpretation}
                    />
                  ))}
                </div>
              )}
              {activeTab === "data" && lastTurn && (
                <DataTab turn={lastTurn} />
              )}
              {activeTab === "code" && lastTurn && (
                <CodeTab turn={lastTurn} />
              )}
            </div>
          </>
        )}

        {!hasResults && step === "idle" && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
            Run an analysis to see results, data, and code.
          </div>
        )}

        {/* Follow-up input at bottom */}
        {hasResults && (
          <div className="shrink-0 border-t border-zinc-800 px-6 py-4 bg-zinc-900/30">
            <form onSubmit={handleFollowUp} className="flex gap-3">
              <input
                type="text"
                value={followUpMessage}
                onChange={(e) => setFollowUpMessage(e.target.value)}
                placeholder="Ask a follow-up or request additional tests..."
                className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy || !followUpMessage.trim()}
                className="rounded-xl border border-zinc-600 bg-zinc-800 px-4 py-2.5 text-sm text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
              >
                Send
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}

function TurnResults({
  turn,
  isLastTurn,
  streamingInterpretation,
}: {
  turn: Turn;
  isLastTurn: boolean;
  streamingInterpretation: string;
}) {
  const { output } = turn;
  const displayInterpretation = isLastTurn && streamingInterpretation ? streamingInterpretation : output.interpretation;
  const parsed = output.stdout ? parseRegressionOutput(output.stdout) : null;
  // Extract the lm() formula from the R code for model type display
  const lmMatch = turn.rCode.match(/model\s*<-\s*lm\s*\(([^,)]+(?:\s*\+\s*[^,)]+)*)\s*,\s*data/);
  const modelFormula = lmMatch ? lmMatch[1].trim() : null;
  const hasCoefficients = parsed && parsed.coefficients.length > 0;
  const cd = output.chartData;
  const scatter = (cd?.scatter ?? []).filter((p) => typeof p.x === "number" && typeof p.y === "number");
  const timeseries = cd?.timeseries ?? [];
  const coefs = cd?.coefficients ?? {};
  const coefKeys = Object.keys(coefs).filter((k) => k !== "Intercept");
  const oneIV = coefKeys.length === 1 && scatter.length > 0;
  const intercept = Number(coefs["Intercept"]) || 0;
  const slope = coefKeys.length ? Number(coefs[coefKeys[0]]) || 0 : 0;
  const regressionLineData =
    oneIV && scatter.length
      ? (() => {
          const xs = scatter.map((p) => p.x);
          return [
            { x: Math.min(...xs), y: intercept + slope * Math.min(...xs) },
            { x: Math.max(...xs), y: intercept + slope * Math.max(...xs) },
          ];
        })()
      : [];
  const chartProps = { margin: { top: 12, right: 12, left: 12, bottom: 12 }, stroke: "#71717a", tick: { fill: "#fafafa", fontSize: 11 } };

  return (
    <div className="space-y-6">
      {(displayInterpretation || output.economicValidation) && (
        <section className="rounded-xl border border-zinc-700 border-l-4 border-l-emerald-500 bg-zinc-900/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-700">
            <h2 className="text-sm font-semibold text-white">AI Interpretation</h2>
          </div>
          <div className="p-5 space-y-4">
            {displayInterpretation && (
              <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">
                {displayInterpretation}
                {isLastTurn && streamingInterpretation ? <span className="animate-pulse">▌</span> : null}
              </p>
            )}
            {output.economicValidation && (
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap border-t border-zinc-700 pt-4">
                <span className="font-medium text-zinc-400">Economic validation:</span> {output.economicValidation}
              </p>
            )}
          </div>
        </section>
      )}
      {!hasCoefficients && output.stdout && (
        <section className="rounded-xl border border-zinc-700 bg-zinc-900/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-700">
            <h2 className="text-sm font-semibold text-amber-400">R Output</h2>
            <p className="text-xs text-zinc-500 mt-0.5">No coefficient table found — showing raw R output for debugging</p>
          </div>
          <div className="p-5">
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono overflow-x-auto max-h-64 overflow-y-auto">{output.stdout}</pre>
          </div>
        </section>
      )}
      {hasCoefficients && (
        <section className="rounded-xl border border-zinc-700 bg-zinc-900/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-700 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Coefficients</h2>
            {modelFormula && (
              <span className="text-xs text-zinc-400">
                OLS · <code className="text-zinc-300 font-mono">{modelFormula}</code>
              </span>
            )}
          </div>
          <div className="p-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 border-b border-zinc-700">
                  <th className="text-left py-2 pr-4 font-medium">Term</th>
                  <th className="text-right py-2 px-2 font-medium">Estimate</th>
                  <th className="text-right py-2 px-2 font-medium">Std. Error</th>
                  <th className="text-right py-2 px-2 font-medium">t value</th>
                  <th className="text-right py-2 pl-2 font-medium">Pr(&gt;|t|)</th>
                </tr>
              </thead>
              <tbody>
                {parsed!.coefficients.map((row, i) => (
                  <tr key={i} className="border-b border-zinc-800">
                    <td className="py-2.5 pr-4 text-zinc-200">{row.term}</td>
                    <td className={`text-right py-2.5 px-2 tabular-nums ${row.estimate >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {row.estimate.toExponential(4)}
                    </td>
                    <td className="text-right py-2.5 px-2 text-zinc-400 tabular-nums">{row.stdError.toExponential(4)}</td>
                    <td className="text-right py-2.5 px-2 text-zinc-400 tabular-nums">{row.tValue.toFixed(4)}</td>
                    <td className={`text-right py-2.5 pl-2 tabular-nums ${row.pValue <= 0.05 ? "text-emerald-400" : "text-zinc-400"}`}>
                      {row.pValue < 0.0001 ? "< 0.0001" : row.pValue.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(parsed?.rSquared != null || parsed?.adjRSquared != null) && (
              <div className="flex gap-6 text-sm mt-4">
                {parsed.rSquared != null && (
                  <span className="text-zinc-400">R² = <span className="text-white font-medium">{parsed.rSquared.toFixed(4)}</span></span>
                )}
                {parsed.adjRSquared != null && (
                  <span className="text-zinc-400">Adj. R² = <span className="text-white font-medium">{parsed.adjRSquared.toFixed(4)}</span></span>
                )}
              </div>
            )}
          </div>
        </section>
      )}
      {cd && (scatter.length > 0 || timeseries.length > 0 || Object.keys(coefs).length > 0) && (
        <section className="rounded-xl border border-zinc-700 bg-zinc-900/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-700">
            <h2 className="text-sm font-semibold text-white">Charts</h2>
          </div>
          <div className="p-5 space-y-6">
            {oneIV && scatter.length > 0 && (
              <div>
                <p className="text-xs text-zinc-500 mb-2">Scatter with regression line</p>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart margin={chartProps.margin}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="x" type="number" tick={chartProps.tick} stroke={chartProps.stroke} />
                    <YAxis type="number" tick={chartProps.tick} stroke={chartProps.stroke} />
                    <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8 }} labelStyle={{ color: "#fafafa" }} />
                    <Scatter data={scatter} dataKey="y" fill="#22c55e" fillOpacity={0.8} name="Data" />
                    <Line type="monotone" data={regressionLineData} dataKey="y" stroke="#ef4444" strokeWidth={2} dot={false} name="Regression" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
            {timeseries.length > 0 && (
              <div>
                <p className="text-xs text-zinc-500 mb-2">Time series</p>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={timeseries} margin={chartProps.margin}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="date" tick={chartProps.tick} stroke={chartProps.stroke} />
                    <YAxis tick={chartProps.tick} stroke={chartProps.stroke} />
                    <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8 }} labelStyle={{ color: "#fafafa" }} />
                    <Legend wrapperStyle={{ color: "#fafafa" }} />
                    <Line type="monotone" dataKey="y" stroke="#22c55e" name="Y" dot={false} />
                    {oneIV && typeof timeseries[0]?.x === "number" && <Line type="monotone" dataKey="x" stroke="#3b82f6" name="X" dot={false} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {!oneIV && Object.keys(coefs).length > 0 && (
              <div>
                <p className="text-xs text-zinc-500 mb-2">Coefficients</p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={Object.entries(coefs).map(([name, value]) => ({ name, value: Number(value) }))} margin={chartProps.margin}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="name" tick={chartProps.tick} stroke={chartProps.stroke} />
                    <YAxis tick={chartProps.tick} stroke={chartProps.stroke} />
                    <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 8 }} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]} label={{ fill: "#fafafa", fontSize: 11 }}>
                      {Object.entries(coefs).map(([, value], i) => (
                        <Cell key={i} fill={Number(value) >= 0 ? "#22c55e" : "#ef4444"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function DataTab({ turn }: { turn: Turn }) {
  const ts = turn.output.chartData?.timeseries ?? [];
  const dates = ts.map((r) => r.date);
  const minDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : "";
  const maxDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : "";
  const yLabel = "Y (dependent)";
  const xLabel = "X (independent)";

  return (
    <section className="rounded-xl border border-zinc-700 bg-zinc-900/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-700">
        <h2 className="text-sm font-semibold text-white">Regression data</h2>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 text-sm">
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wider">Observations</p>
            <p className="text-white font-medium">{ts.length}</p>
          </div>
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wider">Date range</p>
            <p className="text-white font-medium">{minDate && maxDate ? `${minDate} — ${maxDate}` : "—"}</p>
          </div>
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wider">Frequency</p>
            <p className="text-white font-medium">Daily</p>
          </div>
          <div>
            <p className="text-zinc-500 text-xs uppercase tracking-wider">Data source</p>
            <p className="text-white font-medium">Yahoo Finance</p>
          </div>
        </div>
        {ts.length === 0 && (
          <p className="text-sm text-zinc-500 mb-4">
            No timeseries data available. The R script may have encountered an error building the chart data block — check the Code tab for details.
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-700">
                <th className="text-left py-2 pr-4 font-medium">Date</th>
                <th className="text-right py-2 px-2 font-medium">{yLabel} (return)</th>
                <th className="text-right py-2 pl-2 font-medium">{xLabel} (return)</th>
              </tr>
            </thead>
            <tbody>
              {ts.map((row, i) => (
                <tr key={i} className="border-b border-zinc-800">
                  <td className="py-2 pr-4 text-zinc-200">{row.date}</td>
                  <td className="text-right py-2 px-2 tabular-nums text-zinc-300">{typeof row.y === "number" ? row.y.toExponential(4) : row.y}</td>
                  <td className="text-right py-2 pl-2 tabular-nums text-zinc-300">{typeof row.x === "number" ? row.x.toExponential(4) : (row.x ?? "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function CodeTab({ turn }: { turn: Turn }) {
  const copyCode = () => {
    navigator.clipboard.writeText(turn.rCode);
  };

  const comments = [
    { label: "Locale & encoding", text: "Set UTF-8 and English locale for consistent output on Windows." },
    { label: "Packages", text: "Load quantmod (Yahoo/FRED) and jsonlite for CHART_DATA output." },
    { label: "Fetch data", text: "getSymbols with auto.assign=FALSE; assign to named variables." },
    { label: "Prices & returns", text: "Extract close with Cl(), compute log returns, na.omit." },
    { label: "Merge & filter", text: "Align series by date and subset to requested range." },
    { label: "Data frame & regression", text: "Convert to data.frame, set colnames to match lm() formula, run lm()." },
    { label: "Output", text: "Print summary and emit CHART_DATA JSON for the UI." },
  ];

  return (
    <section className="rounded-xl border border-zinc-700 bg-zinc-900/50 overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">R code</h2>
        <button
          type="button"
          onClick={copyCode}
          className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-600 transition-colors"
        >
          Copy Code
        </button>
      </div>
      <div className="p-5">
        <div className="mb-4 space-y-2 text-xs text-zinc-400">
          {comments.map((c, i) => (
            <p key={i}>
              <span className="text-emerald-400/90 font-medium">// {c.label}:</span> {c.text}
            </p>
          ))}
        </div>
        <div className="overflow-x-auto rounded-lg bg-zinc-950 border border-zinc-700 p-4">
          <pre
            className="text-xs font-mono whitespace-pre"
            dangerouslySetInnerHTML={{ __html: highlightRCode(turn.rCode) }}
          />
        </div>
      </div>
    </section>
  );
}
