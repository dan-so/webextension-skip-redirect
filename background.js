/* global psl */
/* global url */
const MODE = "mode";
const MODE_OFF = "off";
const MODE_BLACKLIST = "blacklist";

const BLACKLIST = "blacklist";
const WHITELIST = "whitelist";

const CONTEXT_MENU_ID = "copy-last-source-url";

const NOTIFICATION_ID = "notify-skip";
const NOTIFICATION_POPUP_ENABLED = "notificationPopupEnabled";
const NOTIFICATION_DURATION = "notificationDuration";

const SKIP_REDIRECTS_TO_SAME_DOMAIN = "skipRedirectsToSameDomain";

const ICON           = "icon.svg";
const ICON_OFF       = "icon-off.svg";
const ICON_BLACKLIST = "icon-blacklist.svg";
const ICON_WHITELIST = "icon-whitelist.svg";

const MAX_NOTIFICATION_URL_LENGTH = 100;

const GLOBAL_BLACKLIST = [
    "archive\.org",
    "/abp",
    "/account",
    "/adfs",
    "/auth",
    "/cookie",
    "/download",
    "/login",
    "/logoff",
    "/logon",
    "/logout",
    "/oauth",
    "/preferences",
    "/profile",
    "/register",
    "/saml",
    "/signin",
    "/signoff",
    "/signon",
    "/signout",
    "/signup",
    "/sso",
    "/subscribe",
    "/verification",
];

let currentMode = undefined;
let blacklist = [];
let whitelist = [];

let lastSourceURL = undefined;

let notificationPopupEnabled = undefined;
let notificationDuration = undefined;

let skipRedirectsToSameDomain = false;

let notificationTimeout = undefined;

browser.storage.local.get([
    MODE,
    BLACKLIST,
    WHITELIST,
    NOTIFICATION_POPUP_ENABLED,
    NOTIFICATION_DURATION,
    SKIP_REDIRECTS_TO_SAME_DOMAIN,
])
    .then(
        (result) => {
            if (result[BLACKLIST] === undefined) {
                browser.storage.local.set({[BLACKLIST]: GLOBAL_BLACKLIST});
            } else {
                updateBlacklist(result[BLACKLIST]);
            }

            if (result[WHITELIST] === undefined) {
                browser.storage.local.set({[WHITELIST]: []});
            } else {
                updateWhitelist(result[WHITELIST]);
            }

            if (result[MODE] === undefined) {
                browser.storage.local.set({[MODE]: MODE_BLACKLIST});
            } else if (result[MODE] === MODE_OFF) {
                disableSkipping();
            } else {
                enableSkipping(result[MODE]);
            }

            if (result[NOTIFICATION_POPUP_ENABLED] === undefined) {
                browser.storage.local.set({[NOTIFICATION_POPUP_ENABLED]: true});
            } else {
                notificationPopupEnabled = result[NOTIFICATION_POPUP_ENABLED];
            }

            if (result[NOTIFICATION_DURATION] === undefined) {
                browser.storage.local.set({[NOTIFICATION_DURATION]: 3});
            } else {
                notificationDuration = result[NOTIFICATION_DURATION];
            }

            if (result[SKIP_REDIRECTS_TO_SAME_DOMAIN] === undefined) {
                browser.storage.local.set({[SKIP_REDIRECTS_TO_SAME_DOMAIN]: false});
            } else {
                skipRedirectsToSameDomain = result[SKIP_REDIRECTS_TO_SAME_DOMAIN];
            }

        }
    );

browser.storage.onChanged.addListener(
    (changes) => {
        if (changes[BLACKLIST]) {
            updateBlacklist(changes[BLACKLIST].newValue);
        }

        if (changes[WHITELIST]) {
            updateWhitelist(changes[WHITELIST].newValue);
        }

        if (changes[MODE]) {
            if (changes[MODE].newValue === MODE_OFF) {
                disableSkipping();
            } else {
                enableSkipping(changes[MODE].newValue);
            }
        }

        if (changes[NOTIFICATION_POPUP_ENABLED]) {
            notificationPopupEnabled = changes[NOTIFICATION_POPUP_ENABLED].newValue;
        }

        if (changes[NOTIFICATION_DURATION]) {
            notificationDuration = changes[NOTIFICATION_DURATION].newValue;
        }

        if (changes[SKIP_REDIRECTS_TO_SAME_DOMAIN]) {
            skipRedirectsToSameDomain = changes[SKIP_REDIRECTS_TO_SAME_DOMAIN].newValue;
        }

    }
);

browser.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: browser.i18n.getMessage("contextMenuLabel"),
    contexts: ["browser_action"],
    enabled: false,
});

browser.contextMenus.onClicked.addListener(
    (info, _tab) => {
        if (info.menuItemId === CONTEXT_MENU_ID) {
            copyLastSourceURLToClipboard();
        }
    }
);

