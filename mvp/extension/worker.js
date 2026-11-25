import { registerSiwcBackground } from "./siwc/background.js";

registerSiwcBackground({ appName: "SIWC Chrome MVP", pages: ["index.html"] });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
