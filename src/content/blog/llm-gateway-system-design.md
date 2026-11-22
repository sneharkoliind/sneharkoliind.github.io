---
title: "Designing an LLM Gateway: the complete guide, from ingress to evals"
description: "Everything you need to build an LLM gateway as a product: ingress and egress, auth, token-based rate limiting with Redis, model routing, batch jobs, failover and circuit breakers, caching, guardrails, cost metering, observability, agent tracing and evals, with the data stores and trade-offs behind each piece."
pubDate: 2026-11-23
tags: ["system-design", "llm-platforms", "ai-agents", "distributed-systems", "redis"]
draft: false
---

Picture a company where 200 internal teams call OpenAI, Anthropic and Amazon Bedrock directly. Each team has its own API keys, its own retry logic and its own idea of what "too expensive" means. Nobody can answer simple questions:

- How much did we spend on LLMs last month, and which team spent it?
- Which teams are sending customer data to which provider?
- When a provider has an outage, what breaks?
- One team's batch job just hit our shared provider quota. Why is everyone else getting `429`s?

The usual answer is an **LLM gateway**: a single service that every LLM call in the company goes through. It sounds like a reverse proxy, and at its core it is one. But it needs the hard parts of a lot of distributed systems at once: multi-tenant rate limiting, long-lived streaming connections, failover between providers that don't behave the same way, metering accurate enough to bill on, and tracing for agents that make dozens of calls per task.

This post is the full design, written so that someone **building an LLM gateway as a product** gets all the theory in one place: every component, why it exists, which data store backs it, and the trade-offs. It also works as preparation for a senior system design interview, which is how it started for me.

---

## 1. Requirements first

At senior level, framing the problem matters more than the boxes you draw. Every requirement below changes the architecture.

### Functional requirements

1. **One API for many models.** Callers use one interface, and the gateway translates it for OpenAI, Anthropic, Bedrock, Vertex AI or self-hosted models.
2. **Streaming.** Tokens reach the caller as the model generates them.
3. **Multi-tenancy.** Teams (tenants), projects and API keys get their own quotas, budgets and policies.
4. **Routing.** Model aliases (`fast`, `smart`), cost-based routing and fallbacks.
5. **Sync and async.** Interactive calls are answered in seconds. Batch jobs are queued, tracked and processed later.
6. **Metering and chargeback.** Every token is attributed to a team, priced and reported.
7. **Guardrails.** PII redaction, content filters and prompt-injection defences.
8. **Observability.** Logs, metrics and traces, including **agent runs** that span many LLM and tool calls.
9. **Evals.** Measure quality, so routing and model upgrades are based on data rather than guesses.

### Non-functional requirements

| Requirement | Why it changes the design |
|---|---|
| **Low added latency** (p99 overhead < 20–50 ms) | The gateway must stream tokens straight through, never buffer whole responses, and keep slow work (logging, metering) off the request path. |
| **High availability** (99.95%+) | If every LLM call goes through the gateway, the gateway *is* the LLM platform. It has to be stateless, run across availability zones, and keep working when its own dependencies degrade. |
| **Scale** | You need numbers (below). They decide instance counts, Redis sizing and the metering pipeline. |
| **Tenant isolation** | One team must not be able to starve others, or read their data. |
| **Security and compliance** | Some data may only go to certain providers or regions. Raw provider keys never leave the gateway. |
| **Accurate cost data** | Finance will bill on it, so usage events can't be lost or double-counted. |

### Back-of-envelope numbers

Always put numbers on it. Assume:

- 200 teams, peak **2,000 requests/second**
- Average request: 1,500 input tokens + 500 output tokens
- Average response time: **8 seconds** (LLMs are slow, and streaming keeps connections open)

Two numbers follow from that:

```
Concurrent open connections ≈ arrival rate × duration (Little's Law)
                            = 2,000 req/s × 8 s = 16,000 concurrent streams

Tokens per day ≈ 2,000 req/s × 2,000 tokens × 86,400 s × ~0.3 (avg vs peak)
              ≈ 100 billion tokens/day
```

The first number is the important one. **An LLM gateway is limited by connections, not CPU.** Each instance spends most of its time waiting on providers, so you want an async runtime (Python `asyncio`, Go, Node, Rust) that can hold thousands of idle streams cheaply. You also autoscale on concurrent connections, not CPU.

The second number tells you the metering pipeline handles about 2,000 events/second at peak, roughly 50M events a day. That's a job for a streaming pipeline and a columnar store, not inserts into Postgres.

---

## 2. The architecture at a glance

```
                          ┌──────────────────────── CONTROL PLANE ─────────────────────────┐
                          │ Admin API/UI · tenants, keys, quotas, routing policies, prices │
                          │ Postgres (source of truth)  ──publish config──►                │
                          └─────────────────────────────────────┬──────────────────────────┘
                                                                │ (cached in memory)
 callers                                                        ▼
 (services, ───► INGRESS ─────► GATEWAY CORE (data plane, stateless) ─────► EGRESS ─────► providers
  agents,        • TLS/WAF       1. authenticate        6. route + fallback   • NAT /     • Anthropic
  batch jobs)    • L7 LB         2. validate/normalize  7. circuit breakers     PrivateLink • OpenAI
                 • size limits   3. guardrails (in)     8. call + stream      • allow-list • Bedrock
                                 4. rate limit/budget   9. guardrails (out)   • provider   • Vertex
                                 5. cache lookup       10. settle + emit        keys       • self-hosted
                                      │        │              │
                                      ▼        ▼              ▼
                                   Redis    Queue         Event stream ──► S3 lake ──► warehouse / OLAP
                                 (limits,  (batch jobs)   (usage, traces)              (cost, dashboards,
                                  cache,     │                                          evals)
                                  breakers)  ▼
                                          Job workers ──► Postgres (job state) ──► S3 (results)
```

There are three planes:

- **Data plane:** the hot path every request takes. It must be fast, stateless and horizontally scalable.
- **Control plane:** where configuration is managed (tenants, keys, quotas, routes, prices). It can be slower, and the data plane must **keep working if it goes down**, using the last config it saw.
- **Analytics plane:** the asynchronous pipeline that turns events into cost reports, dashboards and eval data.

That split is the most important idea in the design. Everything on the hot path is either in memory, in Redis, or on its way to the provider. Everything else happens asynchronously.

The rest of this post follows a request through the system.

---

## 3. Ingress: getting in safely

**Ingress** means traffic coming *into* your system. The ingress layer runs before your own code.

### What it does

- **TLS termination.** HTTPS ends at the load balancer or edge proxy (encryption in transit). Inside the network, use TLS again or mTLS between services.
- **Layer 7 load balancing.** Something like an AWS ALB, Envoy or NGINX spreads requests across gateway instances. Because instances are **stateless**, any instance can handle any request.
- **WAF and size limits.** Reject huge bodies early (a 50 MB prompt is a mistake or an attack), and block obviously malicious traffic.
- **Coarse per-IP or per-key limits.** This is a cheap first line of defence. The token-aware limiting comes later, in the core.

### Streaming gotchas at ingress

LLM responses are streamed with **Server-Sent Events (SSE)** or WebSockets, and a response can take minutes. That breaks defaults that assume short requests:

- **Idle timeouts.** Load balancers often close a connection after 60 seconds with no traffic. Long "thinking" pauses can trip this. Raise the timeout, and have the gateway send periodic SSE keep-alive comments (`: ping`).
- **Buffering.** Some proxies buffer the response until it's complete, which destroys time-to-first-token (TTFT). Turn proxy buffering off for streaming routes.
- **Graceful shutdown.** During a deploy, an instance has to stop taking new connections and **drain** existing streams before exiting. Otherwise every deploy cuts off thousands of answers halfway through.

---

## 4. Authentication and identity

The gateway has to know **who** is calling (authentication) and **what they're allowed to do** (authorization), because everything else depends on the tenant: quotas, budgets, allowed models, data policies and billing.

### Gateway API keys

The simplest option is for each team to get gateway keys (`gw_live_8f3k...`). Teams **never see the real provider keys**. Those stay inside the gateway (see Egress).

How to store them:

- Show the key **once** when it's created, and store only a **hash** of it.
- API keys are long random strings (high entropy), so a fast hash like **SHA-256 or HMAC-SHA-256** is fine. **Passwords are different.** People pick weak passwords, so passwords need a *slow*, salted hash (bcrypt, Argon2) to make guessing expensive. A random 256-bit key can't be guessed, so speed doesn't matter.
- Store a short **prefix** (`gw_live_8f3k`) in clear text so humans can tell keys apart in logs and the UI.
- Support **multiple active keys** per project so keys can be rotated without downtime.

On each request, hash the presented key, look it up, and cache the result (`key_hash → tenant, project, scopes, policies`) in memory for a few seconds. Keep a short TTL so a revoked key stops working quickly.

### OAuth / JWT for service identity