function copyLastSourceURLToClipboard() {
    chainPromises([
        ()        => { return browser.tabs.executeScript({ code: "typeof copyToClipboard === 'function';" }); },
        (results) => { return injectScriptIfNecessary(results && results[0]); },
        ()        => { return browser.tabs.executeScript({ code: `copyToClipboard("${lastSourceURL}")` }); },
    ]);
}

function injectScriptIfNecessary(isCopyFunctionDefined) {
    if (!isCopyFunctionDefined) {
        return browser.tabs.executeScript({ file: "clipboard-helper.js" });
    }
}

function updateBlacklist(newBlacklist) {
    blacklist = newBlacklist.filter(Boolean);
}

function updateWhitelist(newWhitelist) {
    whitelist = newWhitelist.filter(Boolean);
}

function enableSkipping(mode) {
    browser.webRequest.onBeforeRequest.removeListener(maybeRedirect);

    currentMode = mode;
    if (mode === MODE_BLACKLIST) {
        browser.webRequest.onBeforeRequest.addListener(
            maybeRedirect,
            {urls: ["<all_urls>"], types: ["main_frame"]},
            ["blocking"]
        );
        browser.browserAction.setIcon({path: ICON_BLACKLIST});
    } else {
        if (whitelist.length > 0) {
            browser.webRequest.onBeforeRequest.addListener(
                maybeRedirect,
                {urls: whitelist, types: ["main_frame"]},
                ["blocking"]
            );
        }

        browser.browserAction.setIcon({path: ICON_WHITELIST});
    }

    browser.browserAction.setBadgeBackgroundColor({color: "red"});
    browser.browserAction.setTitle({title: browser.i18n.getMessage("browserActionLabelOn")});
}

function disableSkipping() {
    browser.webRequest.onBeforeRequest.removeListener(maybeRedirect);

    browser.browserAction.setIcon({path: ICON_OFF});
    browser.browserAction.setTitle({title: browser.i18n.getMessage("browserActionLabelOff")});
}

function maybeRedirect(requestDetails) {
    if (requestDetails.tabId === -1 || requestDetails.method === "POST") {
        return;
    }

    let exceptions = [];
    if (currentMode === MODE_BLACKLIST) {
        exceptions = blacklist;
    }

    const redirectTarget = url.getRedirectTarget(requestDetails.url, exceptions);
    if (redirectTarget === requestDetails.url) {
        return;
    }

    if (currentMode === MODE_BLACKLIST && !skipRedirectsToSameDomain) {
        let sourceHostname = getHostname(requestDetails.url);
        let targetHostname = getHostname(redirectTarget);
        let sourceDomain = psl.getDomain(sourceHostname);
        let targetDomain = psl.getDomain(targetHostname);
        if (sourceDomain === targetDomain) {
            return;
        }
    }

    prepareContextMenu(requestDetails.url);
    notifySkip(requestDetails.url, redirectTarget);

    return {
        redirectUrl: redirectTarget,
    };
}

function prepareContextMenu(from) {
    if (lastSourceURL === undefined) {
        browser.contextMenus.update(CONTEXT_MENU_ID, {enabled: true});
    }
    lastSourceURL = from;
}

function notifySkip(from, to) {
    if (notificationTimeout) {
        clearNotifications();
    }

    let notificationMessage = browser.i18n.getMessage("redirectSkippedNotificationMessage", [cleanUrl(from), cleanUrl(to)]);

    let toolbarButtonTitle = browser.i18n.getMessage("browserActionLabelOnSkipped", [from, to]);

    if (notificationPopupEnabled) {
        browser.notifications.create(NOTIFICATION_ID, {
            type: "basic",
            iconUrl: browser.extension.getURL(ICON),
            title: browser.i18n.getMessage("redirectSkippedNotificationTitle"),
            message: notificationMessage,
        });
    }
    browser.browserAction.setBadgeText({text: browser.i18n.getMessage("redirectSkippedBrowserActionBadge")});

    browser.browserAction.setTitle({title: toolbarButtonTitle});

    notificationTimeout = setTimeout(clearNotifications, 1000 * notificationDuration);
}

function clearNotifications() {
    clearTimeout(notificationTimeout);
    notificationTimeout = undefined;
    browser.notifications.clear(NOTIFICATION_ID);
    browser.browserAction.setBadgeText({text: ""});
}

function cleanUrl(string) {
    if (string.length > MAX_NOTIFICATION_URL_LENGTH) {
        string = string.substring(0, MAX_NOTIFICATION_URL_LENGTH - 3) + "...";
    }

    return string.replace(/&/g, "&amp;");
}

function getHostname(url) {
    var a = document.createElement("a");
    a.href = url;
    return a.hostname;
}

function chainPromises(functions) {
    let promise = Promise.resolve();
    for (let function_ of functions) {
        promise = promise.then(function_);
    }

    return promise.catch((error) => { console.warn(error.message); });
}
