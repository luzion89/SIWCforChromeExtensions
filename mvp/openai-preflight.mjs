import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { authorize } from "./extension/siwc/protocol.js";

const hostId = "urn:uuid:" + crypto.randomUUID();
for (const port of [51455, 53601]) {
  await new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("回调端口 " + port + " 已有 TCP 监听"));
    });
    socket.once("error", error => error.code === "ECONNREFUSED" ? resolve() : reject(error));
  });
  const { url, transaction } = await authorize(hostId, { appName: "SIWC Chrome MVP", port });
  const result = execFileSync("curl", [
    "-sS", "--max-time", "12", "-o", "/dev/null", "-w", "%{http_code}\n%{redirect_url}", url,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const [status, redirect] = result.split("\n");
  const target = redirect ? new URL(redirect) : null;
  console.log(JSON.stringify({
    callback: transaction.redirectUri,
    listenerPresent: false,
    status: Number(status),
    next: target ? target.origin + target.pathname : null,
  }));
  if (status !== "302" || target?.origin !== "https://auth.openai.com" || target.pathname !== "/log-in") {
    process.exitCode = 1;
  }
}