In larger organizations, services already have identities from an identity provider. The gateway validates a **JWT access token** (checks the signature against the provider's public keys, plus expiry, audience and scopes), and reads the client ID and tenant from its claims. This avoids long-lived secrets completely.

### Calls made on behalf of someone else

What happens when one service calls the gateway *for* a customer? A document-processing service working on Customer A's job is one example, and an agent acting for a user is another. You want to bill and authorize the **customer**, while still knowing which **service** made the call. OAuth **token exchange** (RFC 8693) solves exactly this, with an `act` (actor) claim. I wrote a [whole post on it](/blog/oauth-token-exchange-rfc-8693/).

### Authorization: policies per tenant

After authentication, look up the tenant's **policy**:

```yaml
tenant: payments-team
allowed_models: [claude-haiku, claude-sonnet, gpt-mini]
data_classification: confidential     # → only providers approved for confidential data
allowed_regions: [eu-west-1]          # data residency
max_tokens_per_request: 8000
fallback: same-model-only             # see Reliability
log_prompts: false
```

Checking every request against a policy like this is what stops **broken access control**, the top item on the OWASP Top 10. "Is this team allowed to use this model with this kind of data?" is an authorization question, and the gateway is the one place where it can be enforced consistently.

---

## 5. The API: one interface for many models

### Pick one schema

Providers have different request formats. The gateway exposes **one** of them, and translates to the rest with adapters:

```
caller ──(unified schema)──► gateway ──adapter──► Anthropic Messages API
                                     ──adapter──► OpenAI Chat Completions / Responses
                                     ──adapter──► Bedrock Converse API
```

Many gateways expose an **OpenAI-compatible** API because so many SDKs and tools already speak it. The trade-off is that provider-specific features (prompt-caching controls, extended thinking, special tool types) either need extension fields or a **passthrough mode** where the caller sends the provider's native format and the gateway only adds auth, limits and metering. Offer both. Normalizing everything perfectly is a losing battle.

Things that need translating:

- message roles and system prompts
- **tool / function calling** schemas and tool-result messages
- streaming event formats
- stop reasons, usage fields (input, output and cached tokens), error codes

### Model aliases

Don't make callers hard-code `claude-sonnet-4-5-20250929`. Give them **aliases**:

```
fast   → claude-haiku   (fallback: gpt-mini)
smart  → claude-sonnet  (fallback: same model on Bedrock)
best   → claude-opus
```

You can then upgrade the model behind an alias centrally, after running evals (section 15), without 200 teams changing code.

### Idempotency keys

Networks fail. If a caller retries a request whose response it never got, you don't want to bill twice or run a side effect twice. Callers send an `Idempotency-Key` header. The gateway stores `key → status/result` in Redis with a TTL. A duplicate key returns the stored result, or `409 in progress`. This matters most for the **async jobs API**.

---

## 6. Multi-tenancy and rate limiting

This is the section that separates a toy gateway from a product.

### The noisy-neighbour problem

All tenants share the same **upstream capacity**: providers enforce rate limits per account, measured in requests per minute (RPM) **and tokens per minute (TPM)**. If Team X launches a batch job at 2 a.m. that sends 50,000 huge prompts, it uses up the shared TPM. Then Team Y's customer-facing chatbot starts getting `429`s.

The gateway must **isolate tenants** from each other.

### Limit tokens, not just requests

Requests are not equal:

```
chatbot question:        ~200 tokens
"summarize this PDF":  ~100,000 tokens   ← 500× more capacity
```

A requests-per-second limit lets a tenant stay under the limit while consuming 500 times the capacity. So the gateway enforces several limits per tenant:

| Limit | Protects against |
|---|---|
| Requests per minute | Request floods, abuse |
| **Tokens per minute** | Capacity hogging (the important one) |
| Concurrent requests | Too many long streams open at once |
| Budget ($/day, $/month) | Surprise bills |

### The token bucket algorithm

The standard algorithm is a **token bucket**, which fits LLMs well because the "tokens" in the bucket can literally be LLM tokens.

```
capacity:     the most a tenant can burst (e.g. 1,000,000 tokens)
refill rate:  steady rate (e.g. 1,000,000 tokens/min ≈ 16,667/s)

on request:   refill based on time since last check (up to capacity)
              if bucket ≥ cost: take cost out → allow
              else: reject with 429 + Retry-After
```

It allows **short bursts** (up to capacity) while enforcing an **average rate** (the refill). For comparison:

- **Fixed window** ("max N per minute, counter resets on the minute") is simple, but allows 2N at the boundary: N at 0:59 and N at 1:00.
- **Sliding window log** is exact, but stores every request's timestamp. That's too much memory at scale.
- **Sliding window counter** blends the current and previous window counts. It's a good approximation and cheap.
- **Token bucket** is cheap (two numbers per tenant), allows bursts and is easy to reason about. **Leaky bucket** is similar but smooths output to a constant rate.

### The catch: you don't know the cost up front

When a request arrives, you know the prompt size (you can count it with a tokenizer, or estimate it at about 4 characters per token). You **don't** know how long the answer will be. The solution is **reserve, then settle**, like a hotel putting a hold on your card:

```
1. On arrival:  reserve = input_tokens + max_tokens       (worst case)
                take the reserve out of the bucket → not enough? 429
2. On finish:   actual = input_tokens + actual_output_tokens
                refund (reserve − actual) back to the bucket
```

Tenants can't exceed their limit, and they aren't overcharged. It also nudges teams to set a sensible `max_tokens`, because a smaller cap means a smaller reservation. If a stream is cut off, settle with however many tokens were actually generated.

### Why Redis, and how to do it atomically

The gateway runs on many stateless instances, so the bucket state must be **shared**. Hence **Redis**: an in-memory key-value store with sub-millisecond reads and writes.

A naive "read the bucket, compute, write it back" from application code has a **race condition**. Two instances read 1,000 tokens at the same moment, both allow a 1,000-token request, and the tenant gets 2,000. The fix is to run the whole check **atomically inside Redis** with a Lua script. Redis runs each script without interleaving other commands:

```lua
-- KEYS[1] = "bucket:{tenant}:tpm"
-- ARGV[1] = capacity, ARGV[2] = refill tokens/sec, ARGV[3] = cost
local cap  = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t   = redis.call('TIME')                       -- Redis's clock: no skew between gateway hosts
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local b      = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts     = tonumber(b[2]) or now

tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)   -- refill

local allowed = 0
if tokens >= cost then
  tokens  = tokens - cost
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) * 2)   -- idle buckets expire
return {allowed, tostring(tokens)}
```

The refund on settle is another small script that adds tokens back, capped at capacity.

One edge case: a request whose reservation is **larger than the bucket's capacity** can never succeed, however long the caller waits. Reject it right away with a `400`/`413` ("request exceeds your per-request limit") instead of a `429`, or the client will retry forever.

Details that matter in production:

- **Use Redis Cluster** to scale, with keys sharded by tenant. The `{tenant}` braces are a *hash tag*: they keep all of one tenant's keys on the same shard, so a script can touch several of them atomically.
- **Hot tenants.** One huge tenant can make one shard hot. Split its bucket into N sub-buckets, or have each gateway instance take a **local lease** of tokens (for example, grab 50,000 at a time) and spend from memory. That's fewer Redis calls in exchange for slightly less precise limits.
- **What if Redis is down?** You have to choose: **fail open** (allow requests and risk overspending) or **fail closed** (reject everything and cause an outage). Most gateways fail open with a **local, per-instance fallback limit** (the global limit divided by the instance count) and an alert. Decide this in advance and write it down.
- **Return useful headers:** `Retry-After`, `X-RateLimit-Remaining-Tokens` and `X-RateLimit-Reset`, so well-behaved clients can back off.

### Fairness and priorities

Hard limits alone waste capacity: if Team Y is idle at 2 a.m., why can't Team X use the headroom? Better options:

- **Guaranteed + burstable quotas.** Each tenant has a guaranteed share and can borrow unused capacity, and borrowed capacity is the first to be taken back.
- **Priority classes.** Interactive traffic gets reserved upstream capacity, and batch traffic gets what's left (next section).
- **Weighted fair queuing** when demand exceeds supply, so each tenant gets capacity in proportion to its weight and no single tenant takes it all.

### Budgets

A budget is a rate limit measured in **dollars over a long window**. Keep a running spend counter per tenant per month in Redis, update it on settle, and act at thresholds: alert at 80%, require approval or downgrade to a cheaper model at 100%. The *authoritative* spend comes from the metering pipeline (section 13). Redis gives a fast estimate that's good enough to enforce limits with.

---

## 7. Routing: which model, which provider

### Who decides the model?

- **The caller decides** (`model: smart`). This is predictable and easy to debug. Most production traffic should work this way.
- **The gateway decides** (`model: auto`). A router picks the model based on the request. It can save a lot of money, but behaviour becomes less predictable.

Offer both. Use automatic routing only where callers opt in and **evals show quality holds**.

### Routing strategies

1. **Rules.** Short prompt, no tools, classification task → small model.
2. **Classifier router.** A small, cheap model (or a fine-tuned classifier) predicts difficulty and picks a tier. Measure how often the router is wrong, because a bad route costs quality.
3. **Cascade.** Try the cheap model first. If a check fails (validation error, low confidence, failed JSON schema), escalate to the bigger model. You pay twice on escalations, so this only works if most requests succeed on the first try.
4. **Load and price aware.** For the *same* model, choose the provider or region with the most quota headroom, the lowest latency or the lowest price.

### Deployments, not just models

A "model" is usually available in several places. For example, the same Claude model may be available from Anthropic's API, Amazon Bedrock (in several regions, or through cross-region inference profiles) and Google Vertex AI. The router works on **deployments**:

```
alias "smart" → [ anthropic/claude-sonnet        weight 60
                  bedrock/us-east-1/claude-sonnet  weight 30
                  bedrock/us-west-2/claude-sonnet  weight 10 ]
```

Spreading traffic across deployments increases your total quota and gives you ready-made failover targets.

---

## 8. Sync, async and job tracking

Not all traffic needs an answer in two seconds. Mixing the two kinds of traffic is the most common way gateways fail at scale.

### Priority lanes

```
                     ┌─► interactive lane ─► provider now   (chatbots, agents, user-facing)
request ─► gateway ──┤
                     └─► batch lane ─► queue ─► workers drain with spare capacity
                                                └─► or provider Batch API (≈50% cheaper)
```

- **Interactive:** reserved capacity, low latency, synchronous, streamed.
- **Batch:** accepted right away, processed asynchronously when capacity is free, and the result collected later. Anthropic, OpenAI and Bedrock all offer **batch APIs** that cost roughly half as much in exchange for results within hours. For an overnight job, that's an easy saving.

**Separate traffic by how urgent it is, not just by how much there is.**

### The async jobs API

```
POST /v1/jobs                    → 202 Accepted { job_id, status: "queued" }
GET  /v1/jobs/{job_id}           → { status, progress, result_url, usage, error }
POST /v1/jobs/{job_id}/cancel
     webhook (optional)          → POST to caller's URL when done (signed with HMAC)
```

### Job state machine

Model each job as an explicit **state machine** stored in **Postgres**, the source of truth:

```
QUEUED ──► RUNNING ──► SUCCEEDED
   │          │
   │          ├──► RETRYING ──► RUNNING (attempt + 1)
   │          │
   │          └──► FAILED ──► (after max attempts) DEAD-LETTERED
   └──► CANCELLED
```

```sql
CREATE TABLE jobs (
  job_id          UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  idempotency_key TEXT,
  status          TEXT NOT NULL,          -- QUEUED / RUNNING / ...
  attempt         INT  NOT NULL DEFAULT 0,
  request_ref     TEXT NOT NULL,          -- S3 key of the request payload
  result_ref      TEXT,                   -- S3 key of the result
  provider_batch_id TEXT,                 -- if submitted to a provider Batch API
  error           JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_jobs_tenant_status ON jobs (tenant_id, status, created_at);
```

Why it looks like this:

- **Payloads go in S3, not the database.** Prompts and results can be megabytes. Databases are for small, structured, queryable data, and object storage is for blobs.
- **The unique constraint on `(tenant_id, idempotency_key)`** makes retried submissions safe at the database level.
- **The composite index** serves the most common query: "show my team's running jobs, newest first". Index the columns you filter and sort on, and nothing else, because every extra index slows down writes.

### Queue and workers

- Put job IDs on a queue (**SQS**, or Kafka for higher volume). Workers pull, mark `RUNNING`, call the provider (using the same rate limiter, at batch priority), write the result to S3, then mark `SUCCEEDED`.
- **At-least-once delivery.** Queues can deliver the same message twice, so workers must be **idempotent**: check the job's status before doing the work.
- **Visibility timeout / heartbeats.** If a worker dies mid-job, the message reappears and another worker picks it up.
- **Retries with backoff**, then a **dead-letter queue (DLQ)** after N attempts, with an alert. Never retry forever.
- **Don't lose the enqueue.** If you write the job row and then crash before enqueuing, the job is stuck. Use the **transactional outbox pattern**: write the job row and an outbox row in one transaction, and have a relay publish outbox rows to the queue.

---

## 9. Reliability: when providers fail

Providers *will* have outages, slow periods and `429` storms. The gateway's job is to make that boring for callers.

### Timeouts

Use separate timeouts for each phase:

- **Connect timeout:** short (a few seconds).
- **Time to first token:** moderate. If nothing has arrived in 30 seconds, something is wrong.
- **Idle between tokens:** catches streams that stall.
- **Total:** generous, because long generations are legitimate.

A single "60-second timeout" either kills long legitimate answers or waits far too long on dead connections.

### Retries, done carefully

- Retry only **retryable** errors: `429`, `5xx`, connection resets. Never retry a `400` (bad request) or a content-policy refusal.
- Use **exponential backoff with jitter**: wait 1s, 2s, 4s… each with a random offset, so thousands of clients don't retry at the same moment.
- Respect the provider's `Retry-After`.
- Keep a **retry budget**, for example "retries may add at most 10% extra traffic". Without one, retries during an outage multiply load and make the outage worse (a *retry storm*).
- **Streaming caveat:** once you've sent tokens to the caller, you can't transparently retry, because they'd see the answer restart. Retry or fail over only **before the first token**. After that, return a clear error.

### Circuit breakers

If a provider is failing, waiting for every request to time out makes everything slow. A **circuit breaker** stops calling a failing dependency for a while:

```
 CLOSED ──(error rate > 50% over 30 s, min 20 requests)──► OPEN
   ▲                                                         │
   │                                          fail fast for 30 s → go to fallback
   │                                                         ▼
   └──────(probe requests succeed)───────────────────── HALF-OPEN
                                                  (let a few probe requests through)
```

- **CLOSED:** normal.
- **OPEN:** don't call the provider at all. Fail over right away, with no timeout wait.
- **HALF-OPEN:** let a **small trickle** of probe requests through. If they succeed, close the breaker. This step prevents the **thundering herd**, where a provider that has just recovered gets hit by all the pent-up traffic at once and goes down again.

Keep **one breaker per deployment** (provider + region + model), not one per provider, because often a single model or region is affected. Each instance can track its own error rates and share the breaker state through Redis, so the whole fleet reacts together.

### The failover ladder

Switching providers is technically easy. Switching **silently** is risky:

1. **Behaviour changes.** Prompts tuned for one model give different results on another, and output parsing can break.
2. **Compliance.** A team's data may be approved only for a specific provider or region. Failing over to another provider can break that agreement.
3. **Feature gaps.** Context window size, prompt caching, tool-calling formats and structured output support all differ.
4. **Capacity.** If 200 teams fail over at once, the backup's quota runs out in minutes.

So fail over from safest to riskiest:

```
① same model, another region           (behaviour identical)
② same model, another platform         (e.g. vendor API → same model on a cloud provider)
③ different model, only for tenants whose policy allows it
④ otherwise fail fast with a clear, retryable error
```

Report what happened in response headers (`X-Gateway-Served-By: bedrock/us-west-2/claude-sonnet`) and in the usage event. Silent failover makes debugging miserable.

### The gateway's own dependencies

The gateway must not be *less* reliable than the providers behind it:

- **Config store (control plane) down:** keep serving from the cached config.
- **Redis down:** fail open with local limits (section 6).
- **Metering pipeline down:** buffer events locally or in a durable queue. Never block requests on metering.

**Rule:** nothing except the provider call itself may block the hot path.

---

## 10. Caching

Caching LLM responses saves money and latency, but it comes with sharp edges.

### Exact-match cache

- Key = a hash of the **normalized** request (model, messages, tools, temperature, other parameters), scoped **per tenant**. Never share cache entries across tenants, because that leaks data.
- Store the response in **Redis** with a TTL.
- Only cache **deterministic** requests (`temperature = 0`), and let callers opt out (`Cache-Control: no-store`).
- Works well for repeated classification, embeddings and the same FAQ questions.

### Semantic cache

Embed the prompt, search a **vector index** for similar past prompts, and return the cached answer when similarity is above a threshold.

- **Upside:** many more cache hits.
- **Risk:** "Cancel my order" and "Don't cancel my order" can have very similar embeddings. A wrong cache hit means a confidently wrong answer.
- Use it only for narrow, low-risk use cases (FAQ bots), with a strict threshold, and monitor the quality of hits.

### Provider-side prompt caching

Most major providers can cache a **repeated prompt prefix** (a long system prompt, a big document, tool definitions) and charge much less for cached input tokens. The gateway's job is to **preserve** it:

- Keep prompt prefixes byte-for-byte stable. Don't inject timestamps or request IDs at the start of system prompts.
- Route requests that share a prefix to the same deployment when you can, since caches are per deployment.
- **Meter cached tokens separately**, because they're priced differently.

**Cache vs source of truth:** a cache is a copy for speed, and it can always be thrown away. Never let a cache become the only place something is stored.

---

## 11. Egress: getting out safely

**Egress** means traffic leaving your network. Every call to a provider is egress, carrying your company's prompts, documents and customer data.

### What the egress layer does

- **One controlled exit.** Provider calls leave through a known path: NAT gateways with fixed IPs, or an egress proxy. Teams can't bypass the gateway and call providers directly, because the network blocks it. If you skip this, "all LLM traffic goes through the gateway" is only a hope.
- **Destination allow-list.** Only approved provider endpoints are reachable.
- **Private connectivity where possible.** For cloud-hosted models (for example, Bedrock inside your AWS account), use **VPC endpoints / PrivateLink** so traffic never touches the public internet. You can then combine IAM policies with conditions like "only from this VPC endpoint".
- **Provider credentials live here only.** Real provider API keys sit in a **secrets manager** (AWS Secrets Manager, Vault) and are encrypted at rest (KMS). They're loaded into memory at startup and rotated regularly. Callers never see them. For cloud providers, use **IAM roles** instead of static keys.
- **Data residency.** Requests from an EU tenant go only to EU deployments. The routing policy enforces this, and the egress layer double-checks it.
- **Outbound DLP.** Data loss prevention: a last check for secrets (API keys, credentials) and PII in prompts before they leave the network (see Guardrails).

Ingress protects *you* from callers. Egress protects *your data* on the way out. A complete gateway needs both.

---

## 12. Guardrails and LLM security

The gateway is the natural place to enforce safety policies, because every request passes through it.

### Input guardrails

- **PII detection and redaction.** Detect emails, phone numbers, card numbers and national IDs, then mask them (`<EMAIL_1>`), block the request, or tokenize them and restore the values in the response. Use different policies per tenant.
- **Secret scanning.** Catch API keys and private keys pasted into prompts.
- **Prompt-injection signals.** Flag inputs that look like instructions hidden in data ("ignore previous instructions…"). Detection is never perfect, so treat it as one layer of defence, not a guarantee.
- **Topic and content policies** for each use case.

### Output guardrails

- Content filters (toxicity, policy violations).
- **Structured output validation.** If the caller asked for JSON matching a schema, validate it, and retry or repair before returning.
- PII leakage checks.

**With streaming, output guardrails get harder.** You can't check the full answer before sending it. Options: check chunks as they stream (fast, but can only stop partway through), buffer a little (adds latency), or check asynchronously after the fact and flag (no added latency, but nothing is blocked). Choose per tenant and risk level.

### Managed options

Cloud providers offer managed guardrails, such as **Amazon Bedrock Guardrails** (content filters, denied topics, PII filters, grounding checks), which can be applied to Bedrock calls and also run on their own against any text. A gateway can call them as one step in its pipeline.

### Defence in depth for agents

Prompt injection can't be fully solved at the gateway. A malicious instruction inside a retrieved web page looks like ordinary text. So you **limit the blast radius**:

- give agents least-privilege tools
- require human approval for risky actions
- validate structured outputs
- never let model output go directly into SQL, shell commands or other tool calls without checks

The gateway contributes logging, policy and per-run limits (section 14).

### Audit logs

Keep an **immutable audit log** of who called what model, with which data classification, and which policy decisions were made. This is separate from debug logs. It's append-only, retained according to compliance rules, and access to it is itself logged.

---

## 13. Metering, cost and chargeback

"How much did each team spend last month?" is usually the question that gets an LLM gateway funded, so the answer has to be exact.

### The usage event

When each request **finishes** (the same moment you settle the token bucket), emit one event:

```jsonc
{
  "event_id": "evt_01JD...",             // unique: used to deduplicate
  "request_id": "req_7f3c...",           // ties into traces and logs
  "timestamp": "2026-11-23T11:02:14.512Z",
  "tenant_id": "payments-team",
  "project_id": "fraud-explainer",
  "api_key_prefix": "gw_live_8f3k",
  "on_behalf_of": "customer-123",        // from token exchange, if any
  "agent_run_id": "run_9a1...",          // if part of an agent run
  "alias": "smart",
  "provider": "bedrock",
  "region": "us-east-1",
  "model": "claude-sonnet",
  "lane": "interactive",
  "input_tokens": 1520,
  "cached_input_tokens": 1200,
  "output_tokens": 480,
  "cost_usd": 0.00921,
  "price_version": "2026-11-01",
  "latency_ms": 6230,
  "ttft_ms": 410,
  "status": "ok",                        // ok / error / rate_limited / blocked
  "fallback_used": false,
  "cache": "miss"
}
```

Notes:

- **Prices change.** Keep a versioned **price table** (model, provider, token type, price, valid-from) in Postgres, and record `price_version` on each event so old costs can be reproduced exactly.
- **Use the provider's reported token counts** as the truth, not your own estimates.
- **Don't put prompt text in usage events.** It may contain PII. If prompts are stored at all (for debugging or evals), they go to a separate, access-controlled store with its own retention policy, and only for tenants that allow it.

### The pipeline

```
gateway ──async──► Kinesis / Kafka ──► stream processor ──► S3 data lake (Parquet / Iceberg)
                       │                    │                          │
                       │                    └─► real-time aggregates ──┴─► warehouse / OLAP
                       │                        (spend per tenant/min)      (Athena, Snowflake,
                       └─► durable buffer if downstream is down              BigQuery, ClickHouse)
```

- **Async, always.** The gateway sends the event to a stream and moves on, so metering never adds latency or causes outages.
- **No losses, no double counting.** Streams deliver **at least once**, so duplicates happen. Deduplicate on `event_id` downstream. This gives you effectively-once results, which is good enough to bill on.
- **Why not write to Postgres?** At up to 2,000 events/second and tens of millions of rows a day (billions within a few months), you need columnar storage that's cheap to append to and fast to aggregate (`SUM(cost) GROUP BY tenant, day`). That's what **OLAP** stores and data lakes are for. Postgres is for transactional data: tenants, keys, jobs.
- **Partition the lake by date** (`dt=2026-11-23/`), so a monthly report scans one month, not all history.

### Turning data into control

- **Dashboards:** spend by team, model, use case and day, plus cost per 1,000 requests and cache hit rate.
- **Budget alerts** at 50/80/100%.
- **Chargeback:** monthly invoices per cost centre from the warehouse.
- **Optimization reports:** "Team X sends 80% of requests to the largest model, but evals show the mid-size model scores the same on their task, so they could save $40k a month." This is where the gateway pays for itself.

---

## 14. Observability, and tracing agents

### The basics: logs, metrics, traces

- **Logs:** structured JSON, one line per event, always with `request_id`, `tenant_id` and `model`. Structured logs can be queried, while free text can only be searched with grep.
- **Metrics:** numbers over time, for dashboards and alerts.
- **Traces:** the path of one request across services, with timings for each step.

### Golden signals for an LLM gateway

The four classic golden signals (latency, traffic, errors, saturation) need LLM-specific versions:

| Signal | LLM gateway version |
|---|---|
| **Latency** | Gateway overhead (p50/p99), **TTFT**, tokens/second while streaming, total duration |
| **Traffic** | Requests/s and **tokens/s**, by tenant, model and lane |
| **Errors** | Error rate by **provider/deployment**, 429 rate (upstream vs your own limits), guardrail blocks, fallback rate |
| **Saturation** | **Provider quota used** (TPM headroom per deployment), concurrent streams per instance, Redis latency, queue depth and age |

Break everything down by deployment. "Errors are up" isn't actionable. "Bedrock us-east-1 Sonnet is returning 5xx, and the breaker opened at 11:02" is.

### SLOs and error budgets

Define SLOs for what callers care about, for example "99.9% of interactive requests get a first token within 2 seconds, excluding provider-side outages" or "gateway overhead p99 < 50 ms". The **error budget** (here 0.1% of requests) tells you when to stop shipping features and work on reliability instead. Decide whether provider outages count against your SLO. Usually you track them separately, but your failover strategy should reduce what callers see.

### OpenTelemetry for LLM calls

Use **OpenTelemetry** (OTel) for traces and metrics. It's vendor neutral, so you can send data to Datadog, Grafana, Honeycomb or X-Ray. OTel's **GenAI semantic conventions** define standard attribute names for LLM spans (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and so on), so tools understand your data without custom mapping.

Propagate the **W3C `traceparent` header**. If the caller sends one, the gateway's span becomes a child of the caller's trace, so a single trace shows *user click → backend → gateway → provider*.

### Agent invocation tracking

Agents make this harder. One user request ("research these 5 vendors and draft a comparison") might cause **40 LLM calls and 25 tool calls** over several minutes, across several agents. Looked at one request at a time, that's 65 unrelated-looking entries. You need the **tree**:

```
session  sess_42 (user conversation)
└── agent run  run_9a1   agent=vendor-researcher   status=ok   cost=$0.84   duration=3m12s
    ├── llm call   claude-sonnet   plan               1,900 in / 350 out
    ├── tool call  web_search("vendor A pricing")     820 ms
    ├── llm call   claude-haiku    summarize result     ...
    ├── sub-agent run  run_9a2   agent=writer
    │   ├── llm call   claude-sonnet   draft
    │   └── llm call   claude-sonnet   revise (critic loop, iteration 2)
    └── llm call   claude-sonnet   final answer
```

To build this tree, the gateway needs **context on every call**. Ask agent frameworks to send headers (and accept the same fields in trace context or request metadata):

```
X-Agent-Id:        vendor-researcher
X-Agent-Run-Id:    run_9a1
X-Parent-Run-Id:   (for sub-agents)
X-Session-Id:      sess_42
X-Agent-Step:      7
traceparent:       00-<trace-id>-<span-id>-01
```

With that context you get:

- **Cost per agent run.** "This agent costs $0.84 per task" is the number product teams actually need. Cost per request isn't.
- **Per-run budgets and loop protection.** An agent stuck in a loop can make hundreds of calls. The gateway can enforce `max_llm_calls_per_run`, `max_tokens_per_run` and `max_cost_per_run`, and stop a runaway run even if the framework's own `max_turns` is misconfigured. This complements the framework's own limits, so there are two independent stops.
- **Step-level debugging.** You can see which step in a failed run went wrong.

#### Managed agent platforms

If teams use managed agent runtimes, such as **Amazon Bedrock Agents** or **Bedrock AgentCore**, some LLM calls happen *inside* the platform, not through your gateway. You then have two options:

1. **Track at the invocation level.** The gateway (or a thin wrapper) fronts the *agent invocation API* itself, such as Bedrock's `InvokeAgent`, which takes a `sessionId` and can return a step-by-step **trace** of the agent's reasoning, tool (action group) calls and knowledge-base lookups when tracing is enabled. Record each invocation as a run, parse the trace into steps, and attribute usage to the tenant.
2. **Pull the platform's telemetry.** Platforms like AgentCore emit observability data (OpenTelemetry-compatible traces and metrics, often to CloudWatch). Ingest it into the same pipeline and join it on session/run IDs.

The goal is one view of an agent's behaviour, whether it runs on your own framework (ADK, LangGraph, a custom loop) or a managed runtime.

#### Tool calls and MCP

Agents increasingly call tools through **MCP (Model Context Protocol)** servers. MCP gives every tool the same shape (`list_tools` returns names, descriptions and JSON schemas, and `call_tool` invokes them), so any agent can discover and use tools without custom glue code per API. A growing pattern is to put an **MCP gateway** in front of their MCP servers, using the same ideas as the LLM gateway: authentication, per-tenant authorization for each tool, rate limits, audit logs and traces. If your LLM gateway and MCP gateway share trace IDs, the agent tree above shows both the model calls and the tool calls.

---

## 15. Evals: measuring quality

Without evals, every routing rule, model upgrade and prompt change is a guess. A gateway is well placed to run them, because it already sees the traffic and controls the routing.

### Offline evals

- **Golden datasets.** Curated inputs with expected outputs or grading criteria for each use case: 50 to 500 examples, version-controlled.
- **Graders:**
  - **Code-based:** exact match, JSON schema valid, contains the required fields, SQL runs. They're cheap and reliable, so use them wherever you can.
  - **LLM-as-judge:** a strong model grades against a rubric ("Is the summary faithful to the source? 1–5"). It scales well, but judges have biases (they prefer longer answers, prefer their own style, and are influenced by order). Check judges against human labels on a sample.
  - **Human review:** the most expensive and the most trustworthy. Use it to build and audit the other two.
- **When to run them:** on every model alias change, routing rule change or prompt template change, as a CI gate. "The `smart` alias moves to the new model only if eval scores are within 1% and cost drops."

### Online evals

- **Sample production traffic** (for example 1%, only for tenants whose policy allows it), and score it asynchronously with judges and code checks.
- **Implicit feedback:** thumbs up or down, whether the user regenerated, edited the output, or abandoned the session.
- **Shadow traffic:** send a copy of real requests to a candidate model, discard its responses (the caller only sees the current model), then compare quality, latency and cost offline. You can test a new model with no risk to users.
- **Canary / A/B:** route 5% of an alias's traffic to the candidate, compare metrics, then ramp up or roll back.

### Where eval data lives

- Datasets and results in the data lake / warehouse, linked to `request_id` and `agent_run_id`.
- Scores as metrics (`eval_score{use_case, model}`) next to cost and latency, so a single dashboard answers **"what's the cheapest model that's good enough for this task?"**

### Evals for agents

Score the **trajectory**, not just the final answer: did it pick the right tools, how many steps did it take, did it loop, did it stay within budget? The agent run tree from section 14 is your eval input.

---

## 16. The data stores, and why each one

A gateway uses several stores, each chosen for a specific access pattern:

| Store | Holds | Why this store |
|---|---|---|
| **Postgres** (or another relational DB) | Tenants, projects, key hashes, policies, routing config, price table, job state, audit metadata | Small, structured data that needs **transactions, constraints and joins**, and has to be correct. Source of truth for the control plane. |
| **Redis** | Rate-limit buckets, budget counters, circuit breaker state, idempotency keys, exact-match cache, short-lived config cache | **Sub-millisecond, shared state** for the hot path. Atomic operations (Lua). Data is either disposable or can be rebuilt. |
| **In-process memory** | Hot config snapshot, key lookups (short TTL), local rate-limit leases | No network hop at all, and keeps the gateway running when the control plane is down. |
| **Queue** (SQS / Kafka) | Batch job IDs, outbox relay | Decouples accepting work from doing it. Retries, DLQs, smooths out load. |
| **Event stream** (Kinesis / Kafka) | Usage events, traces, audit events | High-throughput, durable, replayable feed for the analytics plane. |
| **Object storage** (S3) | Job payloads and results, data lake (Parquet / Iceberg), optional prompt logs | Cheap, durable, effectively unlimited storage for large blobs and history. Lifecycle rules handle retention. |
| **OLAP / warehouse** (ClickHouse, Snowflake, BigQuery, Athena) | Cost reports, usage analytics, eval results | Columnar storage built for scanning and aggregating billions of rows. |
| **Vector index** (pgvector, OpenSearch, a vector DB) | Semantic cache embeddings | Nearest-neighbour search on embeddings. Only needed if you build a semantic cache. |
| **Secrets manager + KMS** | Provider keys, signing keys | Encrypted at rest, access-controlled, auditable, supports rotation. |

Two principles to remember:

1. **Know your source of truth.** Postgres holds config and jobs, and the data lake holds usage history. Everything in Redis or memory is a **copy** that can be lost and rebuilt.
2. **Keep stores in sync on purpose.** When config changes in Postgres, publish an event (or let instances poll a version number) so caches refresh. When you need a database write *and* a message, use the outbox pattern rather than hoping both writes succeed.

---

## 17. Control plane vs data plane

- The **control plane** (admin API and UI, policy editing, key management) writes to Postgres and publishes **versioned config snapshots** (for example `config v1842`).
- **Data plane** instances load a snapshot into memory at startup and pick up new versions through a push (pub/sub) or a cheap poll ("is there a newer version?").
- If the control plane is down, the data plane **keeps serving** with the last snapshot it has. Tenants can't change settings for a while, but traffic keeps flowing.
- **Roll out config changes like code changes:** validate, apply to a canary set of instances, watch error rates, then roll out to the fleet. A bad routing rule pushed to every instance at once can take down all LLM traffic in the company.

---

## 18. Deployment and scaling

- **Stateless instances** behind a load balancer, across at least 3 availability zones, with autoscaling on **concurrent connections** and event-loop lag, not CPU.
- **Async I/O everywhere** on the hot path. One blocking call (a synchronous DB query, a slow log write) stalls every stream on that event loop.
- **Connection pooling to providers.** Reuse HTTP/2 or keep-alive connections. TLS handshakes per request add latency and cost CPU.
- **Graceful draining** on deploy (section 3), and **rolling or blue/green deploys** with automatic rollback on error-rate alarms.
- **Multi-region** if callers are global or you need regional data residency: run a gateway stack per region, keep tenant config replicated, and keep rate-limit state **regional** (with global limits split across regions) so you don't make cross-region calls on the hot path.
- **Load test with realistic traffic:** long streams, slow providers (use a mock provider that streams at realistic token rates), bursts, and failure injection (kill Redis, make a provider return 5xx) to verify that breakers and failover behave as designed.

---

## 19. Build vs buy

You don't always need to build all of this. Open-source and managed gateways already exist (LiteLLM, Envoy AI Gateway, Kong's AI gateway plugins, and gateway features from cloud and API-management vendors), and several cover unified APIs, keys, basic rate limits and cost tracking.

