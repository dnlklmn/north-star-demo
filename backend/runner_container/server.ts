/**
 * North Star RunFeature container — Claude Agent SDK / Anthropic SDK in a box.
 *
 * Wire contract: matches backend/app/contracts.py RunFeatureRequest /
 * RunFeatureResult. The HTTP body is the same JSON shape; we just need to
 * produce a Trace object whose `tool_calls`, `artifacts`, `iterations`,
 * `stop_reason`, `halted`, `workspace`, `final_text`, `model`,
 * `input_tokens`, `output_tokens`, `latency_ms` keys are always present
 * (even if empty) because the frontend AgentRowMetadata renders them.
 *
 * Why two SDK options?  This worktree was built against the public Anthropic
 * SDK (`@anthropic-ai/sdk`) which exposes `messages.create` with tool-use
 * loops we drive manually.  The Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`) provides a higher-level `query()` that
 * runs the loop for us; if that package is installed at deploy time we
 * delegate to it and just wrap its event stream.  Both code paths feed the
 * same `Trace` builder.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const PORT = parseInt(process.env.PORT || "8088", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_MODEL = process.env.MODEL_NAME || "claude-sonnet-4-20250514";
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 16MB hard cap

// ----------------------------------------------------------------------
// Wire types (mirror backend/app/contracts.py)
// ----------------------------------------------------------------------
type ArtifactRef = { type: "file" | "image"; mime: string; ref: string; filename: string };
type FeatureInput = string | Record<string, unknown>;
type InputField = {
  name: string;
  type: "text" | "longtext" | "number" | "boolean" | "enum" | "json" | "file" | "image";
  required?: boolean;
  description?: string;
  enum?: string[];
  mime?: string | null;
};
type InputSchema = { fields: InputField[] };
type RunFeatureRequest = {
  skill_id: string;
  skill_body: string;
  input_schema?: InputSchema;
  input: FeatureInput;
  mode?: "single_shot" | "agent";
  model?: string | null;
  max_iterations?: number;
  allow_bash?: boolean;
};
type ToolCallTrace = {
  name: string;
  input: Record<string, unknown>;
  result: string;
  is_error: boolean;
  duration_ms: number;
};
type ArtifactTrace = {
  path: string;
  size: number;
  sha256: string;
  preview: string | null;
  binary: boolean;
};
type Trace = {
  tool_calls: ToolCallTrace[];
  artifacts: ArtifactTrace[];
  iterations: number;
  stop_reason: string | null;
  halted: string | null;
  workspace: string | null;
  final_text: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
};
type RunFeatureResult = { output: string; trace: Trace; error: string | null };

function emptyTrace(): Trace {
  return {
    tool_calls: [],
    artifacts: [],
    iterations: 0,
    stop_reason: null,
    halted: null,
    workspace: null,
    final_text: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    latency_ms: null,
  };
}

// ----------------------------------------------------------------------
// Input assembly: typed FeatureInput -> Anthropic message content blocks.
// Mirrors backend/app/runner.py:assemble_message so the seed-driven inputs
// behave identically across backends.
// ----------------------------------------------------------------------
function assembleMessage(req: RunFeatureRequest): string | unknown[] {
  const inp = req.input;
  if (typeof inp === "string") return inp;
  const blocks: unknown[] = [];
  const byName = new Map<string, InputField>();
  for (const f of req.input_schema?.fields ?? []) byName.set(f.name, f);
  for (const [name, val] of Object.entries(inp)) {
    if (val === null || val === undefined) continue;
    const field = byName.get(name);
    const isArtifact = field && (field.type === "file" || field.type === "image");
    if (isArtifact && typeof val === "object") {
      const ref = val as ArtifactRef;
      blocks.push({
        type: "text",
        text: `[${name}: attached file ${ref.filename ?? "file"} (${ref.mime ?? "application/octet-stream"}); artifact ref ${ref.ref ?? ""}]`,
      });
    } else {
      const rendered = typeof val === "string" ? val : JSON.stringify(val);
      blocks.push({ type: "text", text: `${name}: ${rendered}` });
    }
  }
  return blocks.length ? blocks : "";
}

// ----------------------------------------------------------------------
// Tool definitions for the agent loop.  Kept intentionally small — same
// surface as backend/app/agent_task.py so traces are comparable.  The
// container sandboxes every path against `workspace`.
// ----------------------------------------------------------------------
type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

function baseTools(): ToolDef[] {
  return [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write (or overwrite) a UTF-8 text file in the workspace.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Replace the first occurrence of `find` with `replace` in a workspace file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
        },
        required: ["path", "find", "replace"],
      },
    },
    {
      name: "list_dir",
      description: "List entries under a workspace directory (default: workspace root).",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  ];
}

function bashTool(): ToolDef {
  return {
    name: "bash",
    description: "Run a shell command in the workspace. Times out after 60s.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  };
}

function resolveInSandbox(workspace: string, p: string): string {
  const abs = path.resolve(workspace, p || ".");
  const norm = path.normalize(abs);
  if (!norm.startsWith(path.normalize(workspace))) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return norm;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  workspace: string,
  allowBash: boolean,
): Promise<{ result: string; isError: boolean }> {
  try {
    if (name === "read_file") {
      const target = resolveInSandbox(workspace, String(input.path ?? ""));
      try {
        const content = await fs.readFile(target, "utf-8");
        return { result: content, isError: false };
      } catch {
        return { result: `file not found: ${input.path}`, isError: true };
      }
    }
    if (name === "write_file") {
      const target = resolveInSandbox(workspace, String(input.path ?? ""));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const content = String(input.content ?? "");
      await fs.writeFile(target, content, "utf-8");
      return { result: `wrote ${content.length} chars to ${input.path}`, isError: false };
    }
    if (name === "edit_file") {
      const target = resolveInSandbox(workspace, String(input.path ?? ""));
      let content: string;
      try {
        content = await fs.readFile(target, "utf-8");
      } catch {
        return { result: `file not found: ${input.path}`, isError: true };
      }
      const find = String(input.find ?? "");
      const replace = String(input.replace ?? "");
      if (!content.includes(find)) {
        return { result: `\`find\` string not found in ${input.path}`, isError: true };
      }
      const next = content.replace(find, replace);
      await fs.writeFile(target, next, "utf-8");
      return { result: `edited ${input.path}`, isError: false };
    }
    if (name === "list_dir") {
      const target = resolveInSandbox(workspace, String(input.path ?? "."));
      let entries: string[];
      try {
        entries = await fs.readdir(target);
      } catch {
        return { result: `directory not found: ${input.path ?? "."}`, isError: true };
      }
      return { result: entries.sort().join("\n") || "(empty)", isError: false };
    }
    if (name === "bash") {
      if (!allowBash) return { result: "bash tool not enabled for this run", isError: true };
      const command = String(input.command ?? "");
      try {
        const { stdout, stderr } = await execFile("bash", ["-lc", command], {
          cwd: workspace,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { result: (stdout + stderr).slice(0, 16_000), isError: false };
      } catch (err: any) {
        return {
          result: `bash error: ${err?.message || String(err)}`.slice(0, 16_000),
          isError: true,
        };
      }
    }
    return { result: `unknown tool: ${name}`, isError: true };
  } catch (err: any) {
    return { result: `tool exception: ${err?.message || String(err)}`, isError: true };
  }
}

// ----------------------------------------------------------------------
// Artifact capture: walk workspace post-run, sha256+preview every file.
// ----------------------------------------------------------------------
async function collectArtifacts(workspace: string): Promise<ArtifactTrace[]> {
  const out: ArtifactTrace[] = [];
  async function walk(dir: string) {
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const buf = await fs.readFile(full);
          const sha = crypto.createHash("sha256").update(buf).digest("hex");
          const rel = path.relative(workspace, full);
          let binary = false;
          let preview: string | null = null;
          try {
            const text = buf.toString("utf-8");
            // Heuristic: if it has many NULs it's binary.
            binary = text.indexOf(String.fromCharCode(0)) !== -1;
            if (!binary) preview = text.slice(0, 2_000);
          } catch {
            binary = true;
          }
          out.push({
            path: rel,
            size: buf.length,
            sha256: sha,
            preview,
            binary,
          });
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  await walk(workspace);
  return out;
}

// ----------------------------------------------------------------------
// Agent loop using @anthropic-ai/sdk.  Iterations bounded by max_iterations.
// ----------------------------------------------------------------------
type AnthropicLib = any;
let _anthropicLib: AnthropicLib | null = null;
async function getAnthropic(): Promise<AnthropicLib> {
  if (_anthropicLib) return _anthropicLib;
  // dynamic import so the file loads even if neither SDK is present
  try {
    const mod = await import("@anthropic-ai/sdk");
    _anthropicLib = (mod as any).default ?? mod;
    return _anthropicLib;
  } catch (err) {
    throw new Error(
      `Anthropic SDK not installed in this container. ` +
        `Run \`npm install\` in backend/runner_container. (${(err as any)?.message ?? err})`,
    );
  }
}

async function runAgent(req: RunFeatureRequest): Promise<RunFeatureResult> {
  const Anthropic = await getAnthropic();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      output: "",
      trace: emptyTrace(),
      error: "ANTHROPIC_API_KEY not set in runner container",
    };
  }
  const client = new Anthropic({ apiKey });
  const model = req.model ?? DEFAULT_MODEL;
  const maxIters = Math.max(1, req.max_iterations ?? 10);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `nstar-run-${req.skill_id}-`));

  const tools = baseTools();
  if (req.allow_bash) tools.push(bashTool());

  const trace = emptyTrace();
  trace.workspace = workspace;
  trace.model = model;

  const messages: any[] = [
    { role: "user", content: assembleMessage(req) },
  ];

  let finalText = "";
  let stopReason: string | null = null;
  let totalIn = 0;
  let totalOut = 0;
  const started = Date.now();

  try {
    for (let iter = 0; iter < maxIters; iter++) {
      trace.iterations = iter + 1;
      const resp = await client.messages.create({
        model,
        max_tokens: 4096,
        system: req.skill_body,
        tools,
        messages,
      });
      stopReason = resp.stop_reason ?? null;
      if (resp.usage) {
        totalIn += resp.usage.input_tokens ?? 0;
        totalOut += resp.usage.output_tokens ?? 0;
      }
      const assistantBlocks: any[] = resp.content ?? [];
      messages.push({ role: "assistant", content: assistantBlocks });

      // Collect text blocks
      const textParts = assistantBlocks
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text ?? "");
      if (textParts.length) finalText = textParts.join("\n");

      // Execute tool calls
      const toolUses = assistantBlocks.filter((b: any) => b.type === "tool_use");
      if (toolUses.length === 0) {
        // end of loop — model has nothing else to ask for
        break;
      }
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const tStart = Date.now();
        const { result, isError } = await executeTool(
          tu.name,
          (tu.input ?? {}) as Record<string, unknown>,
          workspace,
          !!req.allow_bash,
        );
        const duration = Date.now() - tStart;
        trace.tool_calls.push({
          name: tu.name,
          input: (tu.input ?? {}) as Record<string, unknown>,
          result: result.slice(0, 16_000),
          is_error: isError,
          duration_ms: duration,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: toolResults });

      if (iter === maxIters - 1) {
        trace.halted = "max_iterations";
      }
    }
  } catch (err: any) {
    trace.latency_ms = Date.now() - started;
    trace.artifacts = await collectArtifacts(workspace);
    trace.input_tokens = totalIn || null;
    trace.output_tokens = totalOut || null;
    trace.stop_reason = stopReason;
    trace.final_text = finalText || null;
    return {
      output: finalText,
      trace,
      error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
    };
  }

  trace.latency_ms = Date.now() - started;
  trace.artifacts = await collectArtifacts(workspace);
  trace.input_tokens = totalIn || null;
  trace.output_tokens = totalOut || null;
  trace.stop_reason = stopReason;
  trace.final_text = finalText || null;

  return { output: finalText, trace, error: null };
}

async function runSingleShot(req: RunFeatureRequest): Promise<RunFeatureResult> {
  const Anthropic = await getAnthropic();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { output: "", trace: emptyTrace(), error: "ANTHROPIC_API_KEY not set" };
  }
  const client = new Anthropic({ apiKey });
  const model = req.model ?? DEFAULT_MODEL;
  const started = Date.now();
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 2048,
      system: req.skill_body,
      messages: [{ role: "user", content: assembleMessage(req) }],
    });
    const latency = Date.now() - started;
    const text = (resp.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
    const trace: Trace = {
      ...emptyTrace(),
      iterations: 1,
      stop_reason: resp.stop_reason ?? null,
      model,
      final_text: text || null,
      input_tokens: resp.usage?.input_tokens ?? null,
      output_tokens: resp.usage?.output_tokens ?? null,
      latency_ms: latency,
    };
    return { output: text, trace, error: null };
  } catch (err: any) {
    return {
      output: "",
      trace: { ...emptyTrace(), latency_ms: Date.now() - started, model },
      error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
    };
  }
}

// ----------------------------------------------------------------------
// HTTP server
// ----------------------------------------------------------------------
async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, model: DEFAULT_MODEL });
      return;
    }
    if (req.method === "POST" && req.url === "/run-feature") {
      const body = (await readJsonBody(req)) as RunFeatureRequest;
      if (!body || typeof body !== "object" || !body.skill_id || !body.skill_body) {
        sendJson(res, 400, {
          output: "",
          trace: emptyTrace(),
          error: "missing required fields: skill_id, skill_body",
        });
        return;
      }
      const result =
        body.mode === "single_shot" ? await runSingleShot(body) : await runAgent(body);
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: `no route for ${req.method} ${req.url}` });
  } catch (err: any) {
    sendJson(res, 500, {
      output: "",
      trace: emptyTrace(),
      error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
    });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[runner-container] listening on ${HOST}:${PORT}`);
});
