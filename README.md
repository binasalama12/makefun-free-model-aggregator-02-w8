# LatencyAware Gateway

A single-file free-model aggregator built for the make.fun
`free-model-aggregator-02` competition. Point any OpenAI- or Anthropic-shaped
client at this server and every completion is dialled live, through the trial
gateway, to a free OpenRouter model taken from the brief at
`$MAKEFUN_PROMPT_FILE`. Nothing is hard-coded: the catalog, the ratings and
the capability flags all come from that brief.

## What it serves

- `GET /v1/models` — the free catalog, in the OpenAI list shape when the
  request carries an `Authorization` header and in the Anthropic shape when
  it carries `x-api-key`.
- `POST /v1/chat/completions` — OpenAI wire, JSON or server-sent events.
- `POST /v1/messages` — Anthropic wire, JSON or server-sent events. Requests
  are translated to Chat Completions for the gateway and answers are
  translated back, including tool calls, stop reasons and usage.

`node main.ts --list` prints the catalog JSON document and exits; the exact
same document is sent to the env in the register call.

## How it routes

Requests name `model: "auto"`. For each one the gateway:

1. Reads the request's real needs off its body — declared tools need a
   tools-capable model, a JSON `response_format` needs a JSON-capable model,
   image parts need a vision-capable model.
2. Ranks the capable free models greedily by the brief's published
   `rating_milli`.
3. Applies a **latency demotion**: the elapsed duration of every gateway call
   already made in this run is kept in a small ledger. A model that answers
   slowly (a single call over the slow threshold, or a slow running average)
   loses points from its effective rating for the next few routing decisions,
   so traffic drifts toward models that are both good *and* quick right now.
   The penalty is graduated: the slower the model's running average, the more
   points it sheds. The demotion is fed only by durations of calls already
   completed in the same trial — never by an absolute clock reading.
4. Dials the winner through the gateway. On a 429, a 5xx or a network error
   it fails over to the next ranked model, parks the refused model so later
   prompts do not waste calls on it, and reports the recovered refusals on
   the final response in the `x-makefun-upstream-failures` header. The park
   escalates while a model keeps refusing (a success resets it), so a
   chronically rate-limited model is re-probed less and less often.

The `model` field of every response and every streamed chunk is the id that
was actually dialled. The server polls `$MAKEFUN_ENV_URL/work` every 100 ms
and exits 0 as soon as the trial is done.

## Running

Node 22+, standard library only — there is nothing to install.

```sh
MAKEFUN_PROMPT_FILE=<brief> node main.ts --list   # print the catalog
MAKEFUN_PROMPT_FILE=<brief> MAKEFUN_ENV_URL=<env> OPENAI_BASE_URL=<gateway> \
  OPENAI_API_KEY=<trial key> node main.ts          # run the trial server
```