Building, or heavily extending, makes sense when you need:

- deep integration with your **identity system** (token exchange, on-behalf-of billing)
- strict **data residency and compliance** policies
- **agent-run-level** tracking and budgets
- custom routing driven by **your own evals**
- your own **chargeback** model

A common path: start with an open-source gateway, wrap it with your own auth, policy and metering layers, and replace parts as your needs outgrow it. In both cases, the design questions in this post are the ones you have to answer.

---

## 20. Trade-offs cheat sheet

| Decision | Option A | Option B | Usual choice |
|---|---|---|---|
| Rate-limit unit | Requests | **Tokens** | Both, with tokens as the main one |
| Unknown output size | Charge after | **Reserve max, refund after** | Reserve + settle |
| Limiter state | Per instance | **Shared (Redis)** | Redis, with local fallback |
| Redis down | Fail closed | **Fail open + local limits** | Fail open, alert |
| Batch traffic | Same lane, rate limited | **Separate async lane** | Separate lane, batch APIs |
| Failover | Any provider | **Same model first, policy-gated** | Ladder ①→④ |
| Metering writes | Sync to DB | **Async event stream** | Async, dedupe by event ID |
| Usage store | Postgres | **Data lake + OLAP** | Lake + OLAP |
| Model choice | Caller decides | Gateway decides | Caller by default, auto opt-in |
| Cache | Exact | Semantic | Exact by default, semantic for narrow use cases |
| Output guardrails | Block synchronously | Check async | Per tenant risk level |
| Prompt logging | Always | **Off by default** | Opt-in, separate restricted store |

