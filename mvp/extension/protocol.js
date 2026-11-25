export const issuer = "http://127.0.0.1:18462";
export const defaultMockPort = 18463;
export const defaultLivePort = 51455;
export const callback = callbackForPort(defaultMockPort);
export const resource = issuer + "/v1";
const mockProvider = {
  issuer, resource,
  authorize: issuer + "/authorize", token: issuer + "/token",
  jwks: issuer + "/jwks", revoke: issuer + "/revoke",
};
const liveProvider = {
  issuer: "https://auth.openai.com",
  resource: "https://api.openai.com/v1",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  revoke: "https://auth.openai.com/api/accounts/oauth/revoke",
};
const planScope = "chatgpt.tokens.use.direct";
const initialClient = "dynamic_agent_client";
const encoder = new TextEncoder();

export function callbackForPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("请选择 1024 到 65535 之间的回调端口");
  return "http://127.0.0.1:" + port + "/auth/callback";
}

function providerFor(mode) {
  if (mode === "openai") return liveProvider;
  if (mode === "mock") return mockProvider;
  throw new Error("Unknown provider");
}

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid ID token encoding");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}

const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function authorize(hostId, { mode, port, registration }) {
  const provider = providerFor(mode);
  const transaction = {
    mode, redirectUri: callbackForPort(port), registration,
    state: random(), nonce: random(), verifier: random(), expiresAt: Date.now() + 600_000,
  };
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(transaction.verifier));
  const url = new URL(provider.authorize);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: registration?.clientId ?? initialClient,
    ext_agent_host_id: hostId,
    redirect_uri: transaction.redirectUri,
    scope: "openid profile email offline_access resource.invoke " + planScope,
    resource: provider.resource,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
  });
  if (!registration) url.searchParams.set("agent_name_hint", "SIWC Chrome MVP");
  return { transaction, url: url.href };
}

export function readCallback(query, transaction) {
  const params = new URLSearchParams(query);
  if (!transaction || transaction.expiresAt <= Date.now() ||
      params.getAll("state").length !== 1 || params.get("state") !== transaction.state) {
    throw new Error("Unknown or expired sign-in state");
  }
  if (params.has("error")) throw new Error("Authorization declined");
  const returnedClientId = params.get("client_id");
  const savedClientId = transaction.registration?.clientId;
  const clientId = returnedClientId ?? savedClientId;
  const code = params.get("code");
  if (!code || params.getAll("code").length !== 1 ||
      params.getAll("client_id").length > 1 ||
      (savedClientId && returnedClientId !== null && returnedClientId !== savedClientId) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(clientId ?? "") || clientId === initialClient) {
    throw new Error("Incomplete registration callback");
  }
  return { code, clientId };
}

async function request(url, init = {}, timeout = 15_000) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(new URL(url).pathname + " 返回 HTTP " + response.status);
  return response;
}

async function verifyIdentity(provider, token, clientId, nonce) {
  if (typeof token !== "string") throw new Error("Missing ID token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const [header, payload, signature] = parts;
  const decoder = new TextDecoder();
  const { alg, kid } = JSON.parse(decoder.decode(decode(header)));
  if (alg !== "RS256" || typeof kid !== "string") throw new Error("Invalid ID token algorithm");
  const { keys } = await (await request(provider.jwks)).json();
  const jwk = keys.find(k => k.kid === kid && k.kty === "RSA" && (!k.alg || k.alg === "RS256") && (!k.use || k.use === "sig"));
  if (!jwk) throw new Error("Unknown ID token key");
  const algorithm = "RSASSA-PKCS1-v1_5";
  const key = await crypto.subtle.importKey("jwk", jwk, { name: algorithm, hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify(algorithm, key, decode(signature), encoder.encode(header + "." + payload))) {
    throw new Error("Invalid ID token signature");
  }
  const claims = JSON.parse(decoder.decode(decode(payload)));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (claims.iss !== provider.issuer || !audiences.includes(clientId) ||
      (nonce !== undefined && claims.nonce !== nonce) ||
      ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
      !Number.isFinite(claims.iat) || claims.iat > now + 5 ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      typeof claims.sub !== "string" || !claims.sub) throw new Error("Invalid ID token claims");
  return claims.sub;
}

async function tokenGrant(provider, fields, priorScope) {
  const response = await request(provider.token, {
    method: "POST",
    body: new URLSearchParams({ resource: provider.resource, ...fields }),
  });
  const data = await response.json();
  data.scope ??= priorScope;
  if (typeof data.scope !== "string" || !data.scope.split(/\s+/).includes(planScope) ||
      typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer" ||
      typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error("缺少 ChatGPT 套餐授权或 OAuth 凭证");
  return data;
}

export async function exchange({ code, clientId }, { mode, redirectUri, nonce, verifier, registration }) {
  const provider = providerFor(mode);
  const data = await tokenGrant(provider, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const subject = await verifyIdentity(provider, data.id_token, clientId, nonce);
  if (registration && registration.subject !== subject) throw new Error("授权返回了不同的 ChatGPT 账号");
  return toSession(data, clientId, subject);
}

export async function refresh(mode, session) {
  const provider = providerFor(mode);
  const data = await tokenGrant(provider, {
    grant_type: "refresh_token",
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  }, session.scope);
  if (data.id_token !== undefined && await verifyIdentity(provider, data.id_token, session.clientId) !== session.subject) {
    throw new Error("刷新返回了不同的账号");
  }
  return toSession(data, session.clientId, session.subject);
}

export async function revoke(mode, session) {
  await request(providerFor(mode).revoke, {
    method: "POST",
    body: new URLSearchParams({
      client_id: session.clientId, token: session.refreshToken, token_type_hint: "refresh_token",
    }),
  });
}

function toSession(data, clientId, subject) {
  return {
    subject,
    clientId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresAt: Date.now() + data.expires_in * 1000,
    earliestRefreshAt: typeof data.earliest_refresh_at === "number"
      ? data.earliest_refresh_at * 1000
      : Date.parse(data.earliest_refresh_at) || 0,
  };
}

export async function listModels(mode, session) {
  const headers = { authorization: "Bearer " + session.accessToken };
  const { models } = await (await request(providerFor(mode).resource + "/models", { headers })).json();
  return models.filter(model => model.visibility === "list").map(model => model.slug);
}

export async function streamResponse(mode, session, model, prompt) {
  const response = await request(providerFor(mode).resource + "/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer " + session.accessToken,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ model, input: [{ role: "user", content: prompt }], store: false, stream: true }),
  }, 90_000);
  const contentType = response.headers.get("content-type");
  if (!response.body || (contentType && !contentType.startsWith("text/event-stream"))) throw new Error("Expected an SSE stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Stream ended before response.completed");
      buffer += value;
      for (let separator; (separator = /\r?\n\r?\n/.exec(buffer));) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const payload = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!payload) continue;
        const event = JSON.parse(payload);
        if (event.type === "response.output_text.delta") text += event.delta;
        if (event.type === "response.completed") return text;
        if (["response.failed", "response.incomplete", "error"].includes(event.type)) throw new Error("Response failed");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
