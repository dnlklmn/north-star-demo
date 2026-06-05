import type { FeatureTrace } from "../types";

/**
 * Standalone renderer for an agent trace — extracted from EvaluatePanel's
 * inline trace block (~line 2671) so the Observer panel can show the same
 * tool-calls + artifacts + iterations view as the Evaluate tab without
 * pulling the rest of that monolith into the import graph.
 *
 * Takes a `FeatureTrace` (the unified shape mirrored from backend
 * `contracts.Trace`). The legacy `AgentRowMetadata` shape is structurally
 * compatible — FeatureTrace just adds optional fields the original
 * renderer ignored — so callers with old-shaped traces can cast safely.
 *
 * Render contract (kept identical to EvaluatePanel so reviewers see one
 * trace UI across the app):
 *   - <details> collapsible header with a one-line summary
 *   - ordered list of tool calls, with input JSON + result text
 *   - artifacts list with size + preview
 */
export default function AgentTraceView({ trace }: { trace: FeatureTrace | undefined | null }) {
  if (!trace) return null;
  const calls = trace.tool_calls || [];
  const artifacts = trace.artifacts || [];
  const iterations = trace.iterations ?? 0;
  // Render nothing when there's literally nothing to show — matches the
  // EvaluatePanel behavior: a bare `iterations: 0` with no calls/artifacts
  // adds no signal and just clutters the UI.
  if (calls.length === 0 && artifacts.length === 0 && iterations === 0 && !trace.final_text) {
    return null;
  }
  const errored = calls.filter((c) => c.is_error).length;

  return (
    <details className="border border-border-hint p-2 bg-background">
      <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
        Agent trace · {calls.length} tool call{calls.length === 1 ? "" : "s"}
        {errored > 0 && <span className="text-danger"> · {errored} errored</span>}
        {artifacts.length > 0 && (
          <span>
            {" "}
            · {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
          </span>
        )}
        {iterations > 0 && <span> · {iterations} iter</span>}
        {trace.halted && <span className="text-warning"> · {trace.halted}</span>}
        {trace.stop_reason && (
          <span className="text-muted-foreground"> · {trace.stop_reason}</span>
        )}
        {trace.latency_ms != null && (
          <span className="text-muted-foreground"> · {trace.latency_ms}ms</span>
        )}
      </summary>
      <div className="mt-2 space-y-2">
        {calls.length > 0 && (
          <ol className="space-y-1.5">
            {calls.map((c, ci) => (
              <li key={ci} className="border-l-2 pl-2 border-border-hint">
                <div className="flex items-center gap-2 text-[10px]">
                  <span
                    className={`font-mono font-semibold ${
                      c.is_error ? "text-danger" : "text-foreground"
                    }`}
                  >
                    {c.name}
                  </span>
                  <span className="text-muted-foreground">{c.duration_ms}ms</span>
                </div>
                <pre className="whitespace-pre-wrap break-words text-[10px] text-muted-foreground mt-0.5">
                  {JSON.stringify(c.input, null, 2)}
                </pre>
                <pre
                  className={`whitespace-pre-wrap break-words text-[10px] mt-0.5 ${
                    c.is_error ? "text-danger" : "text-foreground"
                  }`}
                >
                  {c.result}
                </pre>
              </li>
            ))}
          </ol>
        )}
        {artifacts.length > 0 && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Artifacts
            </div>
            <ul className="mt-1 space-y-1">
              {artifacts.map((a) => (
                <li key={a.sha256 + a.path} className="text-[10px]">
                  <div className="flex gap-2 items-center">
                    <span className="font-mono text-foreground">{a.path}</span>
                    <span className="text-muted-foreground">{a.size}B</span>
                    {a.binary && <span className="text-muted-foreground">(binary)</span>}
                  </div>
                  {a.preview && (
                    <pre className="whitespace-pre-wrap break-words text-muted-foreground mt-0.5 max-h-32 overflow-auto">
                      {a.preview}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {trace.final_text && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              Final text
            </div>
            <pre className="whitespace-pre-wrap break-words text-foreground text-[10px] mt-0.5">
              {trace.final_text}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
