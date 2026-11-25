const query = location.search;
history.replaceState(null, "", location.pathname);
const status = document.querySelector("#status");

try {
  const { result, error } = await chrome.runtime.sendMessage({ type: "callback", query });
  if (error) throw new Error(error);
  const label = result.mode === "openai" ? "OpenAI 授权成功" : "模拟授权成功";
  status.textContent = result.recovered ? label + "，事务由新 Worker 恢复" : label;
  status.dataset.result = result.recovered ? "recovered" : "connected";
} catch (error) {
  status.textContent = error.message;
  status.dataset.result = "rejected";
}
