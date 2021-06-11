import runStudy from "./study.js";
import { setupAuth, googleSignIn, emailSignIn } from "./auth.js";

setupAuth();

// Listen for login messages from the options UI.
chrome.runtime.onConnect.addListener(port => {
    port.onMessage.addListener(async message => {
        try {
            if ("email" in message && "password" in message) {
                await emailSignIn(message);
            } else if ("provider" in message && message.provider === "google") {
                const token = await googleSignIn();
                console.debug("Token:", token);
            }
        } catch (ex) {
            port.postMessage({ result: ex.message });
        }
    });
});

// FIXME - our webextension polyfill doesn't seem to be working, getting errors about `browser.*` missing in Chrome?!
// runStudy(__ENABLE_DEVELOPER_MODE__);

chrome.runtime.openOptionsPage();