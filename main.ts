// LatencyAware Gateway — a free-model aggregator for free-model-aggregator-02.
//
// One process, two client wires (OpenAI Chat Completions + Anthropic Messages),
// one upstream wire (the grader gateway's Chat Completions route). Every answer
// is a real completion from a free OpenRouter model named in the trial brief.
//
// Routing personality of this wallet:
//   * rating-greedy — among the free models that can actually serve a request
//     (tools / vision / JSON-mode capability taken from the brief), the highest
//     published rating_milli wins;
//   * latency-aware demotion — the elapsed duration of every gateway call this
//     process has already made is remembered; a model whose calls run slow is
//     temporarily pushed down the ranking so a snappier model gets the next
//     prompts instead. Only durations of calls already completed inside this
//     same trial feed the demotion — never an absolute wall-clock reading, so
//     nothing time-shaped is ever written into a request;
//   * refusal cooldown — a model the gateway refuses (429 / 5xx / network) is
//     parked for the next few routing decisions and never dialled while parked.
//
// Determinism: apart from the measured call durations above (an explicit part
// of this entry's routing), every choice is a pure function of the brief, the
// incoming request and the gateway answers seen so far. No Date.now(), no
// Math.random(); MAKEFUN_TRIAL_SEED is therefore not needed — ties break on
// rating, then on model id, always in the same order.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

type Bag = Record<string, unknown>;

const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const numOr0 = (v: unknown): number => asNum(v) ?? 0;

