import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { authorize, callbackForPort, issuer } from "./extension/protocol.js";
import { startFixture } from "./mock.mjs";

const extension = fileURLToPath(new URL("./extension/", import.meta.url));
const defaultChrome = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : undefined;

test("MV3 fixture completes OAuth, refresh, and Responses after Worker termination", { timeout: 60_000 }, async t => {
  const fixture = await startFixture();
  let browser;
  t.after(async () => {
    await fixture.close();
    await browser?.close();
  });
  browser = await puppeteer.launch({
    ...(process.env.SIWC_CHROME || defaultChrome
      ? { executablePath: process.env.SIWC_CHROME || defaultChrome }
      : { channel: "chrome" }),
    headless: true,
    pipe: true,
    enableExtensions: [extension],
    timeout: 15_000,
    protocolTimeout: 12_000,
  });
  t.diagnostic(await browser.version());
  const worker = await browser.waitForTarget(target => target.type() === "service_worker" &&
    target.url().endsWith("/worker.js"), { timeout: 10_000 });
  const extensionBase = "chrome-extension://" + new URL(worker.url()).host;
  const settings = await browser.newPage();
  settings.setDefaultTimeout(8_000);
  await settings.goto(extensionBase + "/index.html");
  await settings.waitForFunction(() => document.querySelector("#status")?.textContent === "等待模拟授权");

  const start = async (previousTab) => {
    await settings.bringToFront();
    await settings.click("#start");
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
    assert.equal(auth.url(), extensionBase + "/callback.html");
    assert.match(await auth.$eval("#status", el => el.textContent), /Unknown or expired sign-in state/);
    assert.equal(fixture.counters.exchange, 0);
    await auth.goto(authUrl);
  });

  await t.test("Chrome retains the session rule and the new Worker restores the transaction", async () => {
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
    await approve(auth);
    await status(auth, "recovered");
    assert.equal(auth.url(), extensionBase + "/callback.html");
    assert.equal(fixture.counters.exchange, 1);
    assert.equal(await settings.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).length), 0);
  });

  await t.test("Bearer token refreshes, model list filters, and fragmented SSE reaches completion", async () => {
    await settings.bringToFront();
    await settings.click("#models");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "fixture-text");
    await settings.click("form button");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "模拟推理完成");
    assert.deepEqual(fixture.counters, { exchange: 1, refresh: 1, models: 1, responses: 1 });
    const storageShape = await settings.evaluate(async () => {
      const { readRecord } = await import(chrome.runtime.getURL("store.js"));
      const session = await readRecord("session:mock");
      const hostId = await readRecord("hostId");
      return { ciphertext: session.ciphertext instanceof ArrayBuffer, persistentHost: hostId.startsWith("urn:uuid:") };
    });
    assert.deepEqual(storageShape, { ciphertext: true, persistentHost: true });
  });

  await t.test("Incomplete SSE is rejected, and a signed token with a wrong nonce is rejected", async () => {
    await settings.$eval("#prompt", el => { el.value = "interrupt"; });
    await settings.click("form button");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent.includes("before response.completed"));
    await settings.$eval("#port", element => { element.value = "18464"; });
    const next = await start(auth);
    assert.equal(new URL(next.url()).searchParams.get("redirect_uri"), callbackForPort(18464));
    await approve(next, "wrong-nonce");
    await status(next, "rejected");
    assert.match(await next.$eval("#status", el => el.textContent), /Invalid ID token claims/);
    assert.equal(fixture.counters.exchange, 2);
    await settings.reload();
    await settings.waitForFunction(() => document.querySelector("#status")?.textContent === "模拟会话已连接");
  });

  await t.test("Disconnect revokes the fixture grant and removes the IndexedDB envelope", async () => {
    await settings.bringToFront();
    await settings.click("#disconnect");
    await settings.waitForFunction(() => document.querySelector("#output")?.textContent === "授权已断开");
    const record = await settings.evaluate(async () => {
      const { readRecord } = await import(chrome.runtime.getURL("store.js"));
      return readRecord("session:mock");
    });
    assert.equal(record, undefined);
  });
});

test("The same SIWC OpenAI authorization URL contract accepts a different callback port", async () => {
  for (const port of [51455, 53601]) {
    const { transaction, url } = await authorize("urn:uuid:" + crypto.randomUUID(), { mode: "openai", port });
    const request = new URL(url);
    assert.equal(request.origin + request.pathname, "https://auth.openai.com/api/accounts/authorize");
    assert.equal(request.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(request.searchParams.get("redirect_uri"), "http://127.0.0.1:" + port + "/auth/callback");
    assert.equal(request.searchParams.get("redirect_uri"), transaction.redirectUri);
  }
});
