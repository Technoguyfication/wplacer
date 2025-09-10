const POLL_ALARM_NAME = 'wplacer-poll-alarm';
const COOKIE_ALARM_NAME = 'wplacer-cookie-alarm';

const getSettings = async () => {
    const result = await chrome.storage.local.get(['wplacerPort']);
    return {
        port: result.wplacerPort || 80,
        host: '127.0.0.1'
    };
};

const getServerUrl = async (path = '') => {
    const { host, port } = await getSettings();
    return `http://${host}:${port}${path}`;
};

let LP_ACTIVE = false;
let TOKEN_IN_PROGRESS = false;
let LAST_RELOAD_AT = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function startLongPoll() {
    if (LP_ACTIVE) return;
    LP_ACTIVE = true;
    while (LP_ACTIVE) {
        try {
            const url = await getServerUrl("/token-needed/long");
            const r = await fetch(url, { cache: "no-store" });
            if (r.ok) {
                const data = await r.json();
                if (data.needed) await maybeInitiateReload();
            } else {
                await wait(1000);
            }
        } catch (_) {
            await wait(2000);
        }
    }
}

const pollForTokenRequest = async () => {
    console.log("wplacer: Polling server for token request...");
    try {
        const url = await getServerUrl("/token-needed");
        const response = await fetch(url);
        if (!response.ok) {
            console.warn(`wplacer: Server poll failed with status: ${response.status}`);
            return;
        }
        const data = await response.json();
        if (data.needed) {
            console.log("wplacer: Server requires a token. Initiating reload.");
            await initiateReload();
        }
    } catch (error) {
        console.error("wplacer: Could not connect to the server to poll for tokens.", error.message);
    }
};

const maybeInitiateReload = async () => {
    const now = Date.now();
    if (TOKEN_IN_PROGRESS) return;
    if (now - LAST_RELOAD_AT < MIN_RELOAD_INTERVAL_MS) return;
    TOKEN_IN_PROGRESS = true;
    await initiateReload();
    LAST_RELOAD_AT = Date.now();
};

const initiateReload = async () => {
    try {
        let tabs = await chrome.tabs.query({ url: "https://wplace.live/*" });
        if (!tabs || tabs.length === 0) {
            console.warn("wplacer: No wplace.live tabs found. Opening a new one for token acquisition.");
            const created = await chrome.tabs.create({ url: "https://wplace.live/" });
            tabs = [created];
        }
        const targetTab = tabs.find(t => t.active) || tabs[0];
        console.log(`wplacer: Sending reload command to tab #${targetTab.id}`);
        await chrome.tabs.sendMessage(targetTab.id, { action: "reloadForToken" });
    } catch (error) {
        console.error("wplacer: Error sending reload message to tab, falling back to direct reload.", error);
        const tabs = await chrome.tabs.query({ url: "https://wplace.live/*" });
        if (tabs && tabs.length > 0) {
            chrome.tabs.reload((tabs.find(t => t.active) || tabs[0]).id);
        } else {
            await chrome.tabs.create({ url: "https://wplace.live/" });
        }
    }
};

const sendCookie = async (callback) => {
    const getCookie = (details) => new Promise(resolve => chrome.cookies.get(details, cookie => resolve(cookie)));

    const [jCookie, sCookie] = await Promise.all([
        getCookie({ url: "https://backend.wplace.live", name: "j" }),
        getCookie({ url: "https://backend.wplace.live", name: "s" })
    ]);

    if (!jCookie) {
        if (callback) callback({ success: false, error: "Cookie 'j' not found. Are you logged in?" });
        return;
    }

    const cookies = { j: jCookie.value };
    if (sCookie) cookies.s = sCookie.value;
    const url = await getServerUrl("/user");

    try {
        const masked = typeof jCookie.value === 'string' && jCookie.value.length > 10
            ? `${jCookie.value.slice(0, 6)}...${jCookie.value.slice(-4)}`
            : (jCookie.value || '').slice(0, 6);
        console.log(`wplacer: Sending j cookie to server (${masked}).`);
    } catch {}

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cookies, expirationDate: jCookie.expirationDate })
        });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        const userInfo = await response.json();
        console.log(`wplacer: Cookie 'j' update success for user: ${userInfo?.name || 'unknown'}.`);
        if (callback) callback({ success: true, name: userInfo.name });
    } catch (error) {
        console.warn(`wplacer: Failed to send j cookie: ${error?.message || error}`);
        if (callback) callback({ success: false, error: "Could not connect to the wplacer server." });
    }
};

