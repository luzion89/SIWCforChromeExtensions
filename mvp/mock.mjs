import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { callback, callbackForPort, issuer, resource } from "./extension/protocol.js";

const clientId = "oaiapp_fixture";
const grantedScope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const model = "fixture-text";
const keyId = "fixture-rsa";

export async function startFixture() {
  const codes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const counters = { exchange: 0, refresh: 0, models: 0, responses: 0 };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: keyId, alg: "RS256", use: "sig" };
  const jwtPart = value => Buffer.from(JSON.stringify(value)).toString("base64url");

  function mint(nonce, invalidIdentity) {
    const access = randomUUID();
    const refresh = randomUUID();
    const expiresIn = nonce ? 1 : 3600;
    accessTokens.set(access, Date.now() + expiresIn * 1000);
    refreshTokens.set(refresh, access);
    const response = {
      token_type: "Bearer", expires_in: expiresIn, scope: grantedScope,
      access_token: access, refresh_token: refresh,
    };
    if (nonce) {
      const header = jwtPart({ alg: "RS256", kid: keyId });
      const claims = jwtPart({
        iss: issuer, aud: clientId, sub: "fixture-user",
        nonce: invalidIdentity ? "wrong-nonce" : nonce,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const signed = header + "." + claims;
      response.id_token = signed + "." + sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
    }
    return response;
  }

  async function handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url, issuer);
    const params = url.searchParams;
    const query = key => params.get(key);
    const json = (value, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const invalid = () => json({ error: "invalid_fixture_request" }, 400);
    const redirect = target => res.writeHead(302, { location: target }).end();
    const body = async () => {
      let text = "";
      for await (const part of req) {
        text += part;
        if (text.length > 10_000) throw new Error("Request too large");
      }
      return text;
    };

    if (url.pathname === "/authorize" && req.method === "GET") {
      const redirectUri = query("redirect_uri");
      const target = new URL(redirectUri);
      if (redirectUri !== callbackForPort(Number(target.port)) || target.origin === issuer ||
          query("client_id") !== "dynamic_agent_client" ||
          query("resource") !== resource || query("response_type") !== "code" ||
          query("code_challenge_method") !== "S256" || query("scope") !== grantedScope ||
          !query("ext_agent_host_id")?.startsWith("urn:uuid:") ||
          ["state", "nonce", "code_challenge"].some(key => !/^[A-Za-z0-9_-]{43}$/.test(query(key) ?? ""))) return invalid();
      const attempt = randomUUID();
      codes.set(attempt, {
        state: query("state"), nonce: query("nonce"), challenge: query("code_challenge"),
        redirectUri,
        expiresAt: Date.now() + 300_000,
      });
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        '<!doctype html><meta charset="utf-8"><title>Local OAuth fixture</title>' +
        '<h1>本机 OAuth 模拟授权</h1><p>本次使用模拟凭证。</p>' +
        '<a id="approve" href="/approve?id=' + attempt + '">同意模拟授权</a>',
      );
    }

    if (url.pathname === "/approve" && req.method === "GET") {
      const grant = codes.get(query("id"));
      if (!grant || grant.code || grant.expiresAt <= Date.now()) return invalid();
      if (query("probe") === "wrong-state") return redirect(grant.redirectUri + "?state=invalid&code=mock&client_id=" + clientId);
      grant.code = randomUUID();
      grant.invalidIdentity = query("probe") === "wrong-nonce";
      codes.delete(query("id"));
      codes.set(grant.code, grant);
      return redirect(grant.redirectUri + "?" + new URLSearchParams({ code: grant.code, state: grant.state, client_id: clientId }));
    }

    if (url.pathname === "/probe") {
      const url = query("kind") === "wrong-port" ? new URL(new URL(callback).pathname, issuer).href : callback;
      return redirect(url + "?probe=synthetic");
    }
    if (url.pathname === new URL(callback).pathname) return res.end("wrong port remained on fixture");
    if (url.pathname === "/jwks") return json({ keys: [jwk] });

    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await body());
      if (form.get("client_id") !== clientId || form.get("resource") !== resource) return invalid();
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code");
        const grant = codes.get(code);
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!grant?.code || grant.expiresAt <= Date.now() || form.get("redirect_uri") !== grant.redirectUri ||
            challenge !== grant.challenge) return invalid();
        codes.delete(code);
        counters.exchange++;
        return json(mint(grant.nonce, grant.invalidIdentity));
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token");
        const oldAccess = refreshTokens.get(token);
        if (!oldAccess) return invalid();
        refreshTokens.delete(token);
        accessTokens.delete(oldAccess);
        counters.refresh++;
        return json(mint());
      }
      return invalid();
    }

    if (url.pathname === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await body());
      if (form.get("client_id") !== clientId || form.get("token_type_hint") !== "refresh_token") return invalid();
      const token = form.get("token");
      accessTokens.delete(refreshTokens.get(token));
      refreshTokens.delete(token);
      return res.writeHead(200).end();
    }

    if (url.pathname === "/v1/models" || url.pathname === "/v1/responses") {
      const token = req.headers.authorization?.slice("Bearer ".length);
      if (!token || accessTokens.get(token) <= Date.now() || !accessTokens.has(token)) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/v1/models" && req.method === "GET") {
        counters.models++;
        return json({ models: [{ slug: model, visibility: "list" }, { slug: "hidden", visibility: "hidden" }] });
      }
      if (url.pathname === "/v1/responses" && req.method === "POST") {
        const input = JSON.parse(await body());
        if (input.model !== model || input.store !== false || input.stream !== true ||
            input.input?.[0]?.role !== "user" || typeof input.input[0].content !== "string") return invalid();
        counters.responses++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = data => "data: " + JSON.stringify(data) + "\r\n\r\n";
        const delta = Buffer.from(frame({ type: "response.output_text.delta", delta: "模拟" }));
        const split = delta.indexOf(Buffer.from("模")) + 1;
        res.write(delta.subarray(0, split));
        await new Promise(resolve => setTimeout(resolve, 30));
        res.write(delta.subarray(split));
        if (input.input[0].content === "interrupt") return res.end();
        return res.end(frame({ type: "response.output_text.delta", delta: "推理完成" }) +
          frame({ type: "response.completed" }));
      }
    }
    res.writeHead(404).end("Fixture route not found");
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end("Malformed fixture request");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(issuer).port), "127.0.0.1", resolve);
  });
  return {
    counters,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await startFixture();
  console.log("Local OAuth fixture listening at " + issuer);
}
