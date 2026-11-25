import { authorize, exchange, listModels, readCallback, refresh, revoke, streamResponse } from "./protocol.js";
import { consumeAttempt, loadSession, readRecord, removeRecord, removeSession, saveSession, writeRecord } from "./store.js";

const dnr = chrome.declarativeNetRequest;
const settingsPage = chrome.runtime.getURL("index.html");
const callbackPage = chrome.runtime.getURL("callback.html");
const ruleId = 1;
const expiryAlarm = "siwc-expire-attempt";
const workerId = crypto.randomUUID();
let queue = Promise.resolve();

function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

async function clearAttempt() {
  await dnr.updateSessionRules({ removeRuleIds: [ruleId] });
  await chrome.alarms.clear(expiryAlarm);
  await removeRecord("attempt");
}

async function start({ mode, port }) {
  const attempt = await readRecord("attempt");
  const rules = await dnr.getSessionRules();
  if (attempt?.expiresAt > Date.now() && rules.some(rule => rule.id === ruleId)) {
    throw new Error("请先完成或关闭当前授权标签页");
  }
  await clearAttempt();
  let hostId = await readRecord("hostId");
  if (!hostId) {
    hostId = "urn:uuid:" + crypto.randomUUID();
    await writeRecord("hostId", hostId);
  }
  const registration = mode === "openai" ? await readRecord("openai-registration") : undefined;
  const { transaction, url } = await authorize(hostId, { mode, port, registration });
  const { id: tabId } = await chrome.tabs.create({ url: "about:blank" });
  try {
    await writeRecord("attempt", { ...transaction, tabId, workerId });
    const escaped = transaction.redirectUri.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    await dnr.updateSessionRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: "redirect", redirect: { regexSubstitution: callbackPage + "\\1" } },
        condition: {
          regexFilter: "^" + escaped + "(\\?.*)?$",
          isUrlFilterCaseSensitive: true,
          tabIds: [tabId],
          resourceTypes: ["main_frame"],
          requestMethods: ["get"],
        },
      }],
    });
    await chrome.alarms.create(expiryAlarm, { when: transaction.expiresAt });
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    await clearAttempt();
    await chrome.tabs.remove(tabId).catch(() => {});
    throw error;
  }
  return { waiting: true };
}

async function complete(query, tabId) {
  const { attempt, registration } = await consumeAttempt(pending => {
    if (!pending || pending.tabId !== tabId) throw new Error("Unexpected callback tab");
    return { attempt: pending, registration: readCallback(query, pending) };
  });
  await clearAttempt();
  const session = await exchange(registration, attempt);
  await saveSession(attempt.mode, session);
  if (attempt.mode === "openai") {
    await writeRecord("openai-registration", { clientId: session.clientId, subject: session.subject });
  }
  void chrome.runtime.sendMessage({ type: "sessionChanged", mode: attempt.mode }).catch(() => {});
  return { mode: attempt.mode, recovered: attempt.workerId !== workerId };
}

async function getSession(mode) {
  const session = await loadSession(mode);
  if (!session) throw new Error("请先完成授权");
  if (session.expiresAt > Date.now() + 5_000) return session;
  if (session.earliestRefreshAt > Date.now() && session.expiresAt > Date.now()) return session;
  const updated = await refresh(mode, session);
  await saveSession(mode, updated);
  return updated;
}

async function disconnect(mode) {
  const session = await loadSession(mode);
  if (!session) return { revoked: true };
  let revoked = false;
  try {
    await revoke(mode, session);
    revoked = true;
  } catch {}
  await removeSession(mode);
  return { revoked };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id || sender.frameId !== 0) return;
  const fromCallback = sender.url?.split("?")[0] === callbackPage;
  if (message.type === "callback" ? !fromCallback : sender.url !== settingsPage) return;
  serialize(async () => {
    const { mode } = message;
    if (!fromCallback && mode !== "mock" && mode !== "openai") throw new Error("Unknown provider");
    switch (message.type) {
      case "start": return start(message);
      case "callback": return complete(message.query, sender.tab?.id);
      case "status": return { connected: Boolean(await loadSession(mode)) };
      case "models": return listModels(mode, await getSession(mode));
      case "response": return streamResponse(mode, await getSession(mode), message.model, message.prompt);
      case "disconnect": return disconnect(mode);
      default: throw new Error("Unknown action");
    }
  }).then(result => sendResponse({ result }), error => sendResponse({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  void serialize(async () => {
    const attempt = await readRecord("attempt");
    if (attempt?.tabId === tabId) await clearAttempt();
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== expiryAlarm) return;
  void serialize(async () => {
    const attempt = await readRecord("attempt");
    if (attempt && attempt.expiresAt <= Date.now()) await clearAttempt();
  }).catch(() => {});
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