function note(msg: string): void {
  process.stderr.write(`latency-aware: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// The brief: free-model table + prompt manifest, lifted out of the prose file
// at $MAKEFUN_PROMPT_FILE by hunting for JSON objects carrying a `schema`
// member under this competition's prefix.
// ---------------------------------------------------------------------------

interface FreeModel {
  id: string;
  label: string;
  ratingMilli: number;
  contextLength: number | null;
  canTools: boolean | null;
  canVision: boolean | null;
  canJson: boolean | null;
}

interface Need {
  tools: boolean;
  vision: boolean;
  json: boolean;
}

interface BriefData {
  models: FreeModel[];
  promptCount: number;
}

/** Index just past the `}` that closes the object opening at `from`. */
function closingBrace(text: string, from: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every top-level JSON object in the brief prose that carries a schema tag. */
function schemaDocs(text: string): Bag[] {
  const found: Bag[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = closingBrace(text, at);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(at, end + 1));
      if (isBag(parsed) && typeof parsed.schema === 'string') found.push(parsed);
    } catch {
      // prose brace, not a document — keep scanning
    }
  }
  return found;
}

function loadBrief(path: string): BriefData {
  const empty: BriefData = { models: [], promptCount: 0 };
  if (!path) return empty;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return empty;
  }
  const docs = schemaDocs(text).filter((d) => asStr(d.schema).startsWith('free-model-aggregator-02/'));
  let models: FreeModel[] = [];
  let promptCount = 0;
  for (const doc of docs) {
    if (Array.isArray(doc.models) && models.length === 0) {
      models = doc.models.flatMap((raw): FreeModel[] => {
        if (!isBag(raw)) return [];
        const id = asStr(raw.id) || asStr(raw.model);
        if (!id || raw.free === false) return [];
        return [{
          id,
          label: asStr(raw.display_name) || id,
          ratingMilli: asNum(raw.rating_milli) ?? 0,
          contextLength: asNum(raw.context_length),
          canTools: asBool(raw.tools),
          canVision: asBool(raw.vision),
          canJson: asBool(raw.json),
        }];
      });
    }
    if (Array.isArray(doc.prompts)) promptCount = doc.prompts.length;
  }
  return { models, promptCount };
}

// ---------------------------------------------------------------------------
// Catalog — built only from the brief. `--list` prints exactly the object the
// register call sends; both come from this one builder so they cannot drift.
// ---------------------------------------------------------------------------

interface CatalogDoc {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: Array<{ id: string; free: boolean; context_length: number | null }>;
  }>;
}

function makeCatalog(brief: BriefData): CatalogDoc {
  if (brief.models.length === 0) return { providers: [] };
  const seen = new Set<string>();
  const rows: CatalogDoc['providers'][number]['models'] = [];
  for (const m of brief.models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    rows.push({ id: m.id, free: true, context_length: m.contextLength });
  }
  return {
    providers: [{
      id: 'openrouter',
      base_url: 'https://openrouter.ai/api/v1',
      key_env: 'OPENROUTER_API_KEY',
      wire: 'openai',
      models: rows,
    }],
  };
}

// ---------------------------------------------------------------------------
// Latency ledger + refusal cooldowns — the memory this router learns from.
// All counters advance on *events* (a finished call, a new routing decision),
// never on a clock, so the state machine replays identically.
// ---------------------------------------------------------------------------

interface ModelHealth {
  calls: number;
  totalMs: number;
  worstMs: number;
  /** Routing decisions for which this model stays demoted after a slow call. */
  demoteLeft: number;
  /** Routing decisions for which this model is parked after a refusal. */
  parkLeft: number;
}

const SLOW_CALL_MS = 3500;      // one call slower than this earns a demotion
const SLOW_AVG_MS = 2500;       // …and so does a slow running average
const DEMOTE_SPAN = 3;          // decisions a latency demotion lasts
const DEMOTE_POINTS = 260;      // milli-points subtracted while demoted
const PARK_AFTER_429 = 3;       // decisions a rate-limited model sits out
const PARK_AFTER_5XX = 2;       // decisions a 5xx-refused model sits out

const health = new Map<string, ModelHealth>();

function healthOf(id: string): ModelHealth {
  let h = health.get(id);
  if (!h) {
    h = { calls: 0, totalMs: 0, worstMs: 0, demoteLeft: 0, parkLeft: 0 };
    health.set(id, h);
  }
  return h;
}

/** One routing decision is starting: age every demotion and parking by one. */
function tickDecisions(): void {
  for (const h of health.values()) {
    if (h.demoteLeft > 0) h.demoteLeft--;
    if (h.parkLeft > 0) h.parkLeft--;
  }
}

/** Remember how long a finished gateway call took; demote chronic slowness. */
function observeDuration(id: string, ms: number): void {
  const h = healthOf(id);
  h.calls++;
  h.totalMs += ms;
  if (ms > h.worstMs) h.worstMs = ms;
  const avg = h.totalMs / h.calls;
  if (ms > SLOW_CALL_MS || (h.calls >= 2 && avg > SLOW_AVG_MS)) {
    h.demoteLeft = DEMOTE_SPAN;
  }
}

/** Park a refused model so later prompts do not burn calls on it. */
function observeRefusal(id: string, status: number): void {
  const h = healthOf(id);
  h.parkLeft = status === 429 ? PARK_AFTER_429 : PARK_AFTER_5XX;
}

/** Rating after the latency demotion: greedy, but a slow model steps aside. */
function effectiveRating(m: FreeModel): number {
  const h = health.get(m.id);
  if (h && h.demoteLeft > 0) return m.ratingMilli - DEMOTE_POINTS;
  return m.ratingMilli;
}

function capable(m: FreeModel, need: Need): boolean {
  if (need.tools && m.canTools !== true) return false;
  if (need.vision && m.canVision !== true) return false;
  if (need.json && m.canJson !== true) return false;
  return true;
}

/**
 * Ranked dial order for one request: eligible models by effective rating
 * (raw rating, then id, break ties), parked models held back — unless every
 * eligible model is parked, in which case the park is ignored rather than
 * leaving the prompt unserved.
 */
function dialOrder(models: FreeModel[], need: Need): FreeModel[] {
  const eligible = models.filter((m) => capable(m, need));
  const byScore = (a: FreeModel, b: FreeModel): number =>
    effectiveRating(b) - effectiveRating(a) || b.ratingMilli - a.ratingMilli || (a.id < b.id ? -1 : 1);
  const awake = eligible.filter((m) => (health.get(m.id)?.parkLeft ?? 0) === 0).sort(byScore);
  if (awake.length > 0) return awake;
  return eligible.sort(byScore);
}

/** What a request body demands, read off the body itself (either wire). */
function needFromOpenAI(body: Bag): Need {
  let vision = false;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isBag(msg) || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (isBag(part) && part.type === 'image_url') vision = true;
      }
    }
  }
  const fmt = isBag(body.response_format) ? asStr(body.response_format.type) : '';
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: fmt === 'json_object' || fmt === 'json_schema',
  };
}

function needFromAnthropic(body: Bag): Need {
  let vision = false;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isBag(msg) || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (isBag(part) && part.type === 'image') vision = true;
      }
    }
  }
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: false, // the Messages wire has no JSON-mode switch
  };
}

// ---------------------------------------------------------------------------
// Wire translation. The gateway speaks only Chat Completions; Anthropic
// requests are rewritten into it and answers rewritten back. The `model`
// field on every answer and chunk is overwritten with the id actually dialled
// — the provider spells it back without the `openrouter/` prefix, we restore
// the dialled spelling, which is the only truthful claim.
// ---------------------------------------------------------------------------

const LIST_CREATED = 1767225600;                 // fixed: a moving `created` would break replay equality
const LIST_CREATED_AT = '2026-01-01T00:00:00Z';  // fixed, same reason

function openAIList(models: FreeModel[]): Bag {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: LIST_CREATED, owned_by: 'openrouter' })),
  };
}

function anthropicList(models: FreeModel[]): Bag {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.label, created_at: LIST_CREATED_AT })),
    has_more: false,
    first_id: models.length ? models[0].id : null,
    last_id: models.length ? models[models.length - 1].id : null,
  };
}

const errOpenAI = (message: string, type: string, code: string | null): Bag =>
  ({ error: { message, type, code } });
const errAnthropic = (type: string, message: string): Bag =>
  ({ type: 'error', error: { type, message } });

function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isBag(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function toolResultAsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = plainText(content);
    return t !== '' ? t : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function parseArgs(value: unknown): Bag {
  if (isBag(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const p: unknown = JSON.parse(value);
      if (isBag(p)) return p;
    } catch { /* fall through to empty */ }
  }
  return {};
}

function finishToStop(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** Anthropic Messages body → Chat Completions body naming `modelId`. */
function anthropicRequestToOpenAI(body: Bag, modelId: string): Bag {
  const messages: Bag[] = [];
  const sys = plainText(body.system);
  if (sys !== '') messages.push({ role: 'system', content: sys });

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of rawMessages) {
    if (!isBag(raw)) continue;
    const isAssistant = raw.role === 'assistant';
    if (typeof raw.content === 'string') {
      messages.push({ role: isAssistant ? 'assistant' : 'user', content: raw.content });
      continue;
    }
    if (!Array.isArray(raw.content)) continue;
    if (isAssistant) {
      const calls: Bag[] = [];
      for (const block of raw.content) {
        if (!isBag(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: asStr(block.id),
          type: 'function',
          function: {
            name: asStr(block.name),
            arguments: JSON.stringify(isBag(block.input) ? block.input : {}),
          },
        });
      }
      const text = plainText(raw.content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const parts: Bag[] = [];
    for (const block of raw.content) {
      if (!isBag(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: asStr(block.tool_use_id),
          content: toolResultAsText(block.content),
        });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isBag(block.source)) {
        const src = block.source;
        if (src.type === 'base64' && typeof src.data === 'string') {
          const media = asStr(src.media_type) || 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } });
        } else if (src.type === 'url' && typeof src.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts });
  }

  const out: Bag = { model: modelId, messages };
  if (asNum(body.max_tokens) !== null) out.max_tokens = body.max_tokens;
  if (asNum(body.temperature) !== null) out.temperature = body.temperature;
  if (asNum(body.top_p) !== null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw): Bag[] => {
      if (!isBag(raw) || !asStr(raw.name)) return [];
      return [{
        type: 'function',
        function: {
          name: raw.name,
          description: asStr(raw.description),
          parameters: isBag(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
        },
      }];
    });
    if (tools.length) out.tools = tools;
  }
  if (isBag(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && asStr(choice.name)) {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** Chat Completions JSON answer → Anthropic Messages object. */
function openAIAnswerToAnthropic(body: Bag, modelId: string): Bag {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isBag(choices[0]) ? choices[0] : {};
  const message = isBag(choice.message) ? choice.message : {};
  const content: Bag[] = [];
  const text = typeof message.content === 'string' ? message.content : plainText(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isBag(call) || !isBag(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: asStr(call.id) || 'toolu_unknown',
      name: asStr(call.function.name),
      input: parseArgs(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isBag(body.usage) ? body.usage : {};
  return {
    id: `msg_${asStr(body.id) || 'latency-aware'}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content,
    stop_reason: finishToStop(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: numOr0(usage.prompt_tokens),
      output_tokens: numOr0(usage.completion_tokens),
    },
  };
}

