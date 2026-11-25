import { registerSiwcBackground } from "./siwc/background.js";

registerSiwcBackground({ appName: chrome.runtime.getManifest().name, pages: ["index.html"] });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
