import { channel } from "./client.js";

const query = location.search;
history.replaceState(null, "", location.pathname);
const status = document.querySelector("#status");

try {
  const { result, error } = await chrome.runtime.sendMessage({ channel, type: "callback", query });
  if (error) throw new Error(error.message);
  const label = result.sharing ? "OpenAI 授权成功" : "OpenAI 登录成功，尚未授予套餐用量权限";
  status.textContent = result.recovered ? label + "，事务由新 Worker 恢复" : label;
  status.dataset.result = result.recovered ? "recovered" : "connected";
} catch (error) {
  status.textContent = error.message;
  status.dataset.result = "rejected";
}