---

## What I learned

The interesting part of an LLM gateway isn't the proxying. It's that **one shared, expensive, unreliable resource (model capacity) has to be divided fairly among many tenants, without adding latency, while every token is accounted for.** Most of the design follows from that:

- Isolation leads to **token-based limits in Redis** and **priority lanes**.
- Unreliable providers lead to **timeouts, retry budgets, circuit breakers and a careful failover ladder**.
- "Every token accounted for" leads to **async, deduplicated metering** in a data lake.
- Agents mean thinking in **runs, not requests**.
- Changing models safely depends on **evals**.

## Further reading

- My earlier post: [OAuth 2.0 Token Exchange (RFC 8693)](/blog/oauth-token-exchange-rfc-8693/), for billing the right customer when a service calls on their behalf
- Google SRE Book: chapters on *Monitoring Distributed Systems* (golden signals), *Handling Overload* and *Addressing Cascading Failures*
- Martin Kleppmann, *Designing Data-Intensive Applications*, for storage engines, replication, stream processing and exactly-once semantics
- Redis documentation: scripting with Lua, and Redis Cluster hash tags
- OpenTelemetry: Semantic Conventions for Generative AI
- Anthropic, OpenAI and AWS documentation on rate limits, batch processing and prompt caching
- Model Context Protocol specification
