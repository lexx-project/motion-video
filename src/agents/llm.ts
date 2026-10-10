import fs from "fs";
import os from "os";
import path from "path";
import { stageError, StudioError, type ErrorStage } from "../core/errors";
import { PIPELINE } from "../core/output";
import {
  activeGenerationBudget,
  BudgetExhaustedError,
  isBudgetExhausted,
  type LlmCallOutcome,
} from "../core/generationBudget";

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** Strip // and /* *\/ comments from JSONC (opencode.jsonc) without breaking strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 < text.length) {
          out += text[i + 1];
          i++;
        }
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function readJsonc(file: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface ProviderDef {
  options?: { baseURL?: string; apiKey?: string };
  models?: Record<string, unknown>;
}

/**
 * Resolve the LLM endpoint: env override -> project opencode.json model ->
 * global ~/.config/opencode/opencode.jsonc provider (baseURL/apiKey).
 * Primary model: MiMo V2.6 Flash via the user's OpenCode/Zen setup (MASTER_SPEC 0).
 */
export function resolveLlmConfig(): LlmConfig {
  const global = readJsonc(path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"));
  const project = readJsonc(path.join(process.cwd(), "opencode.json"));
  const providers = ((global?.provider ?? {}) as Record<string, ProviderDef>) ?? {};

  const envBase = process.env.STUDIO_LLM_BASE_URL;
  const envKey = process.env.STUDIO_LLM_API_KEY;
  const envModel = process.env.STUDIO_LLM_MODEL;
  if (envBase && envKey && envModel) {
    return { baseURL: envBase, apiKey: envKey, model: envModel };
  }

  const modelId =
    envModel ??
    (typeof project?.model === "string" ? project.model : undefined) ??
    (typeof global?.model === "string" ? global.model : undefined) ??
    "router-asli/oc/mimo-v2.6-flash-free";

  const slash = modelId.indexOf("/");
  const providerId = slash > 0 ? modelId.slice(0, slash) : undefined;
  const restModel = slash > 0 ? modelId.slice(slash + 1) : modelId;

  if (providerId && providers[providerId]) {
    const def = providers[providerId];
    const baseURL = envBase ?? def.options?.baseURL;
    const apiKey = envKey ?? def.options?.apiKey;
    if (baseURL && apiKey) return { baseURL, apiKey, model: restModel };
  }

  // Fall back: find a provider that declares this exact model key.
  const matches = Object.entries(providers).filter(([, def]) => def.models && restModel in def.models);
  if (matches.length === 1) {
    const [, def] = matches[0];
    const baseURL = envBase ?? def.options?.baseURL;
    const apiKey = envKey ?? def.options?.apiKey;
    if (baseURL && apiKey) return { baseURL, apiKey, model: restModel };
  }
  if (matches.length > 1) {
    const withCreds = matches.filter(([, def]) => def.options?.baseURL && def.options?.apiKey);
    if (withCreds.length >= 1) {
      const [, def] = withCreds[0];
      return {
        baseURL: envBase ?? def.options!.baseURL!,
        apiKey: envKey ?? def.options!.apiKey!,
        model: restModel,
      };
    }
  }

  throw stageError("llm", `Cannot resolve LLM endpoint for model "${modelId}". Set STUDIO_LLM_BASE_URL / STUDIO_LLM_API_KEY / STUDIO_LLM_MODEL.`, {
    recoverable: false,
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

let cachedConfig: LlmConfig | null = null;
export function llmConfig(): LlmConfig {
  if (!cachedConfig) cachedConfig = resolveLlmConfig();
  return cachedConfig;
}

/* ---------------------------------------------------------------------------
 * Global request queue: concurrency 1, minimum spacing with jitter.
 * Free-tier providers punish parallel bursts - all LLM calls (text + vision)
 * are serialized here. Scheduling jitter only; render-time stays deterministic.
 * ------------------------------------------------------------------------- */
let queueTail: Promise<unknown> = Promise.resolve();
let queueNextSlot = 0;
const QUEUE_GAP_MIN_MS = 900;
const QUEUE_GAP_JITTER_MS = 700;

export function enqueueLlm<T>(task: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = queueNextSlot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      queueNextSlot =
        Date.now() + QUEUE_GAP_MIN_MS + Math.floor(Math.random() * QUEUE_GAP_JITTER_MS);
    }
  };
  const p = queueTail.then(run, run);
  queueTail = p.catch(() => undefined);
  return p;
}

async function executeChat(
  body: Record<string, unknown>,
): Promise<string> {
  const cfg = llmConfig();
  let lastError = "";
  let consecutive524 = 0;
  // Batch E / Phase 1: bounded retries. Was 12 (a single logical call could burn ~17 min);
  // now 4 attempts x 85s abort + backoff = a hard ~6 min ceiling per call, and the active
  // generation budget re-checks the deadline before every attempt.
  const transientAttempts = 4;
  for (let attempt = 1; attempt <= Math.max(transientAttempts, PIPELINE.llmAttemptsMax + 1); attempt++) {
    const budget = activeGenerationBudget();
    if (budget && budget.remainingMs() < budget.config.minCallMs) {
      throw new BudgetExhaustedError("llm", `call abandoned mid-retry (deadline reached after ${attempt - 1} attempt(s))`);
    }
    try {
      const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        // Abort at 85s: Cloudflare proxy kills at 100s. Fail fast so we can retry
        // immediately rather than holding a dead connection for 3 minutes.
        signal: AbortSignal.timeout(85_000),
      });
      if (!res.ok) {
        const text = await res.text();
        lastError = `HTTP ${res.status}: ${text.slice(0, 400)}`;
        // HTTP524 (gateway timeout): generation took > 100s at proxy.
        // Reduce token budget then retry with randomized backoff to avoid thundering herd.
        if (res.status === 524) {
          consecutive524 += 1;
          // Aggressively shrink token budget on repeated 524s so requests get shorter/faster.
          if (consecutive524 >= 2) {
            const cap = Number(body.max_tokens ?? 4000);
            if (cap > 2000) body.max_tokens = Math.max(2000, Math.floor(cap * 0.7));
          }
          // Randomized backoff: 3-12s with added jitter so parallel retries don't collide.
          const wait = 3_000 + Math.floor(Math.random() * 9_000);
          console.warn(`[llm-524] Proxy timeout (attempt ${attempt}/${transientAttempts}), shrinking budget→${String(body.max_tokens)}, backing off ${Math.round(wait / 1000)}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        // Upstream/provider-side errors (proven-valid request shape) are transient: backoff + retry.
        const upstreamTransient =
          (res.status === 400 && /Upstream request failed|Provider returned error|server_error/i.test(text)) ||
          res.status >= 500 ||
          res.status === 429;
        if (res.status === 400 && (body as Record<string, unknown>).response_format) {
          // provider may not support response_format - drop it once and retry
          delete (body as Record<string, unknown>).response_format;
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (upstreamTransient) {
          // exponential backoff with jitter; 429 (free tier) needs a real window and
          // gateway blips (5xx/502) get a longer inter-attempt pause so a brief provider
          // outage does not kill an entire generation (Batch E - still bounded: 4 attempts).
          const base =
            res.status === 429
              ? Math.min(60_000, 15_000 * attempt)
              : res.status >= 500
                ? attempt * 5_000
                : attempt * 1500;
          const wait = base + Math.floor(Math.random() * 2500);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw stageError("llm", `LLM request failed (${lastError})`, { recoverable: false });
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      const truncated = choice?.finish_reason === "length";
      if (truncated || typeof content !== "string" || content.trim().length === 0) {
        lastError = truncated
          ? "truncated completion (finish_reason=length) - reasoning consumed the token budget"
          : "empty completion content";
        {
          const usage = (json as { usage?: { completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } }).usage;
          console.warn(
            `[llm-truncation] ${lastError} | completion=${usage?.completion_tokens ?? "?"} reasoning=${usage?.completion_tokens_details?.reasoning_tokens ?? "?"} cap=${body.max_tokens} effort=${String(body.reasoning_effort ?? "default")} contentLen=${String(content ?? "").length}`,
          );
        }
        // On a reasoning model a short/empty payload means thinking ate the budget:
        // grow it for the next attempt (inverse of the 524 squeeze).
        const cap = Number(body.max_tokens ?? 8000);
        if (cap < 16000) body.max_tokens = Math.min(16000, Math.max(cap * 2, 8000));
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      return content;
    } catch (e) {
      if (e instanceof StudioError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, attempt * 1500 + Math.floor(Math.random() * 1500)));
    }
  }
  throw stageError("llm", `LLM call failed after retries: ${lastError}`, {
    recoverable: false,
  });
}

export async function chatRaw(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; reasoningEffort?: "low" | "medium" | "high" | "none" | "minimal"; jsonMode?: boolean; stage?: string } = {},
): Promise<string> {
  const stage = opts.stage ?? "llm";
  const budget = activeGenerationBudget();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // Batch E / Phase 1: the generation budget gates EVERY logical call - checked BEFORE any
  // provider config/network work so refusal is deterministic and cheap.
  if (budget && !budget.allowLlmCall()) {
    budget.recordLlmCall({
      stage,
      startedAt,
      ms: 0,
      outcome: "budget_refused",
      detail: `calls=${budget.llmCalls}/${budget.config.maxLlmCalls} remaining=${Math.round(budget.remainingMs() / 1000)}s`,
    });
    throw new BudgetExhaustedError("llm", `call "${stage}" refused (calls=${budget.llmCalls}/${budget.config.maxLlmCalls}, ${Math.round(budget.remainingMs() / 1000)}s left)`);
  }

  const cfg = llmConfig();
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.5,
    max_tokens: opts.maxTokens ?? 8000,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  try {
    const out = await enqueueLlm(() => executeChat(body));
    budget?.recordLlmCall({ stage, startedAt, ms: Date.now() - t0, outcome: "ok" });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const outcome: LlmCallOutcome = isBudgetExhausted(e)
      ? "budget_refused"
      : /timed out|timeout|aborted/i.test(msg)
        ? "timeout"
        : "error";
    budget?.recordLlmCall({ stage, startedAt, ms: Date.now() - t0, outcome, detail: msg.slice(0, 160) });
    throw e;
  }
}

/** Parse JSON tolerating trailing commas (a common model slip); downstream Zod stays strict. */
function parseLenient(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return tryAutoCloseJson(raw);
    }
  }
}

function tryAutoCloseJson(raw: string): unknown | undefined {
  try {
    let cleaned = raw.trim();
    const startIdx = cleaned.search(/[{[]/);
    if (startIdx === -1) return undefined;
    cleaned = cleaned.slice(startIdx);

    // If ends inside string, close string
    let inStr = false;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '"' && (i === 0 || cleaned[i - 1] !== "\\")) {
        inStr = !inStr;
      }
    }
    if (inStr) cleaned += '"';

    // Find unclosed brackets/braces
    const stack: string[] = [];
    inStr = false;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '"' && (i === 0 || cleaned[i - 1] !== "\\")) {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
        }
      }
    }
    if (stack.length > 0) {
      cleaned = cleaned.replace(/,\s*$/, "").replace(/:\s*$/, ": null").replace(/,\s*$/, "");
      cleaned += stack.reverse().join("");
      try {
        return JSON.parse(cleaned);
      } catch {
        return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1"));
      }
    }
  } catch {
    // continue
  }
  return undefined;
}

/** Extract the first balanced JSON object/array from a model response (handles ```json fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const c of candidates) {
    const startIdx = c.search(/[{[]/);
    if (startIdx === -1) continue;
    const open = c[startIdx];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    for (let i = startIdx; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const raw = c.slice(startIdx, i + 1);
          const parsed = parseLenient(raw);
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
    const whole = parseLenient(c.trim());
    if (whole !== undefined) return whole;
  }
  // Distinguish "cut off mid-JSON" from other parse failures so the corrective
  // re-ask tells the model to emit SHORTER output instead of repeating the same length.
  const openCount = (text.match(/[{[]/g) ?? []).length;
  const closeCount = (text.match(/[}\]]/g) ?? []).length;
  const likelyTruncated = openCount > closeCount;
  throw stageError(
    "llm",
    likelyTruncated
      ? `LLM response appears TRUNCATED mid-JSON (unclosed ${openCount - closeCount} block(s)). Re-ask with: output a SHORTER response - cut rationale prose to one sentence, keep only required keys. Head: ${text.slice(0, 400)}`
      : `No parseable JSON in LLM response. Head: ${text.slice(0, 400)}`,
    { recoverable: true },
  );
}

export interface CompleteJsonOptions<T> {
  stage: ErrorStage;
  projectId?: string;
  system: string;
  user: string;
  /** validate + map the parsed object; throw StudioError (recoverable) to trigger one re-ask */
  parse: (obj: unknown) => T;
  temperature?: number;
  maxTokens?: number;
  /** override re-ask budget (default PIPELINE.llmAttemptsMax) */
  attempts?: number;
  /** reasoning effort for structured calls (default "low" - see completeJson) */
  reasoningEffort?: "low" | "medium" | "high" | "none" | "minimal";
}

/**
 * Structured generation with one corrective re-ask: parse failure feeds the error
 * back to the model (quality over token efficiency - MASTER_SPEC 0).
 */
export async function completeJson<T>(opts: CompleteJsonOptions<T>): Promise<T> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  let lastErr = "";
  const attempts = opts.attempts ?? PIPELINE.llmAttemptsMax;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Batch E / Phase 1: no repeated identical STRUCTURED prompt inside one generation
    // (generation + repair calls are byte-different after a corrective re-ask, so a repeat
    // means "no new evidence" - refused instead of silently re-spending the budget).
    const budget = activeGenerationBudget();
    if (budget && attempt === 1 && !budget.recordPrompt(JSON.stringify(messages))) {
      budget.duplicatePromptsRefused += 1;
      throw stageError(opts.stage, `duplicate prompt refused by the generation budget (stage "${opts.stage}") - no new evidence, will not repeat`, {
        projectId: opts.projectId,
        recoverable: false,
        data: { duplicatePrompt: true, stage: opts.stage },
      });
    }
    const raw = await chatRaw(messages, {
      temperature: opts.temperature,
      // Default 4000 instead of 8000: cuts generation time ~50%, keeps responses
      // under the 100-second Cloudflare proxy window (the main cause of 524s).
      maxTokens: opts.maxTokens ?? 4000,
      // structured-output tasks: cap runaway reasoning (free-tier gateway timeouts +
      // finish_reason=length both stem from thinking consuming the whole budget)
      reasoningEffort: opts.reasoningEffort ?? "low",
      jsonMode: true,
      stage: opts.stage,
    });
    try {
      const obj = extractJson(raw);
      return opts.parse(obj);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Your previous response was invalid:\n${lastErr}\nRespond again with ONLY the corrected JSON object, no markdown, no commentary.`,
      });
    }
  }
  throw stageError(opts.stage, `LLM produced invalid structured output after ${PIPELINE.llmAttemptsMax} attempts: ${lastErr}`, {
    projectId: opts.projectId,
    recoverable: false,
  });
}

/** Sniff image mime from base64 magic bytes (JPEG frames were being sent as image/png,
 *  which some providers drop - the model then honestly reports it cannot see them). */
function sniffImageMime(b64: string): string {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

export async function chatVision(
  text: string,
  imagesBase64: string[],
  opts: { temperature?: number; maxTokens?: number; reasoningEffort?: "low" | "medium" | "high" | "none" | "minimal"; stage?: string } = {},
): Promise<string> {
  const content: ContentPart[] = [{ type: "text", text }];
  for (const b64 of imagesBase64) {
    content.push({ type: "image_url", image_url: { url: `data:${sniffImageMime(b64)};base64,${b64}` } });
  }
  // Vision calls don't need chain-of-thought reasoning; skip it to stay
  // under the 100-second Cloudflare proxy timeout.
  return chatRaw([{ role: "user", content }], {
    ...opts,
    reasoningEffort: opts.reasoningEffort ?? "none",
  });
}
