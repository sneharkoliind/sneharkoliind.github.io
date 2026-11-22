---
title: "OAuth 2.0 Token Exchange (RFC 8693): billing the right customer when a service calls on their behalf"
description: "A practical walkthrough of token exchange, delegation and the act claim, using a real problem: attributing LLM usage to the right customer when a long-running backend service makes the calls."
pubDate: 2026-11-22
tags: ["security", "oauth", "system-design", "llm-platforms"]
draft: false
---

Here's a problem I ran into in practice, and a standard that solves it cleanly.

We had two internal services:

- A **document-processing service** that runs long jobs for customers: OCR, classification, extraction.
- An **LLM gateway**: one secure door to the model provider for the whole company. It handles authentication, policy, and **billing**. Every call is billed to the client ID in the caller's access token.

Customers can call the LLM gateway directly with their own credentials, and they're billed for it. But when the **document service** calls the gateway while working on a customer's job, who should pay?

The customer, obviously. Getting the platform to agree turned out to be the interesting part.

## Why the obvious options don't work

**Option 1: use the customer's own token.** The customer authenticates to the document service, and the service forwards their token to the gateway.

Two problems:

1. **Access tokens are short-lived**, often an hour or less. A large document job can run longer than that, so the token expires halfway through.
2. To get fresh tokens, the document service would need each **customer's client secret**. A service should never hold other parties' secrets.

**Option 2: one service identity, plus a header.** The document service gets its own client ID and calls the gateway with *its* token, adding a header saying which customer the call is for:

```http
POST /v1/chat/completions
Authorization: Bearer <token for client_id = doc-service>
X-Customer-Id: customer-a
```

This is easy, and fine for **reporting**. But the gateway can't safely **bill** from it. Look at what each line of that request really is:

```http
Authorization: Bearer <token: doc-service>   ← signed by the auth server, can't be faked
X-Customer-Id: customer-a                    ← plain text, the caller can type anything
```

So anyone holding the document service's token (a bug, a leaked credential, or just a misconfigured job) could send:

```http
X-Customer-Id: customer-b
```

and **customer B gets billed** for calls they never made. The gateway has no way to tell the difference.

The token is a different kind of thing. It's **signed** by the authorization server, and changing even one character breaks the signature check. So the only thing the gateway can truly verify is the token, and the token says "doc-service". Usage lands on the document service, and the customer ID is at best a hint for dashboards.

> **Rule of thumb:** only trust what's signed. Anything the caller can set freely is just a hint.

What we really need is a token that says, in a way the gateway can **cryptographically verify**:

> "This call is made by **doc-service**, acting **on behalf of** customer A."

That's exactly what OAuth 2.0 Token Exchange gives you.

## What RFC 8693 is

[RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) defines a way to send one or more tokens to an authorization server's **token endpoint** and get a **new token** back. The authorization server acts as a **Security Token Service (STS)**: it checks the inputs against policy and issues a token suited to the next hop.

It has two important inputs:

| Parameter | Meaning |
|---|---|
| `subject_token` | Represents **who the request is for** (here, customer A) |
| `actor_token` | Represents **who is actually making the call** (here, doc-service) |

And one key output: a token whose claims describe **both** identities.

### Impersonation vs delegation

The RFC separates two styles:

- **Impersonation:** the new token simply *is* customer A. The gateway can't tell a service was involved. It's simple, but you lose the audit trail and the service gets the customer's full power.
- **Delegation:** the new token says the subject is customer A **and** the actor is doc-service. Both identities are visible and verifiable.

For billing and auditing, **delegation** is what you want.

## The exchange, step by step

### 1. The request

The document service calls the token endpoint with the special grant type:

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <doc-service client credentials>

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<token representing customer A>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&actor_token=<doc-service's own access token>
&actor_token_type=urn:ietf:params:oauth:token-type:access_token
&audience=llm-gateway
&scope=llm.invoke
```

- `grant_type` tells the server this is a token exchange.
- `subject_token` and `subject_token_type` are **required**.
- `actor_token` is optional in the spec, but it's what turns impersonation into delegation.
- `audience` (or `resource`) says **where** the new token will be used, so it can't be replayed against other services.
- `scope` asks for only what's needed: least privilege.

### 2. The policy check

Before issuing anything, the authorization server asks: **is doc-service allowed to act for customer A?**

That permission has to be set up beforehand. The RFC describes a `may_act` claim for this. A subject's token can carry a list of who may act for it:

```json
{
  "sub": "customer-a",
  "may_act": { "sub": "doc-service" }
}
```

In practice, many identity providers keep this as a **delegation policy** in their own configuration instead ("doc-service may act for these customers, for these scopes"). Either way, the decision belongs to the **authorization server**, not the caller. That's the whole point.

### 3. The response

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "llm.invoke"
}
```

