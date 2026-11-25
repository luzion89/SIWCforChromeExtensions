# Chrome 扩展内的 Sign in with ChatGPT MVP

此 MVP 的运行代码都在 Chrome Manifest V3 扩展里。授权请求向 OpenAI 申报 `http://127.0.0.1:<port>/auth/callback`，其中只允许选择端口。Chrome DNR 在授权标签页内把回调导航重定向到扩展的回调页。扩展随后验证事务并使用原 URI 换码。

项目长期目标是提供可嵌入其他 Chrome 扩展的 SIWC SDK。本阶段发布物是用于验证授权、换码和推理的测试扩展，SDK 的接口和发布方式会在后续阶段确定。

## 回调、存储和调用

1. Worker 生成 OAuth `state`、OIDC `nonce` 和 PKCE verifier，在 IndexedDB 提交事务后安装临时 DNR session rule，再打开授权页。
2. DNR 规则只匹配该标签页的 GET 主框架请求及指定端口、路径。到达扩展回调页后，页面清掉地址栏的参数，并向 Worker 发送回调结果。
3. Worker 在同一个 IndexedDB 事务中校验标签页、state 和到期时间，并消费一次性事务。换码使用 OpenAI 发回的 issued `client_id` 和最初发送的 `redirect_uri`。JWKS 签名、issuer、audience、nonce 及套餐 scope 校验成功后才可调用 API。
4. IndexedDB 保存 host ID、已验证的账户注册绑定、在途事务和 AES-GCM 凭证密文。密钥仅放在扩展浏览器会话的内存里。因此 Worker 终止后可以恢复，浏览器重启后需要重新授权。扩展界面只接收会话状态、模型和推理结果。
5. Worker 使用 SIWC 应用的 OAuth Bearer token 请求 `GET /v1/models` 和 `POST /v1/responses`。测试按实际模型列表选择，发送数组形式的 `input`，使用 `store: false` 和 `stream: true`，以 `response.completed` 为成功条件。 [注册和换码](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [SIWC 推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

Loom.js 公开的 Codex 实验采用了相同的 DNR 回调桥接思路。它为 Codex 保留 `http://localhost:1455/auth/callback`。这里使用 SIWC 自身的 `dynamic_agent_client` 注册、IPv4 回环 URI 和公开的 Responses 资源。 [Loom.js 实验说明](https://github.com/mgravey/loom.js/blob/ad0d6483465e9fc546b7e2d5b4b005dd3c19e8b9/docs/codex-auth-experiment.md)

## 验证结果

| 实验 | 观察结果 |
| --- | --- |
| 真实 OpenAI 匿名预检 | 分别使用 `127.0.0.1:51455` 和 `127.0.0.1:53601`，两端口均无监听。OpenAI 均返回 HTTP 302，目标为 `https://auth.openai.com/log-in`。 |
| 真实 OpenAI 授权和推理 | 用户在 OpenAI 页面完成授权后，端口 51455 的 DNR 回调和换码成功。扩展使用真实 SIWC token 取得模型列表，向 `gpt-6.2-sol` 发送 `Reply with exactly: SIWC OK`，收到 `response.completed`，显示 `SIWC OK`。 |
| Chrome 模拟授权和生命周期 | Chrome 158 上验证了错误端口及另一个标签页不命中规则，错误 state 不触发换码，Worker 被主动终止后仍能持续接收回调并从 IndexedDB 恢复事务。也验证了更换端口后回调和换码继续使用同一 URI。 |
| Chrome 模拟套餐调用 | 模拟 JWKS、换码、token 轮换、模型列表、SSE 完成以及退出撤销均有覆盖。错误 nonce、提前结束的 SSE 被拒绝。测试确认 IndexedDB 存的是密文且退出后移除。 |
| 官方 Node 库 | `@siwc/local` 0.1.0 的 57 项 Node 测试通过。浏览器打包在 Node 内置模块和文件锁的依赖处失败。MVP 是按公开协议实现的浏览器适配。 [审计源码 0a36fef](https://github.com/openai/sign-in-with-chatgpt-devkit/tree/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/packages/local) |

2026-11-25 的真实测试验证了首次授权、换码、模型发现和单次推理。真实 token 到期后的轮换尚待单独验证。OpenAI 的公开文档目前描述了回环 TCP listener，DNR 桥接的结果是兼容性实测。 [OpenAI 注册文档](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) · [Chrome IndexedDB](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)

## 复现

测试版可从 Gitea 的「发行版」下载。解压测试 ZIP 后，在 Chrome 打开 `chrome://extensions`，启用「开发者模式」，点击「加载未打包的扩展程序」，选择包含 `manifest.json` 的解压目录。打开扩展选项页并选择「OpenAI 实验」，授权后获取模型列表并发送一条测试消息。

自动化测试使用 Chrome 和 Node.js 22.12+。`SIWC_CHROME` 可以指定另一个 Chrome 可执行文件。

```bash
npm ci
npm test
```

运行 `npm run preflight` 可复现两个端口的匿名 OpenAI 预检。该命令使用系统的 curl，只记录状态码和登录目标路径。

真实授权实验可以在 `chrome://extensions` 加载 `mvp/extension`，打开扩展选项页，选择「OpenAI 实验」及回调端口，然后打开 OpenAI 授权页。授权成功后回到选项页，先获取模型列表，再发送一次测试请求。实验结束时可点击「断开连接」。

模拟模式仅在开发测试时使用 `npm run mock` 提供的模拟 OAuth 和 API 服务。工装占用 18462，默认模拟回调端口 18463 无需监听。实际 OpenAI 实验无需运行这个服务。