function sse(eventName: string | null, data: unknown): string {
  return `${eventName ? `event: ${eventName}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

/** Rewrite one OpenAI SSE frame so every JSON payload names the dialled id. */
function frameWithDialledModel(frame: string, modelId: string): string {
  const lines = frame.split('\n').map((line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return line;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return line;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (isBag(chunk)) return `data: ${JSON.stringify({ ...chunk, model: modelId })}`;
    } catch { /* not JSON — pass the line through */ }
    return line;
  });
  return `${lines.join('\n')}\n\n`;
}

async function* relayOpenAIStream(upstream: ReadableStream<Uint8Array>, modelId: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut = buf.indexOf('\n\n');
      while (cut !== -1) {
        yield frameWithDialledModel(buf.slice(0, cut), modelId);
        buf = buf.slice(cut + 2);
        cut = buf.indexOf('\n\n');
      }
    }
    buf += decoder.decode();
    if (buf.trim() !== '') yield frameWithDialledModel(buf, modelId);
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI SSE in, Anthropic event sequence out, model id = the dialled one. */
async function* relayAsAnthropicEvents(upstream: ReadableStream<Uint8Array>, modelId: string): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let begun = false;
  let closed = false;
  let heldStop: string | null = null;
  let textIdx = -1;
  let nextIdx = 0;
  let inTokens = 0;
  let outTokens = 0;
  const toolIdx = new Map<number, number>();

  const begin = (): string[] => {
    if (begun) return [];
    begun = true;
    return [sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stream', type: 'message', role: 'assistant', model: modelId,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inTokens, output_tokens: 0 },
      },
    })];
  };
  const closeBlocks = (): string[] => {
    const out: string[] = [];
    if (textIdx !== -1) {
      out.push(sse('content_block_stop', { type: 'content_block_stop', index: textIdx }));
      textIdx = -1;
    }
    for (const idx of [...toolIdx.values()].sort((a, b) => a - b)) {
      out.push(sse('content_block_stop', { type: 'content_block_stop', index: idx }));
    }
    toolIdx.clear();
    return out;
  };
  const finish = (stop: string): string[] => {
    if (closed) return [];
    closed = true;
    return [
      ...closeBlocks(),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: outTokens },
      }),
      sse('message_stop', { type: 'message_stop' }),
    ];
  };
  const eventsFor = (frame: string): string[] => {
    const out: string[] = [];
    for (const line of frame.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') {
        out.push(...begin(), ...finish(heldStop ?? 'end_turn'));
        continue;
      }
      let chunk: unknown;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (!isBag(chunk)) continue;
      if (isBag(chunk.usage)) {
        inTokens = numOr0(chunk.usage.prompt_tokens);
        outTokens = numOr0(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isBag(choices[0]) ? choices[0] : null;
      if (!choice) continue;
      const delta = isBag(choice.delta) ? choice.delta : {};
      out.push(...begin());
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIdx === -1) {
          textIdx = nextIdx++;
          out.push(sse('content_block_start', {
            type: 'content_block_start', index: textIdx,
            content_block: { type: 'text', text: '' },
          }));
        }
        out.push(sse('content_block_delta', {
          type: 'content_block_delta', index: textIdx,
          delta: { type: 'text_delta', text: delta.content },
        }));
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isBag(call)) continue;
        const upIdx = asNum(call.index) ?? toolIdx.size;
        let idx = toolIdx.get(upIdx);
        if (idx === undefined) {
          if (textIdx !== -1) {
            out.push(sse('content_block_stop', { type: 'content_block_stop', index: textIdx }));
            textIdx = -1;
          }
          idx = nextIdx++;
          toolIdx.set(upIdx, idx);
          const fn = isBag(call.function) ? call.function : {};
          out.push(sse('content_block_start', {
            type: 'content_block_start', index: idx,
            content_block: {
              type: 'tool_use',
              id: asStr(call.id) || `toolu_${idx}`,
              name: asStr(fn.name),
              input: {},
            },
          }));
        }
        const fn = isBag(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          out.push(sse('content_block_delta', {
            type: 'content_block_delta', index: idx,
            delta: { type: 'input_json_delta', partial_json: fn.arguments },
          }));
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        heldStop = finishToStop(choice.finish_reason);
      }
    }
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut = buf.indexOf('\n\n');
      while (cut !== -1) {
        for (const ev of eventsFor(buf.slice(0, cut))) yield ev;
        buf = buf.slice(cut + 2);
        cut = buf.indexOf('\n\n');
      }
    }
    buf += decoder.decode();
    if (buf.trim() !== '') for (const ev of eventsFor(buf)) yield ev;
  } finally {
    reader.releaseLock();
  }
  if (!closed) {
    for (const ev of begin()) yield ev;
    for (const ev of finish(heldStop ?? 'end_turn')) yield ev;
  }
}