`issued_token_type` is required in the response. It tells the caller what kind of token it got back.

### 4. What's inside the new token

Decoded, the access token (a JWT) looks something like this:

```json
{
  "iss": "https://auth.example.com",
  "aud": "llm-gateway",
  "sub": "customer-a",
  "client_id": "doc-service",
  "scope": "llm.invoke",
  "act": { "sub": "doc-service" },
  "exp": 1795000000
}
```

The important part is the **`act` (actor) claim**. RFC 8693 defines it to mean: *"the party in `act` is acting on behalf of `sub`."*

- `sub` = **customer A**, the party being served, and the one to **bill**
- `act.sub` = **doc-service**, the party making the call, and the one to **audit**

`act` can even be **nested** when a chain of services is involved, so the full path of delegation stays visible. The outermost `act` is the current caller, and each nested one is an earlier hop:

```json
"act": { "sub": "doc-service", "act": { "sub": "ingest-worker" } }
```

## What the gateway does with it

On every request, the LLM gateway:

1. **Verifies the signature** using the authorization server's public keys (JWKS), so the claims can't be forged.
2. **Checks** `iss`, `aud`, `exp` and `scope`, so the token was meant for *this* gateway, is still valid, and allows this action.
3. **Bills `sub`** (customer A) and applies **customer A's** quotas and policies. For a customer calling directly, `sub` is simply their own client, so one billing rule covers both cases.
4. **Logs both identities**: "doc-service acting for customer A".

In Python, the verification step looks like this:

```python
import jwt  # PyJWT

jwks = jwt.PyJWKClient("https://auth.example.com/.well-known/jwks.json")

def authorize(token: str) -> tuple[str, str | None]:
    signing_key = jwks.get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience="llm-gateway",
        issuer="https://auth.example.com",
    )
    if "llm.invoke" not in claims.get("scope", "").split():
        raise PermissionError("missing scope llm.invoke")

    billed_party = claims["sub"]                       # who pays
    actor = claims.get("act", {}).get("sub")           # who called, if delegated
    return billed_party, actor
```

Compare that with the header approach: nothing in that function trusts a value the caller typed. Every fact comes from a token the authorization server signed.

## What about long-running jobs?

Token exchange doesn't make tokens live longer, and it shouldn't. Short-lived tokens limit the damage if one leaks. The difference is that the service can now get a **fresh delegated token whenever it needs one**, without ever holding the customer's secret:

- The service authenticates as **itself** for each exchange, so its own credentials are what keep the job going.
- The authorization server re-checks the delegation policy every time, so revoking "doc-service may act for customer A" takes effect immediately.
- Each delegated token is narrowly scoped (one audience, one scope, short expiry), so even a leaked one is of little use.

How the subject is represented for the length of a job varies by identity provider. Some issue a job-scoped subject token at submission, and some let the actor exchange against a stored delegation. The principle is the same either way: the **authorization server**, not the calling service, vouches for "on behalf of whom".

## Before and after

| | Header approach | Token exchange (delegation) |
|---|---|---|
| Who the gateway bills | The calling service | The customer (`sub`) |
| Can the caller spoof the customer? | Yes, it's a plain header | No, the claim is signed |
| Audit trail | "doc-service did it" | "doc-service, acting for customer A" |
| Per-customer quotas and policies | Hard to enforce | Natural: they follow `sub` |
| Revoking access | Rotate the service's secret | Remove one delegation |
| Service holds customer secrets? | No | No |

## Related: Microsoft's "On-Behalf-Of" flow

If you've used Microsoft Entra ID, you may know the **On-Behalf-Of (OBO) flow**. It solves the same problem (a middle-tier service calling downstream on behalf of a user) with a slightly different request format. The ideas carry over directly: exchange an incoming token for a new one scoped to the next service, and let the identity provider decide whether that's allowed.

## Takeaways

- Never let a downstream service decide **who to bill or authorize** based on a value the caller can set freely.
- **Token exchange** turns "trust me, this is for customer A" into a **signed claim** from the authorization server.
- Prefer **delegation** (with `act`) over impersonation, because you keep both identities for billing and auditing.
- Keep exchanged tokens **narrow**: specific `audience`, minimal `scope`, short `expires_in`.

The pattern is small, but it fixes a whole class of problems: billing, quotas, audit and least privilege, all from one well-designed token.

## Further reading

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [RFC 7519: JSON Web Token (JWT)](https://www.rfc-editor.org/rfc/rfc7519)
- [OWASP Top 10: Broken Access Control](https://owasp.org/Top10/A01_2021-Broken_Access_Control/)
