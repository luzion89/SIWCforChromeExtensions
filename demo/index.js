import { createChatGPT, DEFAULT_SIWC_PORT } from "./siwc/client.js";
import { initLanguage, setError, setPlainText, setText } from "./locale.js";

const chatgpt = createChatGPT();
const element = id => document.getElementById(id);
const model = element("model");
const profile = element("profile");
const output = element("output");
const prompt = element("prompt");
const port = element("port");
let session;
let generation;
let discovery;
let accountBusy = false;
let history = [];

const accountNote = element("account-note");
const metrics = element("metrics");

port.value = DEFAULT_SIWC_PORT;
initLanguage();

function placeholder(key) {
  const option = new Option("", "");
  setText(option, key);
  return option;
}

function badge(id, key, tone = "") {
  setText(element(id), key);
  element(id).dataset.tone = tone;
}

function controls() {
  const connecting = session?.status === "connecting";
  const connected = session?.status === "connected";
  const ready = Boolean(connected && session.sharing && !accountBusy);
  element("start").hidden = connecting || (connected && session.sharing);
  element("start").disabled = !session || accountBusy;
  setText(element("start"), connected ? "grantPlan" : "signIn");
  element("cancel-sign-in").hidden = !connecting;
  element("new-profile").hidden = connecting || !session?.profileId;
  element("new-profile").disabled = accountBusy;
  element("disconnect").hidden = !connected || connecting;
  element("disconnect").disabled = accountBusy;
  profile.disabled = connecting || accountBusy || profile.options.length < 2;
  model.disabled = !ready || !model.value || Boolean(generation || discovery);
  element("models").disabled = !ready || Boolean(generation);
  setText(element("models"), discovery ? "cancelDiscovery" : "getModels");
  element("send").hidden = Boolean(generation);
  element("send").disabled = !ready || !model.value || Boolean(discovery) || !prompt.value.trim();
  element("stop-response").hidden = !generation;
  element("clear").disabled = Boolean(generation) || (!history.length && !output.dataset.started);
  setText(element("turns"), "turns", history.length / 2);
}

function resetOutput() {
  history = [];
  delete output.dataset.started;
  setText(output, "emptyOutput");
  setPlainText(metrics, "");
  badge("stream-state", "idle");
}

function resetAccountView() {
  generation?.abort();
  discovery?.abort();
  generation = discovery = undefined;
  model.replaceChildren(placeholder("connectForModels"));
  prompt.value = "";
  resetOutput();
}

async function showSession(next) {
  if (session?.profileId !== next.profileId || session?.sharing !== next.sharing) resetAccountView();
  session = next;
  const connected = next.status === "connected";
  const statusKey = connected && !next.sharing ? "identityOnly" : next.status;
  badge("status", statusKey, connected && next.sharing ? "live" : next.status === "connecting" ? "busy" : "");
  if (next.error) setError(accountNote, next.error);
  else setText(accountNote, connected && next.sharing ? "planNote" : "authNote");
  controls();
  try {
    const accounts = await chatgpt.listProfiles();
    if (next !== session) return;
    profile.replaceChildren(...(accounts.length ? accounts.map(item => new Option(item.label, item.id)) : [placeholder("noAccount")]));
    if (next.profileId) profile.value = next.profileId;
    controls();
  } catch (error) {
    if (next === session) setError(accountNote, error);
  }
}

async function accountAction(operation) {
  if (accountBusy) return;
  accountBusy = true;
  controls();
  try {
    await operation();
  } catch (error) {
    setError(accountNote, error);
  } finally {
    accountBusy = false;
    controls();
  }
}

function signIn(newProfile) {
  if (!port.reportValidity()) return;
  void accountAction(() => chatgpt.signIn({
    newProfile, port: port.valueAsNumber, label: element("label").value.trim() || undefined,
    reconsent: !newProfile && session?.status === "connected" && !session.sharing,
  }));
}

element("start").onclick = () => signIn(false);
element("new-profile").onclick = () => signIn(true);
element("cancel-sign-in").onclick = () => chatgpt.cancelSignIn();
element("disconnect").onclick = () => accountAction(() => chatgpt.disconnect());
profile.onchange = () => accountAction(() => chatgpt.selectProfile(profile.value));
prompt.oninput = controls;

element("models").onclick = async () => {
  if (discovery) return discovery.abort();
  const request = new AbortController();
  const previousModel = model.value;
  discovery = request;
  controls();
  try {
    const models = await chatgpt.listModels({ signal: request.signal });
    if (discovery !== request) return;
    model.replaceChildren(...(models.length ? models.map(item => new Option(item.displayName, item.slug)) : [placeholder("noModels")]));
    if (models.some(item => item.slug === previousModel)) model.value = previousModel;
    setText(accountNote, "availableModels", models.length);
  } catch (error) {
    if (discovery === request) setError(accountNote, error);
  } finally {
    if (discovery === request) discovery = undefined;
    controls();
  }
};

element("compose").onsubmit = async event => {
  event.preventDefault();
  if (element("send").disabled || generation) return;
  const request = new AbortController();
  const message = { role: "user", content: prompt.value.trim() };
  const earlier = element("context").checked ? history : [];
  generation = request;
  output.dataset.started = "true";
  setPlainText(output, "");
  let chunks = 0;
  setPlainText(metrics, model.value);
  badge("stream-state", "waiting", "busy");
  controls();
  try {
    const { text } = await chatgpt.streamResponse({
      model: model.value, input: [...earlier, message], instructions: element("instructions").value.trim() || undefined,
      signal: request.signal,
      onDelta(delta) {
        if (generation !== request) return;
        output.append(document.createTextNode(delta));
        if (++chunks === 1) badge("stream-state", "streaming", "busy");
        setText(metrics, "chunks", chunks);
      },
    });
    if (generation !== request) return;
    output.textContent = text;
    history = [...earlier, message, { role: "assistant", content: text }];
    badge("stream-state", "completed", "live");
  } catch (error) {
    if (generation !== request) return;
    badge("stream-state", error.code === "cancelled" ? "stopped" : "interrupted", "warn");
    setError(metrics, error);
  } finally {
    if (generation === request) generation = undefined;
    controls();
  }
};
element("stop-response").onclick = () => generation?.abort();
element("clear").onclick = () => {
  resetOutput();
  prompt.value = "";
  controls();
  prompt.focus();
};

chatgpt.subscribe(showSession);
chatgpt.getSession().then(initial => {
  if (!session) void showSession(initial);
}).catch(error => { if (!session) setError(accountNote, error); });