// ---------------------------------------------------------------------------
// Gateway dialling with failover. One prompt walks the ranked dial order until
// a model answers; every refusal is journaled for the
// `x-makefun-upstream-failures` trail and parks the refused model.
// ---------------------------------------------------------------------------

const ENV_BASE = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const BRIEF_PATH = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GW_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GW_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = loadBrief(BRIEF_PATH);
const catalog = makeCatalog(brief);

interface Refusal { status: number; code: string; model: string | null }

function gatewayChatUrl(): string {
  if (!GW_BASE) return '';
  return GW_BASE.endsWith('/v1') ? `${GW_BASE}/chat/completions` : `${GW_BASE}/v1/chat/completions`;
}

/** Guarantee an output cap: the gateway refuses cap-less requests outright. */
function ensureCap(body: Bag): Bag {
  if (asNum(body.max_tokens) === null && asNum(body.max_completion_tokens) === null) {
    return { ...body, max_tokens: 1024 };
  }
  return body;
}

function refusalCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isBag(parsed) && isBag(parsed.error)) {
      return asStr(parsed.error.code) || asStr(parsed.error.type) || `http_${status}`;
    }
  } catch { /* body was not JSON */ }
  return `http_${status}`;
}

interface DialOutcome {
  response: Response | null;
  modelId: string;
  refusals: Refusal[];
  lastStatus: number;
  lastText: string;
}

