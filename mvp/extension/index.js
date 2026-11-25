import { defaultLivePort, defaultMockPort } from "./protocol.js";

const status = document.querySelector("#status");
const output = document.querySelector("#output");
const mode = document.querySelector("#mode");
const port = document.querySelector("#port");
const model = document.querySelector("#model");
const prompt = document.querySelector("#prompt");
const start = document.querySelector("#start");

async function send(type, fields = {}, provider = mode.value) {
  const reply = await chrome.runtime.sendMessage({ type, mode: provider, ...fields });
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

async function run(operation) {
  try {
    await operation();
  } catch (error) {
    output.textContent = error.message;
  }
}

async function showStatus() {
  const selected = mode.value;
  const state = await send("status", {}, selected);
  if (mode.value !== selected) return;
  status.textContent = selected === "mock"
    ? state.connected ? "模拟会话已连接" : "等待模拟授权"
    : state.connected ? "OpenAI 会话已连接" : "等待 OpenAI 授权";
}

mode.onchange = () => run(async () => {
  const live = mode.value === "openai";
  port.value = live ? defaultLivePort : defaultMockPort;
  prompt.value = live ? "Reply with exactly: SIWC OK" : "请返回一条模拟结果";
  start.textContent = live ? "打开 OpenAI 授权页" : "打开模拟授权页";
  document.querySelector("#notice").textContent = live
    ? "本实验使用你的 ChatGPT 套餐授权。登录和同意在 OpenAI 页面完成，推理需要另行点击发送。"
    : "模拟模式只使用测试凭证。";
  model.replaceChildren();
  output.textContent = "";
  await showStatus();
});

start.onclick = () => run(async () => {
  const selected = mode.value;
  if (!port.reportValidity()) return;
  await send("start", { port: port.valueAsNumber }, selected);
  if (mode.value === selected) status.textContent = "请在新标签页完成授权";
});

document.querySelector("#models").onclick = () => run(async () => {
  const selected = mode.value;
  const models = await send("models", {}, selected);
  if (mode.value !== selected) return;
  model.replaceChildren(...models.map(slug => new Option(slug, slug)));
  output.textContent = models.join("\n");
});

document.querySelector("#disconnect").onclick = () => run(async () => {
  const selected = mode.value;
  const { revoked } = await send("disconnect", {}, selected);
  if (mode.value !== selected) return;
  model.replaceChildren();
  output.textContent = revoked ? "授权已断开" : "已移除本地凭证，远端撤销未确认";
  await showStatus();
});

document.querySelector("form").onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    output.textContent = "接收流式结果…";
    const selected = mode.value;
    const text = await send("response", { model: model.value, prompt: prompt.value }, selected);
    if (mode.value === selected) output.textContent = text;
  });
};

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "sessionChanged" && message.mode === mode.value) void run(showStatus);
});
void run(showStatus);
