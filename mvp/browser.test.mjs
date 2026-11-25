import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { authorize, callbackForPort } from "./extension/siwc/protocol.js";
import { fixturePort, fixtureProvider, startFixture } from "./mock.mjs";

const extension = fileURLToPath(new URL("./extension/", import.meta.url));
const { issuer } = fixtureProvider;
const models = [{ slug: "fixture-text", displayName: "Fixture Text" }];
const defaultChrome = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : undefined;

test("MV3 fixture completes OAuth, refresh, and Responses after Worker termination", { timeout: 60_000 }, async t => {
  const fixture = await startFixture();
  let fixtureExtension;
  let userDataDir;
  let browser;
  t.after(async () => {
    await fixture.close();
    await browser?.close();
    if (fixtureExtension) await rm(fixtureExtension, { recursive: true, force: true });
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
  });
  fixtureExtension = await mkdtemp(join(tmpdir(), "siwc-fixture-"));
  await cp(extension, fixtureExtension, { recursive: true });
  await writeFile(join(fixtureExtension, "siwc", "provider.js"), "export const provider = " + JSON.stringify(fixtureProvider) + ";\n");
  userDataDir = await mkdtemp(join(tmpdir(), "siwc-browser-"));
  const launch = () => puppeteer.launch({
    ...(process.env.SIWC_CHROME || defaultChrome
      ? { executablePath: process.env.SIWC_CHROME || defaultChrome }
      : { channel: "chrome" }),
    headless: true,
    pipe: true,
    enableExtensions: [fixtureExtension],
    userDataDir,
    timeout: 15_000,
    protocolTimeout: 12_000,
  });
  browser = await launch();
  t.diagnostic(await browser.version());
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" &&
    target.url().endsWith("/worker.js"), { timeout: 10_000 });
  const extensionBase = "chrome-extension://" + new URL(worker.url()).host;
  let settings = await browser.newPage();
  settings.setDefaultTimeout(8_000);
  await settings.goto(extensionBase + "/index.html");
  await settings.waitForFunction(() => document.querySelector("#status")?.textContent === "等待 OpenAI 授权");
  assert.equal(await settings.$("#mode"), null);
  await settings.$eval("#port", (element, port) => { element.value = port; }, String(fixturePort));

  const start = async (previousTab, selector = "#start") => {
    await settings.bringToFront();
    await settings.click(selector);
    const tab = await browser.waitForTarget(target => target.url().startsWith(issuer + "/authorize?") &&
      target !== previousTab?.target(), { timeout: 8_000 });
    const page = await tab.page();
    page.setDefaultTimeout(8_000);
    await page.waitForSelector("#approve");
    return page;
  };
  const status = (page, state) => page.waitForSelector('#status[data-result="' + state + '"]');
  const approve = async (page, probe) => {
    const url = new URL(await page.$eval("#approve", element => element.href));
    if (probe) url.searchParams.set("probe", probe);
    await page.goto(url.href);
  };
  const stopWorker = async () => {
    const activeWorker = await browser.waitForTarget(target => target.url() === worker.url(), { timeout: 8_000 });
    const instance = await activeWorker.worker();
    const gone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.off("targetdestroyed", onDestroyed);
        reject(new Error("Chrome did not stop the extension Worker"));
      }, 8_000);
      const onDestroyed = target => {
        if (target !== activeWorker) return;
        clearTimeout(timer);
        browser.off("targetdestroyed", onDestroyed);
        resolve();
      };
      browser.on("targetdestroyed", onDestroyed);
    });
    await Promise.all([instance.close(), gone]);
  };
  const moveExpiryNear = (refreshDelay = 0) => settings.evaluate(async refreshDelay => {
    const { loadProfiles, saveProfiles } = await import(chrome.runtime.getURL("siwc/store.js"));
    const state = await loadProfiles();
    const profile = state.profiles.find(profile => profile.id === state.activeProfileId);
    const now = Date.now();
    Object.assign(profile.session, { expiresAt: now + 30_000, earliestRefreshAt: now + refreshDelay });
    await saveProfiles(state);
  }, refreshDelay);

  const auth = await start();
  const authUrl = auth.url();

  await t.test("DNR respects callback port and tab, and rejects forged state", async () => {
    await auth.goto(issuer + "/probe?kind=wrong-port");
    assert.match(await auth.$eval("body", el => el.textContent), /wrong port remained on fixture/);
    await auth.goto(authUrl);
    const unrelated = await browser.newPage();
    try {
      await assert.rejects(unrelated.goto(issuer + "/probe"), /ERR_CONNECTION_REFUSED/);
    } finally {
      await unrelated.close();
    }
    await approve(auth, "wrong-state");
    await status(auth, "rejected");
    assert.equal(auth.url(), extensionBase + "/siwc/callback.html");
    assert.match(await auth.$eval("#status", el => el.textContent), /Unknown or expired sign-in state/);
    assert.equal(fixture.counters.exchange, 0);
    await auth.goto(authUrl);
  });

  await t.test("Chrome retains the session rule and the new Worker restores the transaction", async () => {
    await stopWorker();
    await approve(auth);
    await status(auth, "recovered");
    assert.equal(auth.url(), extensionBase + "/siwc/callback.html");
    await settings.waitForFunction(() => document.querySelector("#status")?.textContent === "OpenAI 会话已连接");
    assert.equal(fixture.counters.exchange, 1);
    assert.equal(await settings.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length), 0);
  });

  await t.test("Concurrent SDK calls share refresh and forward conversation history", async () => {
    const input = [
      { role: "developer", content: "test guide" },
      { role: "assistant", content: "previous reply" },
      { role: "user", content: "second question" },
    ];
    const result = await settings.evaluate(async input => {
      const { createSiwcClient } = await import(chrome.runtime.getURL("siwc/client.js"));
      const siwc = createSiwcClient();
      const deltas = [];
      const [models, result] = await Promise.all([
        siwc.listModels(),
        siwc.streamResponse({ model: "fixture-text", input, instructions: "guidance", onDelta: delta => deltas.push(delta) }),
      ]);
      return { models, result, deltas };
    }, input);
    assert.deepEqual(result, { models, result: { text: "模拟推理完成" }, deltas: ["模拟", "推理完成"] });
    assert.deepEqual(fixture.behavior.lastInput, input);
    assert.equal(fixture.behavior.lastInstructions, "guidance");
    assert.deepEqual(fixture.counters, { exchange: 1, refresh: 1, models: 1, responses: 1 });

    await settings.bringToFront();
    await settings.click("#models");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "fixture-text");
    await settings.click("form button");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "模拟推理完成");
    assert.deepEqual(fixture.counters, { exchange: 1, refresh: 1, models: 2, responses: 2 });
    const storageShape = await settings.evaluate(async () => {
      const { readRecord } = await import(chrome.runtime.getURL("siwc/store.js"));
      const session = await readRecord("profiles:v2");
      const hostId = await readRecord("hostId");
      const key = await readRecord("profiles-key:v2");
      const exportResult = await crypto.subtle.exportKey("raw", key).then(() => "exported", error => error.name);
      return {
        ciphertext: session.ciphertext instanceof ArrayBuffer,
        persistentHost: hostId.startsWith("urn:uuid:"),
        extractable: key.extractable,
        exportResult,
      };
    });
    assert.deepEqual(storageShape, { ciphertext: true, persistentHost: true, extractable: false, exportResult: "InvalidAccessError" });
  });

  await t.test("Incomplete SSE is rejected, and a signed token with a wrong nonce is rejected", async () => {
    await settings.$eval("#prompt", el => { el.value = "interrupt"; });
    await settings.click("form button");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent.includes("before response.completed"));
    await settings.$eval("#port", element => { element.value = "18464"; });
    const next = await start(auth);
    assert.equal(new URL(next.url()).searchParams.get("redirect_uri"), callbackForPort(18464));
    assert.equal(new URL(next.url()).searchParams.get("client_id"), "oaiapp_fixture");
    await approve(next, "wrong-nonce");
    await status(next, "rejected");
    assert.match(await next.$eval("#status", el => el.textContent), /Invalid ID token claims/);
    assert.equal(fixture.counters.exchange, 2);
    await settings.reload();
    await settings.waitForFunction(() => document.querySelector("#status")?.textContent === "OpenAI 会话已连接");
  });

  await t.test("A model query runs while inference is still streaming and honors the refresh window", async () => {
    await moveExpiryNear(60_000);
    const previousRefreshCount = fixture.counters.refresh;
    const waiting = Promise.withResolvers();
    const gate = Promise.withResolvers();
    fixture.behavior.onResponseWaiting = waiting.resolve;
    fixture.behavior.responseGate = gate.promise;
    const generation = settings.evaluate(async () => {
      const { createSiwcClient } = await import(chrome.runtime.getURL("siwc/client.js"));
      return createSiwcClient().generateText({ model: "fixture-text", input: "wait for models" });
    });
    // Release the fixture even if the model query cannot finish concurrently.
    try {
      await Promise.race([waiting.promise, generation]);
      const result = await settings.evaluate(async () => {
        const { createSiwcClient } = await import(chrome.runtime.getURL("siwc/client.js"));
        return createSiwcClient().listModels();
      });
      assert.deepEqual(result, models);
      assert.equal(fixture.counters.refresh, previousRefreshCount);
    } finally {
      fixture.behavior.responseGate = undefined;
      gate.resolve();
      assert.deepEqual(await generation, { text: "模拟推理完成" });
    }
  });

  await t.test("Refresh verification resumes across Worker restart without reusing the old token", async () => {
    await moveExpiryNear();
    fixture.behavior.refreshIdentity = true;
    fixture.behavior.failJwks = true;
    const previousRefreshCount = fixture.counters.refresh;
    const readModels = () => settings.evaluate(async () => {
      const { createSiwcClient } = await import(chrome.runtime.getURL("siwc/client.js"));
      const siwc = createSiwcClient();
      return siwc.listModels().catch(error => error.code);
    });
    try {
      assert.equal(await readModels(), "verification_unavailable");
      assert.equal(fixture.counters.refresh, previousRefreshCount + 1);
      await stopWorker();
    } finally {
      fixture.behavior.failJwks = false;
      fixture.behavior.refreshIdentity = false;
    }
    assert.deepEqual(await readModels(), models);
    assert.equal(fixture.counters.refresh, previousRefreshCount + 1);
  });

  await t.test("An invalid refresh token clears the session and keeps the registered client", async () => {
    await moveExpiryNear();
    fixture.behavior.refreshError = "invalid_grant";
    try {
      const result = await settings.evaluate(async () => {
        const { createSiwcClient, SiwcError } = await import(chrome.runtime.getURL("siwc/client.js"));
        const siwc = createSiwcClient();
        const error = await siwc.listModels().catch(error => error);
        const session = await siwc.getSession();
        return { typed: error instanceof SiwcError, code: error.code, status: error.status, session: session.status, sharing: session.sharing };
      });
      assert.deepEqual(result, { typed: true, code: "reauth_required", status: 400, session: "reauth_required", sharing: false });
    } finally {
      fixture.behavior.refreshError = undefined;
    }
    await settings.$eval("#port", (element, port) => { element.value = port; }, String(fixturePort));
    const reauth = await start(auth);
    assert.equal(new URL(reauth.url()).searchParams.get("client_id"), "oaiapp_fixture");
    await approve(reauth);
    await status(reauth, "connected");
  });

  await t.test("A full Chrome restart preserves the authorized account and can make requests", async () => {
    const previousExchanges = fixture.counters.exchange;
    await browser.close();
    browser = await launch();
    settings = await browser.newPage();
    settings.setDefaultTimeout(8_000);
    await settings.goto(extensionBase + "/index.html");
    await settings.waitForFunction(() => document.querySelector("#status")?.textContent === "OpenAI 会话已连接");
    await settings.click("#models");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "fixture-text");
    assert.equal(fixture.counters.exchange, previousExchanges);
  });

  await t.test("Account selection preserves each grant and handles identity-only consent", async () => {
    await settings.$eval("#port", (el, port) => { el.value = port; }, String(fixturePort));
    const next = await start(undefined, "#new-profile");
    assert.equal(new URL(next.url()).searchParams.get("client_id"), "dynamic_agent_client");
    await approve(next, "identity-only");
    await status(next, "connected");
    const state = await settings.evaluate(async () => {
      const { createChatGPT } = await import(chrome.runtime.getURL("siwc/client.js"));
      const siwc = createChatGPT();
      const accounts = await siwc.listProfiles();
      const state = await siwc.getSession();
      const error = await siwc.listModels().catch(error => error.code);
      return { accounts, state, error };
    });
    assert.equal(state.accounts.length, 2);
    assert.equal(state.state.status, "connected");
    assert.equal(state.state.sharing, false);
    assert.equal(state.error, "plan_scope_missing");
    const reauth = await start(next);
    assert.equal(new URL(reauth.url()).searchParams.get("prompt"), "consent");
    await approve(reauth);
    await status(reauth, "connected");
    const listFor = id => settings.evaluate(async id => {
      const { createChatGPT } = await import(chrome.runtime.getURL("siwc/client.js"));
      const siwc = createChatGPT();
      await siwc.selectProfile(id);
      return siwc.listModels();
    }, id);
    assert.deepEqual(await listFor(state.accounts[1].id), models);
    assert.equal(fixture.behavior.lastModelClient, "oaiapp_fixture-2");
    assert.deepEqual(await listFor(state.accounts[0].id), models);
    assert.equal(fixture.behavior.lastModelClient, "oaiapp_fixture");
  });

  await t.test("Cancelling a stream or sign-in settles the corresponding SDK call", async () => {
    const result = await settings.evaluate(async () => {
      const { createChatGPT } = await import(chrome.runtime.getURL("siwc/client.js"));
      const siwc = createChatGPT();
      const controller = new AbortController();
      return siwc.streamResponse({
        model: "fixture-text", input: "cancel after delta", signal: controller.signal,
        onDelta: () => controller.abort(),
      }).catch(error => error.code);
    });
    assert.equal(result, "cancelled");
    await start(undefined, "#new-profile");
    await settings.bringToFront();
    await settings.click("#cancel-sign-in");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "操作已取消。");
    assert.equal(await settings.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length), 0);
  });

  await t.test("Disconnect revokes the selected account and leaves other accounts connected", async () => {
    await settings.bringToFront();
    await settings.click("#disconnect");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "授权已断开");
    const accounts = await settings.evaluate(async () => {
      const { loadProfiles } = await import(chrome.runtime.getURL("siwc/store.js"));
      const state = await loadProfiles();
      return state.profiles.map(({ status, session }) => ({ status, credentials: Boolean(session) }));
    });
    assert.deepEqual(accounts, [{ status: "disconnected", credentials: false }, { status: "connected", credentials: true }]);
  });

  await t.test("An existing session envelope migrates from a session key to persistent CryptoKey", async () => {
    const result = await settings.evaluate(async () => {
      const { loadProfiles, readRecord, removeRecord, writeRecord } = await import(chrome.runtime.getURL("siwc/store.js"));
      const encoder = new TextEncoder();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const registration = { clientId: "legacy-fixture", subject: "legacy-fixture-user" };
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode("session:openai") },
        key,
        encoder.encode(JSON.stringify({ ...registration, accessToken: "fixture-access", refreshToken: "fixture-refresh" })),
      );
      await removeRecord("profiles:v2");
      await removeRecord("profiles-key:v2");
      await writeRecord("openai-registration", registration);
      await writeRecord("session:openai", { iv, ciphertext });
      await chrome.storage.session.set({ "session-key:openai": Array.from(bytes) });
      const { profiles } = await loadProfiles();
      return {
        status: profiles[0].status,
        clientId: profiles[0].clientId,
        preserved: profiles[0].session.refreshToken === "fixture-refresh",
        legacyRemoved: await readRecord("session:openai") === undefined,
        extractable: (await readRecord("profiles-key:v2")).extractable,
      };
    });
    assert.deepEqual(result, {
      status: "connected", clientId: "legacy-fixture", preserved: true, legacyRemoved: true, extractable: false,
    });
  });
});

test("The same SIWC OpenAI authorization URL contract accepts a different callback port", async () => {
  for (const port of [51455, 53601]) {
    const { transaction, url } = await authorize("urn:uuid:" + crypto.randomUUID(), { appName: "Host Extension", port });
    const request = new URL(url);
    assert.equal(request.origin + request.pathname, "https://auth.openai.com/api/accounts/authorize");
    assert.equal(request.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(request.searchParams.get("agent_name_hint"), "Host Extension");
    assert.equal(request.searchParams.get("redirect_uri"), "http://127.0.0.1:" + port + "/auth/callback");
    assert.equal(request.searchParams.get("redirect_uri"), transaction.redirectUri);
  }
});