/**
 * Try each candidate in ranked order. 429 / 5xx / network failures fail over
 * to the next candidate; any other non-OK status is the caller's own error
 * shape and is returned at once (retrying another model cannot fix it).
 * Call durations feed the latency ledger either way.
 */
async function dialWithFailover(candidates: FreeModel[], baseBody: Bag, wantsStream: boolean): Promise<DialOutcome> {
  const refusals: Refusal[] = [];
  let lastStatus = 502;
  let lastText = '';
  for (const candidate of candidates) {
    const payload = ensureCap({ ...baseBody, model: candidate.id });
    if (wantsStream) {
      payload.stream = true;
      if (!isBag(payload.stream_options)) payload.stream_options = { include_usage: true };
    }
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(gatewayChatUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${GW_KEY}`,
          ...(wantsStream ? { accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      observeDuration(candidate.id, performance.now() - started);
      refusals.push({ status: 0, code: 'network_error', model: candidate.id });
      observeRefusal(candidate.id, 503);
      lastStatus = 502;
      lastText = (err as Error).message;
      continue;
    }
    observeDuration(candidate.id, performance.now() - started);
    if (res.ok && res.body !== null) {
      return { response: res, modelId: candidate.id, refusals, lastStatus: 200, lastText: '' };
    }
    const text = await res.text().catch(() => '');
    lastStatus = res.status;
    lastText = text;
    if (res.status === 429 || res.status >= 500) {
      refusals.push({ status: res.status, code: refusalCode(res.status, text), model: candidate.id });
      observeRefusal(candidate.id, res.status);
      continue;
    }
    // A plain 4xx (bad body, disallowed model…) — failover cannot help.
    return { response: null, modelId: candidate.id, refusals, lastStatus: res.status, lastText: text };
  }
  return { response: null, modelId: candidates.length ? candidates[candidates.length - 1].id : '', refusals, lastStatus, lastText };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const BODY_LIMIT = 8 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Bag | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(b);
  }
  if (!chunks.length) return null;
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isBag(v) ? v : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...(extra ?? {}),
  });
  res.end(text);
}

function trailHeader(refusals: Refusal[]): Record<string, string> {
  if (!refusals.length) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(refusals.slice(0, 8)) };
}

/** If the client pinned a real catalog id, honour it first, then the ranking. */
function orderFor(models: FreeModel[], need: Need, pinned: string): FreeModel[] {
  const ranked = dialOrder(models, need);
  if (!pinned || pinned === 'auto') return ranked;
  const pin = models.find((m) => m.id === pinned);
  if (!pin) return ranked;
  return [pin, ...ranked.filter((m) => m.id !== pin.id)];
}

async function serveChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, errOpenAI('request body is not one JSON object', 'invalid_request_error', null));
  tickDecisions();
  const order = orderFor(brief.models, needFromOpenAI(body), asStr(body.model));
  if (!order.length) return sendJson(res, 503, errOpenAI('no free model in the brief can serve this request', 'no_free_model', null));
  const wantsStream = body.stream === true;
  const outcome = await dialWithFailover(order, body, wantsStream);
  const trail = trailHeader(outcome.refusals);
  if (!outcome.response) {
    return sendJson(res, 502, errOpenAI(
      `gateway refused every candidate (last HTTP ${outcome.lastStatus})${outcome.lastText ? `: ${outcome.lastText.slice(0, 400)}` : ''}`,
      'upstream_error', null), trail);
  }
  if (wantsStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const frame of relayOpenAIStream(outcome.response.body!, outcome.modelId)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await outcome.response.json();
  sendJson(res, 200, { ...(isBag(answer) ? answer : {}), model: outcome.modelId }, trail);
}

async function serveMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, errAnthropic('invalid_request_error', 'request body is not one JSON object'));
  tickDecisions();
  const order = orderFor(brief.models, needFromAnthropic(body), asStr(body.model));
  if (!order.length) return sendJson(res, 503, errAnthropic('overloaded_error', 'no free model in the brief can serve this request'));
  const wantsStream = body.stream === true;
  // The upstream body is model-agnostic until dialled; build it per candidate
  // inside the dial loop by using the first candidate as a template holder —
  // dialWithFailover overwrites `model` on every attempt, so any id works.
  const template = anthropicRequestToOpenAI(body, order[0].id);
  const outcome = await dialWithFailover(order, template, wantsStream);
  const trail = trailHeader(outcome.refusals);
  if (!outcome.response) {
    return sendJson(res, 502, errAnthropic('api_error',
      `gateway refused every candidate (last HTTP ${outcome.lastStatus})${outcome.lastText ? `: ${outcome.lastText.slice(0, 400)}` : ''}`), trail);
  }
  if (wantsStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...trail });
    try {
      for await (const ev of relayAsAnthropicEvents(outcome.response.body!, outcome.modelId)) res.write(ev);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await outcome.response.json();
  sendJson(res, 200, openAIAnswerToAnthropic(isBag(answer) ? answer : {}, outcome.modelId), trail);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://latency-aware');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicList(brief.models));
    else sendJson(res, 200, openAIList(brief.models));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return serveChat(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/messages') return serveMessages(req, res);
  const anthropic = url.pathname === '/v1/messages';
  sendJson(res, 404, anthropic
    ? errAnthropic('not_found_error', `no route ${req.method ?? ''} ${url.pathname}`)
    : errOpenAI(`no route ${req.method ?? ''} ${url.pathname}`, 'not_found', null));
}

// ---------------------------------------------------------------------------
// Trial lifecycle: listen → register → poll /work → exit 0 on done.
// ---------------------------------------------------------------------------

async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`register answered HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const reply: unknown = await res.json().catch(() => null);
  if (isBag(reply) && asNum(reply.requests) !== null) {
    note(`registered; env holds ${reply.requests} prompts (brief lists ${brief.promptCount})`);
  }
}

function pollWork(server: Server): void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_BASE}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json();
          if (isBag(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // env not up yet — next tick retries
      } finally {
        busy = false;
      }
    })();
  }, 100);
}

async function boot(): Promise<void> {
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (!ENV_BASE) throw new Error('MAKEFUN_ENV_URL is not set');
  if (!gatewayChatUrl()) throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      note((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        const anthropic = (req.url ?? '').startsWith('/v1/messages');
        sendJson(res, 500, anthropic
          ? errAnthropic('api_error', 'internal failure')
          : errOpenAI('internal failure', 'internal_error', null));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server has no port');
  if (addr.port === 8080) throw new Error('OS handed us 8080, which belongs to the env — restart');
  note(`listening on 0.0.0.0:${addr.port}; ${brief.models.length} free models in the brief`);
  await register(addr.port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollWork(server);
}

try {
  await boot();
} catch (err) {
  note((err as Error).stack ?? String(err));
  process.exit(1);
}
