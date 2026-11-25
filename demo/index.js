import { createChatGPT, DEFAULT_SIWC_PORT } from "./siwc/client.js";

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

port.value = DEFAULT_SIWC_PORT;

function badge(id, label, tone = "") {
  element(id).textContent = label;
  element(id).dataset.tone = tone;
}

function controls() {
  const connecting = session?.status === "connecting";
  const connected = session?.status === "connected";
  const ready = Boolean(connected && session.sharing && !accountBusy);
  element("start").hidden = connecting || (connected && session.sharing);
  element("start").disabled = !session || accountBusy;
  element("start").textContent = connected ? "授权套餐用量" : "使用 ChatGPT 登录";
  element("cancel-sign-in").hidden = !connecting;
  element("new-profile").hidden = connecting || !session?.profileId;
  element("new-profile").disabled = accountBusy;
  element("disconnect").hidden = !connected || connecting;
  element("disconnect").disabled = accountBusy;
  profile.disabled = connecting || accountBusy || profile.options.length < 2;
  model.disabled = !ready || !model.value || Boolean(generation || discovery);
  element("models").disabled = !ready || Boolean(generation);
  element("models").textContent = discovery ? "取消获取" : "获取模型";
  element("send").hidden = Boolean(generation);
  element("send").disabled = !ready || !model.value || Boolean(discovery) || !prompt.value.trim();
  element("stop-response").hidden = !generation;
  element("clear").disabled = Boolean(generation) || (!history.length && !output.dataset.started);
  element("turns").textContent = "当前对话 · " + history.length / 2 + " 轮";
}

function resetOutput() {
  history = [];
  delete output.dataset.started;
  output.textContent = "回复将逐段显示在这里。";
  element("metrics").textContent = "";
  badge("stream-state", "等待输入");
}

function resetAccountView() {
  generation?.abort();
  discovery?.abort();
  generation = discovery = undefined;
  model.replaceChildren(new Option("连接后获取模型", ""));
  prompt.value = "";
  resetOutput();
}

async function showSession(next) {
  if (session?.profileId !== next.profileId || session?.sharing !== next.sharing) resetAccountView();
  session = next;
  const connected = next.status === "connected";
  const labels = { disconnected: "未连接", connecting: "授权中", reauth_required: "需要重新授权", connected: next.sharing ? "已连接" : "仅身份授权" };
  badge("status", labels[next.status], connected && next.sharing ? "live" : next.status === "connecting" ? "busy" : "");
  element("account-note").textContent = next.error?.message ?? (connected && next.sharing ? "当前请求使用此账号的 ChatGPT 套餐。" : "在 OpenAI 授权页面选择账号与套餐权限。");
  controls();
  try {
    const accounts = await chatgpt.listProfiles();
    if (next !== session) return;
    profile.replaceChildren(...(accounts.length ? accounts.map(item => new Option(item.label, item.id)) : [new Option("尚未连接账号", "")]));
    if (next.profileId) profile.value = next.profileId;
    controls();
  } catch (error) {
    if (next === session) element("account-note").textContent = error.message;
  }
}

async function accountAction(operation) {
  if (accountBusy) return;
  accountBusy = true;
  controls();
  try {
    await operation();
  } catch (error) {
    element("account-note").textContent = error.message;
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
    model.replaceChildren(...(models.length ? models.map(item => new Option(item.displayName, item.slug)) : [new Option("此账号暂无模型", "")]));
    if (models.some(item => item.slug === previousModel)) model.value = previousModel;
    element("account-note").textContent = "此账号可用模型 · " + models.length;
  } catch (error) {
    if (discovery === request) element("account-note").textContent = error.message;
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
  output.textContent = "";
  let chunks = 0;
  element("metrics").textContent = model.value;
  badge("stream-state", "等待模型", "busy");
  controls();
  try {
    const { text } = await chatgpt.streamResponse({
      model: model.value, input: [...earlier, message], instructions: element("instructions").value.trim() || undefined,
      signal: request.signal,
      onDelta(delta) {
        if (generation !== request) return;
        output.append(document.createTextNode(delta));
        if (++chunks === 1) badge("stream-state", "正在生成", "busy");
        element("metrics").textContent = model.value + " · " + chunks + " 段增量";
      },
    });
    if (generation !== request) return;
    output.textContent = text;
    history = [...earlier, message, { role: "assistant", content: text }];
    badge("stream-state", "已完成", "live");
  } catch (error) {
    if (generation !== request) return;
    badge("stream-state", error.code === "cancelled" ? "已停止" : "生成中断", "warn");
    element("metrics").textContent = error.message;
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
}).catch(error => { if (!session) element("account-note").textContent = error.message; });
