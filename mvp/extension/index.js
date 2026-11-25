import { createChatGPT, DEFAULT_SIWC_PORT } from "./siwc/client.js";

const siwc = createChatGPT();
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const port = document.querySelector("#port");
const model = document.querySelector("#model");
const prompt = document.querySelector("#prompt");
const profiles = document.querySelector("#profile");
const cancelSignIn = document.querySelector("#cancel-sign-in");
const stopResponse = document.querySelector("#stop-response");
let state;
let generation;

port.value = DEFAULT_SIWC_PORT;

async function run(operation) {
  try {
    await operation();
  } catch (error) {
    output.textContent = error.message;
  }
}

async function showSession(session) {
  if (state?.profileId !== session.profileId || !session.sharing) model.replaceChildren();
  state = session;
  const labels = {
    disconnected: "等待 OpenAI 授权",
    connecting: "请在新标签页完成授权",
    reauth_required: "OpenAI 授权已失效，请重新授权",
    connected: session.sharing ? "OpenAI 会话已连接" : "账号已连接，尚未授予套餐用量权限",
  };
  status.textContent = labels[session.status];
  cancelSignIn.hidden = session.status !== "connecting";
  const accounts = await siwc.listProfiles();
  if (state !== session) return;
  profiles.replaceChildren(...accounts.map(({ id, label }) => new Option(label, id)));
  if (session.profileId) profiles.value = session.profileId;
}

async function startSignIn(newProfile = false) {
  if (!port.reportValidity()) return;
  await siwc.signIn({ port: port.valueAsNumber, newProfile, reconsent: !newProfile && state?.status === "connected" && !state.sharing });
}

document.querySelector("#start").onclick = () => run(() => startSignIn());
document.querySelector("#new-profile").onclick = () => run(() => startSignIn(true));
cancelSignIn.onclick = () => siwc.cancelSignIn();
profiles.onchange = () => run(() => siwc.selectProfile(profiles.value));

document.querySelector("#models").onclick = () => run(async () => {
  const models = await siwc.listModels();
  model.replaceChildren(...models.map(({ slug, displayName }) => new Option(displayName, slug)));
  output.textContent = models.map(({ slug }) => slug).join("\n");
});

document.querySelector("#disconnect").onclick = () => run(async () => {
  await siwc.disconnect();
  output.textContent = "授权已断开";
});

document.querySelector("form").onsubmit = event => {
  event.preventDefault();
  if (generation) return;
  void run(async () => {
    generation = new AbortController();
    stopResponse.hidden = false;
    output.textContent = "";
    try {
      const { text } = await siwc.streamResponse({
        model: model.value, input: prompt.value, signal: generation.signal,
        onDelta: delta => { output.textContent += delta; },
      });
      output.textContent = text;
    } finally {
      generation = undefined;
      stopResponse.hidden = true;
    }
  });
};

stopResponse.onclick = () => generation?.abort();
siwc.subscribe(session => void run(() => showSession(session)));