const quickLogout = (callback) => {
    const origin = "https://backend.wplace.live/";
    console.log(`wplacer: Clearing browsing data for ${origin}`);
    chrome.browsingData.remove({
        origins: [origin]
    }, {
        cache: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        pluginData: true,
        serviceWorkers: true,
        webSQL: true
    }, () => {
        if (chrome.runtime.lastError) {
            console.error("wplacer: Error clearing browsing data.", chrome.runtime.lastError);
            if (callback) callback({ success: false, error: "Failed to clear data." });
        } else {
            console.log("wplacer: Browsing data cleared successfully. Reloading wplace.live tabs.");
            chrome.tabs.query({ url: "https://wplace.live/*" }, (tabs) => {
                if (tabs && tabs.length > 0) {
                    tabs.forEach(tab => chrome.tabs.reload(tab.id));
                }
            });
            if (callback) callback({ success: true });
        }
    });
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "sendCookie") {
        sendCookie(sendResponse);
        return true;
    }
    if (request.action === "quickLogout") {
        quickLogout(sendResponse);
        return true;
    }
    if (request.action === "settingsUpdated") {
        LP_ACTIVE = false;
        setTimeout(startLongPoll, 100);
        if (sendResponse) sendResponse({ ok: true });
        return false;
    }
    if (request.action === "injectPawtect") {
        try {
            if (sender.tab?.id) {
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: () => {
                        if (window.__wplacerPawtectHooked) return;
                        window.__wplacerPawtectHooked = true;

                        const backend = 'https://backend.wplace.live';
                        const resolvePawtectChunkUrl = async () => {
                            try {
                                if (window.__wplacerPawtectChunk && typeof window.__wplacerPawtectChunk === 'string') return window.__wplacerPawtectChunk;
                                const cached = localStorage.getItem('wplacerPawtectChunk');
                                if (cached) { window.__wplacerPawtectChunk = cached; return cached; }

                                const urls = new Set();
                                Array.from(document.querySelectorAll('script[src]')).forEach(s => { try { urls.add(new URL(s.src, location.href).href); } catch {} });
                                Array.from(document.querySelectorAll('link[rel="modulepreload"][href], link[as="script"][href]')).forEach(l => { try { urls.add(new URL(l.href, location.href).href); } catch {} });
                                try { (performance.getEntriesByType('resource') || []).forEach(e => { if (e && typeof e.name === 'string') urls.add(e.name); }); } catch {}

                                const scripts = Array.from(urls).filter(src => /\/_app\/immutable\/chunks\/.*\.js(\?.*)?$/i.test(src));
                                console.log('wplacer: pawtect chunk candidates', scripts);

                                for (const src of scripts) {
                                    try {
                                        const text = await fetch(src, { credentials: 'omit' }).then(r => r.text());
                                        if (/get_pawtected_endpoint_payload|pawtect/i.test(text)) {
                                            localStorage.setItem('wplacerPawtectChunk', src);
                                            window.__wplacerPawtectChunk = src;
                                            return src;
                                        }
                                    } catch {}
                                }
                                return null;
                            } catch { return null; }
                        };
                        const importModule = async () => {
                            const discovered = await resolvePawtectChunkUrl();
                            console.log('wplacer: pawtect chunk discovered', discovered);
                            const candidates = [];
                            if (discovered) candidates.push(discovered);
                            candidates.push(new URL('/_app/immutable/chunks/BdJF80pX.js', location.origin).href);
                            candidates.push('https://wplace.live/_app/immutable/chunks/BdJF80pX.js');
                            let lastErr;
                            for (const url of candidates) { try { return await import(url); } catch (e) { lastErr = e; } }
                            console.warn('pawtect: module import failed', lastErr?.message || lastErr);
                            return null;
                        };

                        const computePawtect = async (url, bodyStr) => {
                            const mod = await importModule();
                            if (!mod || typeof mod._ !== 'function') return null;
                            const wasm = await mod._();
                            try {
                                const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                                if (me?.id && typeof mod.i === 'function') mod.i(me.id);
                            } catch {}
                            if (typeof mod.r === 'function') mod.r(url);
                            const enc = new TextEncoder();
                            const dec = new TextDecoder();
                            const bytes = enc.encode(bodyStr);
                            const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                            new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                            const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                            let token;
                            if (Array.isArray(out)) {
                                const [outPtr, outLen] = out;
                                token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                try { wasm.__wbindgen_free(outPtr, outLen, 1); } catch {}
                            } else if (typeof out === 'string') {
                                token = out;
                            } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {}
                            } else {
                                console.warn('wplacer: unexpected pawtect out shape', typeof out);
                                token = null;
                            }
                            window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'pixel' }, '*');
                            return token;
                        };

                        const originalFetch = window.fetch.bind(window);
                        window.fetch = async (...args) => {
                            try {
                                const input = args[0];
                                const init = args[1] || {};
                                const req = new Request(input, init);
                                if (req.method === 'POST' && /\/s0\/pixel\//.test(req.url)) {
                                    const raw = typeof init.body === 'string' ? init.body : null;
                                    if (raw) {
                                        computePawtect(req.url, raw);
                                    } else {
                                        try {
                                            const clone = req.clone();
                                            const text = await clone.text();
                                            computePawtect(req.url, text);
                                        } catch {}
                                    }
                                }
                            } catch {}
                            return originalFetch(...args);
                        };
                        try {
                            const origOpen = XMLHttpRequest.prototype.open;
                            const origSend = XMLHttpRequest.prototype.send;
                            XMLHttpRequest.prototype.open = function(method, url) {
                                try {
                                    this.__wplacer_url = new URL(url, location.href).href;
                                    this.__wplacer_method = String(method || '');
                                } catch {}
                                return origOpen.apply(this, arguments);
                            };
                            XMLHttpRequest.prototype.send = function(body) {
                                try {
                                    if ((this.__wplacer_method || '').toUpperCase() === 'POST' && /\/s0\/pixel\//.test(this.__wplacer_url || '')) {
                                        const url = this.__wplacer_url;
                                        const maybeCompute = (raw) => { if (raw && typeof raw === 'string') computePawtect(url, raw); };
                                        if (typeof body === 'string') {
                                            maybeCompute(body);
                                        } else if (body instanceof ArrayBuffer) {
                                            try { const s = new TextDecoder().decode(new Uint8Array(body)); maybeCompute(s); } catch {}
                                        } else if (body && typeof body === 'object' && 'buffer' in body && body.buffer instanceof ArrayBuffer) {
                                            try { const s = new TextDecoder().decode(new Uint8Array(body.buffer)); maybeCompute(s); } catch {}
                                        } else if (body && typeof body.text === 'function') {
                                            try { body.text().then(s => { maybeCompute(s); }).catch(() => {}); } catch {}
                                        }
                                    }
                                } catch {}
                                return origSend.apply(this, arguments);
                            };
                        } catch {}
                    }
                });
            }
        } catch (e) {
            console.error('wplacer: failed to inject pawtect hook', e);
        }
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === 'seedPawtect') {
        try {
            if (sender.tab?.id) {
                const bodyStr = String(request.bodyStr || '{"colors":[0],"coords":[1,1],"fp":"seed","t":"seed"}');
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: (rawBody) => {
                        (async () => {
                            try {
                                const backend = 'https://backend.wplace.live';
                                const url = `${backend}/s0/pixel/1/1`;
                                const resolvePawtectChunkUrl = async () => {
                                    try {
                                        if (window.__wplacerPawtectChunk && typeof window.__wplacerPawtectChunk === 'string') return window.__wplacerPawtectChunk;
                                        const cached = localStorage.getItem('wplacerPawtectChunk');
                                        if (cached) { window.__wplacerPawtectChunk = cached; return cached; }
                                        const urls = new Set();
                                        Array.from(document.querySelectorAll('script[src]')).forEach(s => { try { urls.add(new URL(s.src, location.href).href); } catch {} });
                                        Array.from(document.querySelectorAll('link[rel="modulepreload"][href], link[as="script"][href]')).forEach(l => { try { urls.add(new URL(l.href, location.href).href); } catch {} });
                                        try { (performance.getEntriesByType('resource') || []).forEach(e => { if (e && typeof e.name === 'string') urls.add(e.name); }); } catch {}
                                        const scripts = Array.from(urls).filter(src => /\/_app\/immutable\/chunks\/.*\.js(\?.*)?$/i.test(src));
                                        for (const src of scripts) {
                                            try { const text = await fetch(src, { credentials: 'omit' }).then(r => r.text()); if (/get_pawtected_endpoint_payload|pawtect/i.test(text)) { localStorage.setItem('wplacerPawtectChunk', src); window.__wplacerPawtectChunk = src; return src; } } catch {}
                                        }
                                        return null;
                                    } catch { return null; }
                                };
                                const discovered = await resolvePawtectChunkUrl();
                                const mod = discovered ? await import(discovered) : await import('/_app/immutable/chunks/BdJF80pX.js');
                                const wasm = await mod._();
                                try {
                                    const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                                    if (me?.id && typeof mod.i === 'function') mod.i(me.id);
                                } catch {}
                                if (typeof mod.r === 'function') mod.r(url);
                                const enc = new TextEncoder();
                                const dec = new TextDecoder();
                                const bytes = enc.encode(rawBody);
                                const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                                new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                                const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                                let token;
                                if (Array.isArray(out)) {
                                    const [outPtr, outLen] = out;
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                    try { wasm.__wbindgen_free(outPtr, outLen, 1); } catch {}
                                } else if (typeof out === 'string') {
                                    token = out;
                                } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                    try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {}
                                }
                                window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'seed' }, '*');
                            } catch {}
                        })();
                    },
                    args: [bodyStr]
                });
            }
        } catch {}
        sendResponse({ ok: true });
        return true;
    }
    if (request.action === 'computePawtectForT') {
        try {
            if (sender.tab?.id) {
                const turnstile = typeof request.bodyStr === 'string' ? (()=>{ try { return JSON.parse(request.bodyStr).t || ''; } catch { return ''; } })() : '';
                chrome.scripting.executeScript({
                    target: { tabId: sender.tab.id },
                    world: 'MAIN',
                    func: (tValue) => {
                        (async () => {
                            try {
                                const backend = 'https://backend.wplace.live';
                                const resolvePawtectChunkUrl = async () => {
                                    try {
                                        if (window.__wplacerPawtectChunk && typeof window.__wplacerPawtectChunk === 'string') return window.__wplacerPawtectChunk;
                                        const urls = new Set();
                                        Array.from(document.querySelectorAll('script[src]')).forEach(s => { try { urls.add(new URL(s.src, location.href).href); } catch {} });
                                        Array.from(document.querySelectorAll('link[rel="modulepreload"][href], link[as="script"][href]')).forEach(l => { try { urls.add(new URL(l.href, location.href).href); } catch {} });
                                        try { (performance.getEntriesByType('resource') || []).forEach(e => { if (e && typeof e.name === 'string') urls.add(e.name); }); } catch {}
                                        const scripts = Array.from(urls).filter(src => /\/_app\/immutable\/chunks\/.*\.js(\?.*)?$/i.test(src));
                                        for (const src of scripts) {
                                            try { const text = await fetch(src, { credentials: 'omit' }).then(r => r.text()); if (/get_pawtected_endpoint_payload|pawtect/i.test(text)) { window.__wplacerPawtectChunk = src; return src; } } catch {}
                                        }
                                        return null;
                                    } catch { return null; }
                                };
                                const discovered = await resolvePawtectChunkUrl();
                                const mod = discovered ? await import(discovered) : await import('/_app/immutable/chunks/BdJF80pX.js');
                                const wasm = await mod._();
                                try {
                                    const me = await fetch(`${backend}/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
                                    if (me?.id && typeof mod.i === 'function') mod.i(me.id);
                                } catch {}
                                const url = `${backend}/s0/pixel/1/1`;
                                if (typeof mod.r === 'function') mod.r(url);
                                const fp = (window.wplacerFP && String(window.wplacerFP)) || (()=>{
                                    const b = new Uint8Array(16); crypto.getRandomValues(b); return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
                                })();
                                const rx = Math.floor(Math.random()*1000);
                                const ry = Math.floor(Math.random()*1000);
                                const bodyObj = { colors:[0], coords:[rx,ry], fp, t: String(tValue||'') };
                                const rawBody = JSON.stringify(bodyObj);
                                const enc = new TextEncoder();
                                const dec = new TextDecoder();
                                const bytes = enc.encode(rawBody);
                                const inPtr = wasm.__wbindgen_malloc(bytes.length, 1);
                                new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
                                const out = wasm.get_pawtected_endpoint_payload(inPtr, bytes.length);
                                let token;
                                if (Array.isArray(out)) {
                                    const [outPtr, outLen] = out;
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
                                    try { wasm.__wbindgen_free(outPtr, outLen, 1); } catch {}
                                } else if (typeof out === 'string') {
                                    token = out;
                                } else if (out && typeof out.ptr === 'number' && typeof out.len === 'number') {
                                    token = dec.decode(new Uint8Array(wasm.memory.buffer, out.ptr, out.len));
                                    try { wasm.__wbindgen_free(out.ptr, out.len, 1); } catch {}
                                }
                                window.postMessage({ type: 'WPLACER_PAWTECT_TOKEN', token, origin: 'simple' }, '*');
                            } catch {}
                        })();
                    },
                    args: [turnstile]
                });
            }
        } catch {}
        sendResponse({ ok: true });
        return true;
    }
    if (request.type === "SEND_TOKEN") {
        getServerUrl("/t").then(url => {
            fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    t: request.token,
                    pawtect: request.pawtect || null,
                    fp: request.fp || null
                })
            });
        });
        TOKEN_IN_PROGRESS = false;
        LAST_RELOAD_AT = Date.now();
    }
    return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url?.startsWith("https://wplace.live")) {
        console.log("wplacer: wplace.live tab loaded. Sending cookie.");
        sendCookie(response => console.log(`wplacer: Cookie send status: ${response.success ? 'Success' : 'Failed'}`));
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === COOKIE_ALARM_NAME) {
        console.log("wplacer: Periodic alarm triggered. Sending cookie.");
        sendCookie(response => console.log(`wplacer: Periodic cookie refresh: ${response.success ? 'Success' : 'Failed'}`));
    } else if (alarm.name === POLL_ALARM_NAME) {
        if (!LP_ACTIVE) startLongPoll();
        pollForTokenRequest();
    }
});

const initializeAlarms = () => {
    chrome.alarms.create(POLL_ALARM_NAME, {
        delayInMinutes: 0.1,
        periodInMinutes: 0.75
    });
    chrome.alarms.create(COOKIE_ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: 20
    });
    console.log("wplacer: Alarms initialized.");
};

chrome.runtime.onStartup.addListener(() => {
    console.log("wplacer: Browser startup.");
    initializeAlarms();
    startLongPoll();
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("wplacer: Extension installed/updated.");
    initializeAlarms();
    startLongPoll();
});

startLongPoll();


