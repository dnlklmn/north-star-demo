import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, getApiKey } from "../api";
import type { ProdLogRecord, ScorerResult, FeatureTrace } from "../types";
import AgentTraceView from "./AgentTraceView";

/**
 * Observer panel — the start of the deploy → monitor → improve → redeploy
 * flywheel. Shows recent prod invocations of a deployed skill, their full
 * trace, and the async scorer results landing one-by-one. Outliers and a
 * pass-rate sparkline give the operator the "is it still working?" answer
 * at a glance.
 *
 * Cross-cutting principle: every long-running step is legible. Scoring is
 * intentionally async — the row shows "scoring…" then fills in. Polling
 * runs while the panel is open; we stop on unmount to keep idle traffic low.
 */

interface PassRateBucket {
  start: string | null;
  end: string | null;
  pass_rate: number | null;
  scored: number;
  total: number;
}

interface PassRateResponse {
  skill_id: string;
  threshold: number;
  total: number;
  scored: number;
  buckets: PassRateBucket[];
}

interface Props {
  skillId: string;
  /** Polling interval for new records in ms. Defaults to 3s. */
  pollIntervalMs?: number;
  /** Pass-rate threshold for the sparkline + outlier ranking. Defaults to 0.75. */
  passThreshold?: number;
}

export default function ObserverPanel({
  skillId,
  pollIntervalMs = 3000,
  passThreshold = 0.75,
}: Props) {
  const [records, setRecords] = useState<ProdLogRecord[]>([]);
  const [outliers, setOutliers] = useState<ProdLogRecord[]>([]);
  const [passRate, setPassRate] = useState<PassRateResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  // -- Fetching ------------------------------------------------------------
  // We refetch the full window every tick rather than diffing because (a) the
  // in-memory store is small, (b) scorer results land on *existing* records
  // so a "since" query would miss those updates, and (c) it keeps the
  // contract simple: server state wins.
  const refresh = useCallback(async () => {
    if (!skillId) return;
    try {
      const apiKey = getApiKey();
      const init: RequestInit = apiKey
        ? { headers: { "X-Anthropic-Key": apiKey } }
        : {};
      const [listRes, outRes, prRes] = await Promise.all([
        fetch(`${API_BASE}/prod-log/${encodeURIComponent(skillId)}?limit=100`, init),
        fetch(`${API_BASE}/prod-log/${encodeURIComponent(skillId)}/outliers?limit=5`, init),
        fetch(
          `${API_BASE}/prod-log/${encodeURIComponent(
            skillId,
          )}/pass-rate?buckets=20&threshold=${passThreshold}`,
          init,
        ),
      ]);
      if (!listRes.ok) throw new Error(`list ${listRes.status}`);
      if (!outRes.ok) throw new Error(`outliers ${outRes.status}`);
      if (!prRes.ok) throw new Error(`pass-rate ${prRes.status}`);
      const list = (await listRes.json()) as ProdLogRecord[];
      const out = (await outRes.json()) as ProdLogRecord[];
      const pr = (await prRes.json()) as PassRateResponse;
      setRecords(list);
      setOutliers(out);
      setPassRate(pr);
      setLoadError(null);
      setInitialLoaded(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [skillId, passThreshold]);

  useEffect(() => {
    let cancelled = false;
    void refresh();
    const id = window.setInterval(() => {
      if (cancelled) return;
      void refresh();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refresh, pollIntervalMs]);

  const selected = useMemo(
    () => records.find((r) => r.id === selectedId) ?? null,
    [records, selectedId],
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Observer</h2>
          <p className="text-xs text-muted-foreground">
            Live production calls for skill{" "}
            <code className="font-mono">{skillId}</code>. Scorers run
            async — scores arrive a beat after the call.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-xs text-muted-foreground hover:text-foreground border border-border-hint px-2 py-1"
        >
          Refresh
        </button>
      </header>

      {loadError && (
        <div className="text-xs text-danger border border-danger/30 bg-danger/5 px-2 py-1">
          Failed to load: {loadError}
        </div>
      )}

      <PassRateCard data={passRate} threshold={passThreshold} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent calls
          </h3>
          {!initialLoaded ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : records.length === 0 ? (
            <div className="text-xs text-muted-foreground border border-border-hint p-3">
              No production calls logged yet. Once the skill is deployed,
              every invocation will appear here.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {records.map((r) => (
                <RecordRow
                  key={r.id}
                  record={r}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Outliers ({outliers.length})
          </h3>
          {outliers.length === 0 ? (
            <div className="text-xs text-muted-foreground border border-border-hint p-3">
              Nothing low-scoring yet. Outliers appear here once at least one
              record has a complete mean score below the rest.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {outliers.map((r) => (
                <RecordRow
                  key={r.id}
                  record={r}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                  compact
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {selected && (
        <RecordDetail
          record={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pass-rate sparkline — bare SVG so we don't depend on a chart library. Each
// bucket renders as a vertical bar whose height encodes the pass rate; the
// dotted line marks the threshold. Unscored buckets render as muted ghosts so
// the user can see "we haven't gotten scores back yet for this slice".
// ---------------------------------------------------------------------------

function PassRateCard({
  data,
  threshold,
}: {
  data: PassRateResponse | null;
  threshold: number;
}) {
  if (!data) {
    return (
      <div className="border border-border-hint p-3 text-xs text-muted-foreground">
        Pass-rate sparkline loading…
      </div>
    );
  }
  const hasData = data.buckets.length > 0 && data.scored > 0;
  return (
    <div className="border border-border-hint p-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Pass rate over time
        </h3>
        <span className="text-xs text-muted-foreground">
          {data.scored}/{data.total} scored · threshold {Math.round(threshold * 100)}%
        </span>
      </div>
      {hasData ? (
        <PassRateSparkline buckets={data.buckets} threshold={threshold} />
      ) : (
        <div className="text-xs text-muted-foreground">
          {data.total === 0
            ? "No records yet."
            : "Waiting for scorers to finish on the first records…"}
        </div>
      )}
    </div>
  );
}

function PassRateSparkline({
  buckets,
  threshold,
}: {
  buckets: PassRateBucket[];
  threshold: number;
}) {
  const w = 600;
  const h = 60;
  const padX = 4;
  const padY = 4;
  const innerW = w - padX * 2;
  const innerH = h - padY * 2;
  const bw = innerW / Math.max(buckets.length, 1);
  const yFor = (rate: number) => padY + innerH - rate * innerH;
  const thresholdY = yFor(threshold);
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-12 text-foreground"
      preserveAspectRatio="none"
    >
      <line
        x1={0}
        x2={w}
        y1={thresholdY}
        y2={thresholdY}
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeDasharray="3,3"
      />
      {buckets.map((b, i) => {
        const x = padX + i * bw;
        if (b.pass_rate === null) {
          return (
            <rect
              key={i}
              x={x + 1}
              y={padY + innerH - 4}
              width={Math.max(bw - 2, 1)}
              height={4}
              fill="currentColor"
              fillOpacity={0.1}
            />
          );
        }
        const top = yFor(b.pass_rate);
        const height = Math.max(padY + innerH - top, 1);
        const passing = b.pass_rate >= threshold;
        return (
          <rect
            key={i}
            x={x + 1}
            y={top}
            width={Math.max(bw - 2, 1)}
            height={height}
            fill="currentColor"
            fillOpacity={passing ? 0.7 : 0.4}
          >
            <title>
              {`${formatInterval(b.start, b.end)}: ${Math.round(
                b.pass_rate * 100,
              )}% (${b.scored}/${b.total} scored)`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

function formatInterval(start: string | null, end: string | null): string {
  if (!start || !end) return "?";
  try {
    const s = new Date(start);
    const e = new Date(end);
    return `${s.toLocaleTimeString()} – ${e.toLocaleTimeString()}`;
  } catch {
    return `${start} – ${end}`;
  }
}

// ---------------------------------------------------------------------------
// Per-record row + detail. The row shows a tight summary; clicking opens the
// detail panel with input/output/trace and the live scorer list.
// ---------------------------------------------------------------------------

function RecordRow({
  record,
  selected,
  onSelect,
  compact = false,
}: {
  record: ProdLogRecord;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  const mean = meanScore(record.scores);
  const pending = record.scores.some((s) => s.score === null && !s.error);
  const inputPreview = formatInput(record.input, compact ? 60 : 120);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full text-left text-xs border px-2 py-1.5 flex items-center gap-2 ${
          selected
            ? "border-foreground bg-surface-raised"
            : "border-border-hint hover:bg-surface-raised"
        }`}
      >
        <MeanScoreBadge mean={mean} pending={pending} />
        <span className="flex-1 truncate font-mono text-foreground">
          {inputPreview}
        </span>
        {record.error && <span className="text-danger">err</span>}
        <span className="text-muted-foreground tabular-nums">
          {formatLatency(record.latency_ms)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {formatRelativeTime(record.created_at)}
        </span>
      </button>
    </li>
  );
}

function MeanScoreBadge({
  mean,
  pending,
}: {
  mean: number | null;
  pending: boolean;
}) {
  if (mean === null) {
    return (
      <span className="inline-flex items-center justify-center w-12 text-[10px] text-muted-foreground border border-border-hint px-1 py-0.5">
        {pending ? "scoring…" : "n/a"}
      </span>
    );
  }
  const pct = Math.round(mean * 100);
  const tone =
    mean >= 0.75
      ? "border-success/40 text-success"
      : mean >= 0.5
      ? "border-warning/40 text-warning"
      : "border-danger/40 text-danger";
  return (
    <span
      className={`inline-flex items-center justify-center w-12 text-[10px] tabular-nums border px-1 py-0.5 ${tone}`}
    >
      {pct}%{pending ? "…" : ""}
    </span>
  );
}

function RecordDetail({
  record,
  onClose,
}: {
  record: ProdLogRecord;
  onClose: () => void;
}) {
  return (
    <div className="border border-border-hint p-3 flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Call {record.id.slice(0, 8)}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </div>

      <ScorerList scores={record.scores} />

      <FieldBlock label="Input">
        <pre className="whitespace-pre-wrap break-words text-foreground text-xs">
          {formatInput(record.input, 4000)}
        </pre>
      </FieldBlock>

      <FieldBlock label="Output">
        <pre className="whitespace-pre-wrap break-words text-foreground text-xs">
          {record.output}
        </pre>
      </FieldBlock>

      {record.error && (
        <FieldBlock label="Error">
          <pre className="whitespace-pre-wrap break-words text-danger text-xs">
            {record.error}
          </pre>
        </FieldBlock>
      )}

      <AgentTraceView trace={record.trace as FeatureTrace} />
    </div>
  );
}

function ScorerList({ scores }: { scores: ScorerResult[] }) {
  if (scores.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No scorers configured for this skill.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {scores.map((s) => (
        <ScorerChip key={s.scorer} result={s} />
      ))}
    </div>
  );
}

function ScorerChip({ result }: { result: ScorerResult }) {
  if (result.error) {
    return (
      <span
        className="text-[10px] border border-danger/40 text-danger px-1.5 py-0.5"
        title={result.error}
      >
        {result.scorer}: err
      </span>
    );
  }
  if (result.score === null) {
    return (
      <span className="text-[10px] border border-border-hint text-muted-foreground px-1.5 py-0.5 animate-pulse">
        {result.scorer}: scoring…
      </span>
    );
  }
  const pct = Math.round(result.score * 100);
  const tone =
    result.score >= 0.75
      ? "border-success/40 text-success"
      : result.score >= 0.5
      ? "border-warning/40 text-warning"
      : "border-danger/40 text-danger";
  return (
    <span className={`text-[10px] border ${tone} px-1.5 py-0.5 tabular-nums`}>
      {result.scorer}: {pct}%
    </span>
  );
}

function FieldBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function meanScore(scores: ScorerResult[]): number | null {
  const completed = scores
    .map((s) => s.score)
    .filter((s): s is number => typeof s === "number");
  if (completed.length === 0) return null;
  return completed.reduce((a, b) => a + b, 0) / completed.length;
}

function formatInput(input: unknown, max: number): string {
  if (typeof input === "string") {
    return input.length > max ? input.slice(0, max) + "…" : input;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(input);
  }
}

function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
