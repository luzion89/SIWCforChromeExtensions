const messages = {
  "zh-CN": {
    workspace: "流式工作台", intro: "连接你的 ChatGPT 账号，选择模型，实时查看回复。",
    account: "账号连接", loading: "读取中", activeAccount: "当前账号", noAccount: "尚未连接账号",
    signIn: "使用 ChatGPT 登录", grantPlan: "授权套餐用量", cancelSignIn: "取消授权",
    addAccount: "添加账号", disconnect: "断开连接", authOptions: "授权选项", port: "回调端口",
    accountLabel: "账号备注（可选）", accountExample: "例如：工作账号",
    generate: "文本生成", model: "模型", connectForModels: "连接后获取模型", getModels: "获取模型",
    cancelDiscovery: "取消获取", noModels: "此账号暂无模型", availableModels: "此账号可用模型 · {n}",
    message: "消息", promptExample: "输入想发给模型的内容…", generationOptions: "生成选项",
    instructions: "模型指令（可选）", instructionsExample: "例如：用简洁的中文回答。",
    useContext: "携带本次对话上下文", turns: "当前对话 · {n} 轮", stop: "停止生成", send: "发送消息 ↑",
    response: "流式回复", idle: "等待输入", emptyOutput: "回复将逐段显示在这里。", clear: "新对话",
    disconnected: "未连接", connecting: "授权中", reauth_required: "需要重新授权",
    connected: "已连接", identityOnly: "仅身份授权",
    planNote: "当前请求使用此账号的 ChatGPT 套餐。", authNote: "在 OpenAI 授权页面选择账号与套餐权限。",
    waiting: "等待模型", streaming: "正在生成", completed: "已完成", stopped: "已停止", interrupted: "生成中断",
    chunks: "{n} 段增量",
  },
  en: {
    workspace: "Streaming workspace", intro: "Connect your ChatGPT account, choose a model, and watch replies stream in.",
    account: "Account connection", loading: "Loading", activeAccount: "Active account", noAccount: "No account connected",
    signIn: "Sign in with ChatGPT", grantPlan: "Grant plan access", cancelSignIn: "Cancel sign-in",
    addAccount: "Add account", disconnect: "Disconnect", authOptions: "Authorization options", port: "Callback port",
    accountLabel: "Account label (optional)", accountExample: "For example, Work account",
    generate: "Text generation", model: "Model", connectForModels: "Connect to get models", getModels: "Get models",
    cancelDiscovery: "Cancel lookup", noModels: "No models available for this account", availableModels: "Available models · {n}",
    message: "Message", promptExample: "Enter a message for the model…", generationOptions: "Generation options",
    instructions: "Model instructions (optional)", instructionsExample: "For example, keep the answer concise.",
    useContext: "Include conversation context", turns: "Conversation turns · {n}", stop: "Stop generating", send: "Send message ↑",
    response: "Streaming response", idle: "Waiting for input", emptyOutput: "Reply text will appear here as it arrives.", clear: "New conversation",
    disconnected: "Disconnected", connecting: "Signing in", reauth_required: "Sign in again",
    connected: "Connected", identityOnly: "Identity only",
    planNote: "Requests use this account’s ChatGPT plan.", authNote: "Choose an account and grant plan access on the OpenAI authorization page.",
    waiting: "Waiting for model", streaming: "Streaming", completed: "Complete", stopped: "Stopped", interrupted: "Interrupted",
    chunks: "Chunks · {n}",
  },
};

const englishErrors = new Map(Object.entries({
  cancelled: "Operation cancelled.",
  sign_in_interrupted: "Sign-in was interrupted. Start again.",
  sign_in_pending: "Complete or cancel the current sign-in first.",
  unknown_profile: "The selected ChatGPT account was not found.",
  authorization_declined: "OpenAI authorization was declined.",
  account_mismatch: "Authorization returned a different ChatGPT account.",
  auth_required: "Sign in with ChatGPT first.",
  reauth_required: "Sign in with ChatGPT again.",
  plan_scope_missing: "Grant access to your ChatGPT plan first.",
  refresh_not_ready: "OpenAI does not allow refreshing the credentials yet. Try again later.",
  refresh_response_expired: "Updated credentials were saved. Retry to obtain a fresh access token.",
  remote_revocation_unconfirmed: "Local credentials were removed. Remote revocation could not be confirmed.",
  credential_storage_unavailable: "Unable to read the saved authorization.",
  request_interrupted: "The connection to the extension background worker was interrupted.",
  timeout: "The OpenAI request timed out.",
  network_error: "Unable to reach OpenAI. Try again later.",
  verification_unavailable: "Unable to verify the OpenAI signature. Try again later.",
  invalid_response: "OpenAI returned an invalid response.",
  stream_incomplete: "The response stream ended before completion.",
}));

const preference = "siwc-studio-language";
let language = localStorage.getItem(preference) === "en" ? "en" : "zh-CN";
const errors = new Map();

function translate(node) {
  const text = messages[language][node.dataset.text];
  node.textContent = text.replace("{n}", node.dataset.count ?? "");
}

export function setText(node, key, count = "") {
  errors.delete(node);
  node.dataset.text = key;
  node.dataset.count = String(count);
  translate(node);
}

export function setPlainText(node, value) {
  errors.delete(node);
  delete node.dataset.text;
  node.textContent = value;
}

function translateError(node, error) {
  const detail = error.status ? "HTTP " + error.status : error.code;
  node.textContent = language === "en"
    ? englishErrors.get(error.code) ?? (detail ? "Request failed (" + detail + ")." : error.message)
    : error.message;
}

export function setError(node, error) {
  delete node.dataset.text;
  errors.set(node, error);
  translateError(node, error);
}

function renderLanguage() {
  document.documentElement.lang = language;
  document.title = "SIWC Studio · " + messages[language].workspace;
  document.querySelectorAll("[data-text]").forEach(translate);
  for (const node of document.querySelectorAll("[data-placeholder]")) {
    node.placeholder = messages[language][node.dataset.placeholder];
  }
  for (const node of document.querySelectorAll("[data-aria-label]")) {
    node.setAttribute("aria-label", messages[language][node.dataset.ariaLabel]);
  }
  for (const [node, error] of errors) translateError(node, error);
  const toggle = document.getElementById("language");
  toggle.lang = language === "en" ? "zh-CN" : "en";
  toggle.textContent = language === "en" ? "简体中文" : "English";
  toggle.setAttribute("aria-label", language === "en" ? "切换为简体中文" : "Switch to English");
}

export function initLanguage() {
  renderLanguage();
  document.getElementById("language").onclick = () => {
    language = language === "en" ? "zh-CN" : "en";
    localStorage.setItem(preference, language);
    renderLanguage();
  };
}
