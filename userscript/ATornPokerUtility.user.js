// ==UserScript==
// @name         ATornPokerUtility
// @namespace    zulu.atornpoker.utility
// @version      4.9.5
// @description  Torn Poker HUD with whitelist auth and server stats (PDA compatible)
// @match        https://www.torn.com/page.php?sid=holdem*
// @match        https://www.torn.com/pda.php?sid=holdem*
// @match        https://www.torn.com/loader.php?sid=holdem*
// @match        https://www.torn.com/*sid=holdem*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      torn-poker-server-production.up.railway.app
// @connect      api.torn.com
// @run-at       document-start
// @license      UNLICENSED
// @downloadURL  https://update.greasyfork.org/scripts/571444/ATornPokerUtility.user.js
// @updateURL    https://update.greasyfork.org/scripts/571444/ATornPokerUtility.meta.js
// ==/UserScript==

(function () {
"use strict";

const globalWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
if (globalWindow.__A_TPU__) return;
globalWindow.__A_TPU__ = true;

const SERVER = "https://torn-poker-server-production.up.railway.app";
const SCRIPT_VERSION = "4.9.2";

const LS = {
    token: "atpu.publicToken",
    authorized: "atpu.authorized",
    tornApiKey: "atpu.tornApiKey",
    hudVisible: "atpu.hudVisible"
};

const STATE = {
    sessionId: null,
    sessionStarting: false,
    eventQueue: [],
    tables: {},
    activeTableId: null,
    authorized: false,
    publicToken: null,
    started: false,
    lastFlush: "-",
    authCheckedAt: 0,
    hudVisible: true,
    pageVisible: true
};

const PLAYER_STATS = {};
const LAST_ACTION = {};

function req(method, url, headers, body, cb) {
    GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: r => cb(null, r),
        onerror: () => cb(true),
        ontimeout: () => cb(true)
    });
}

function api(path, method, body, cb) {
    const headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + STATE.publicToken
    };
    req(method, SERVER + path, headers, body, cb);
}

function safeParse(text, fallback = {}) {
    try { return JSON.parse(text); } catch { return fallback; }
}

function isPageActive() {
    return !document.hidden && document.hasFocus();
}

function saveAuthState() {
    try {
        if (STATE.publicToken) localStorage.setItem(LS.token, STATE.publicToken);
        localStorage.setItem(LS.authorized, STATE.authorized ? "true" : "false");
    } catch {}
}

function loadAuthState() {
    try {
        STATE.publicToken = localStorage.getItem(LS.token) || null;
        STATE.authorized = localStorage.getItem(LS.authorized) === "true" && !!STATE.publicToken;
    } catch {}
}

function clearAuthState() {
    STATE.authorized = false;
    STATE.publicToken = null;
    STATE.sessionId = null;
    STATE.sessionStarting = false;
    STATE.eventQueue = [];
    try {
        localStorage.removeItem(LS.token);
        localStorage.setItem(LS.authorized, "false");
    } catch {}
}

function saveLocalApiKey(key) {
    try {
        localStorage.setItem(LS.tornApiKey, key || "");
    } catch {}
}

function loadLocalApiKey() {
    try {
        return localStorage.getItem(LS.tornApiKey) || "";
    } catch {
        return "";
    }
}

function saveHudVisible(value) {
    STATE.hudVisible = !!value;
    try {
        localStorage.setItem(LS.hudVisible, STATE.hudVisible ? "true" : "false");
    } catch {}
}

function loadHudVisible() {
    try {
        STATE.hudVisible = localStorage.getItem(LS.hudVisible) !== "false";
    } catch {
        STATE.hudVisible = true;
    }
}

function ensureTable(tableId) {
    const key = String(tableId);
    if (!STATE.tables[key]) {
        STATE.tables[key] = {
            id: key,
            playersById: {},
            currentHandId: null
        };
    }
    return STATE.tables[key];
}

function ensurePlayerStats(userId, name) {
    const id = String(userId);
    if (!PLAYER_STATS[id]) {
        PLAYER_STATS[id] = {
            name: name || ("ID " + id),
            hands: 0,
            vpipHands: 0,
            pfrHands: 0
        };
    } else if (name) {
        PLAYER_STATS[id].name = name;
    }
    return PLAYER_STATS[id];
}

function parseMoney(text) {
    if (text == null) return null;
    const cleaned = String(text).replace(/[$,\s]/g, "");
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
}

function formatMoneyShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    if (n >= 1000000000) return (n / 1000000000).toFixed(2).replace(/\.00$/, "") + "B";
    if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\.00$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(Math.round(n));
}

function resetTableSession(newTableId) {
    STATE.sessionId = null;
    STATE.sessionStarting = false;
    STATE.eventQueue = [];

    Object.keys(LAST_ACTION).forEach(k => delete LAST_ACTION[k]);

    STATE.activeTableId = String(newTableId);

    renderMenuStatus();
}

function switchActiveTable(tableId) {
    const nextId = String(tableId);
    if (!STATE.activeTableId) {
        STATE.activeTableId = nextId;
        renderMenuStatus();
        return;
    }

    if (STATE.activeTableId !== nextId) {
        resetTableSession(nextId);
    }
}

function bootstrap(ownerId) {
    req("POST", SERVER + "/api/public/bootstrap", {
        "Content-Type": "application/json"
    }, {
        owner_torn_id: ownerId,
        script_version: SCRIPT_VERSION
    }, (err, res) => {
        if (err || res.status !== 200) {
            updateAuthStatus("Authorization failed.", "#f87171");
            return;
        }

        const data = safeParse(res.responseText, {});
        if (!data.session_token) {
            updateAuthStatus("Authorization denied.", "#f87171");
            return;
        }

        STATE.publicToken = data.session_token;
        STATE.authorized = true;
        saveAuthState();
        updateAuthStatus("Status: authorized", "#4ade80");

        if (STATE.activeTableId && !STATE.sessionId && isPageActive()) {
            startSession();
        }

        renderMenuStatus();
    });
}

function updateAuthStatus(message, color) {
    const el = document.getElementById("atpu-auth-status");
    if (!el) return;
    el.textContent = message;
    if (color) el.style.color = color;
}

function startSession() {
    if (!isPageActive()) return;
    if (!STATE.publicToken || !STATE.activeTableId || STATE.sessionId || STATE.sessionStarting) return;

    STATE.sessionStarting = true;
    renderMenuStatus();

    api("/api/public/sessions/start", "POST", {
        table_id: String(STATE.activeTableId),
        source_url: location.href
    }, (err, res) => {
        STATE.sessionStarting = false;

        if (err || res.status !== 200) {
            if (res && res.status === 401) clearAuthState();
            renderMenuStatus();
            return;
        }

        const data = safeParse(res.responseText, {});
        STATE.sessionId = data.session_id || null;
        renderMenuStatus();
    });
}

function flush() {
    if (!isPageActive()) return;
    if (!STATE.sessionId || !STATE.eventQueue.length) return;

    const batch = STATE.eventQueue.splice(0, 50);

    api("/api/public/events", "POST", {
        session_id: STATE.sessionId,
        events: batch
    }, (err, res) => {
        if (err || res.status !== 200) {
            STATE.lastFlush = "failed";
            STATE.eventQueue = batch.concat(STATE.eventQueue);
            if (res && res.status === 401) clearAuthState();
            renderMenuStatus();
            return;
        }

        STATE.lastFlush = "ok " + batch.length;
        renderMenuStatus();
    });
}

function loadStatsFromServer() {
    if (!isPageActive()) return;
    if (!STATE.authorized || !STATE.publicToken || !STATE.activeTableId) return;

    api(`/api/public/stats/table?table_id=${encodeURIComponent(String(STATE.activeTableId))}`, "GET", null, (err, res) => {
        if (err || res.status !== 200) {
            if (res && res.status === 401) clearAuthState();
            renderMenuStatus();
            return;
        }

        const data = safeParse(res.responseText, {});
        if (!Array.isArray(data.stats)) return;

        data.stats.forEach(row => {
            const id = String(row.player_id);
            const hands = Number(row.hands) || 0;
            const vpip = Number(row.vpip) || 0;
            const pfr = Number(row.pfr) || 0;

            PLAYER_STATS[id] = {
                name: row.player_name || PLAYER_STATS[id]?.name || ("ID " + id),
                hands,
                vpipHands: (vpip / 100) * hands,
                pfrHands: (pfr / 100) * hands
            };
        });

        renderHUD();
        renderMenuStatus();
    });
}

function mapStatusToType(status) {
    const s = String(status || "").toLowerCase().trim();

    if (
        s.includes("blind") ||
        s.includes("waiting") ||
        s.includes("thinking") ||
        s.includes("dealer") ||
        s.includes("active")
    ) return null;

    if (s.includes("fold")) return "fold";
    if (s.includes("check")) return "check";
    if (s.includes("call")) return "call";
    if (s.includes("raise")) return "raise";
    if (s === "bet" || s.includes(" bet")) return "bet";
    if (s.includes("all in")) return "allin";

    return null;
}

function queue(tableId, ev) {
    if (!isPageActive()) return;
    if (!STATE.authorized) return;
    if (String(tableId) !== String(STATE.activeTableId)) return;

    const handRef = ev.hand_id || null;

    STATE.eventQueue.push({
        table_id: String(tableId),
        type: ev.type,
        player_id: ev.player_id,
        player_name: ev.player_name,
        amount: ev.amount || null,
        stack_before: ev.stack_before || null,
        stack_after: ev.stack_after || null,
        hand_id: handRef,
        event_ts: Date.now(),
        metadata: {
            raw_hand_ref: handRef
        }
    });

    renderMenuStatus();
}

function getStyle(vpip, pfr, hands) {
    if (!hands) return { l: "NEW", c: "#aaa" };
    if (vpip < 15) return { l: "NIT", c: "#60a5fa" };
    if (vpip < 26) return { l: "TAG", c: "#22c55e" };
    if (vpip > 30 && pfr < 12) return { l: "CALL", c: "#eab308" };
    if (vpip > 26 && pfr >= 18) return { l: "LAG", c: "#f97316" };
    return { l: "FISH", c: "#ef4444" };
}

function renderHUD() {
    document.querySelectorAll("[id^='player-']").forEach(box => {
        const id = box.id.replace("player-", "");
        const s = PLAYER_STATS[id];
        if (!s) return;

        const currentTable = STATE.tables[String(STATE.activeTableId || "")];
        const livePlayer = currentTable?.playersById?.[id] || null;
        const liveStack = livePlayer?.stack ?? null;

        let hud = box.querySelector(".atpu-hud");
        if (!hud) {
            hud = document.createElement("div");
            hud.className = "atpu-hud";

            Object.assign(hud.style, {
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                background: "rgba(0,0,0,0.86)",
                color: "#fff",
                fontSize: "10px",
                lineHeight: "1.12",
                padding: "4px 6px",
                borderRadius: "8px",
                zIndex: 9999,
                pointerEvents: "none",
                textAlign: "center",
                minWidth: "58px",
                maxWidth: "76px",
                border: "1px solid rgba(255,255,255,0.08)"
            });

            if (getComputedStyle(box).position === "static") {
                box.style.position = "relative";
            }

            box.appendChild(hud);
        }

        hud.style.display = STATE.hudVisible ? "block" : "none";
        if (!STATE.hudVisible) return;

        const vpip = s.hands ? (s.vpipHands / s.hands * 100) : 0;
        const pfr = s.hands ? (s.pfrHands / s.hands * 100) : 0;
        const st = getStyle(vpip, pfr, s.hands);

        hud.innerHTML =
            `<div style="font-weight:700;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}</div>` +
            `<div style="color:${st.c};font-weight:700;margin-top:1px;">${st.l}</div>` +
            `<div style="margin-top:1px;">${vpip.toFixed(0)} / ${pfr.toFixed(0)}</div>` +
            `<div>H:${s.hands}</div>` +
            `<div style="margin-top:1px;color:#d1d5db;">$${formatMoneyShort(liveStack)}</div>`;
    });
}

function detectActions(tableId, table, oldPlayers, msg) {
    Object.values(table.playersById).forEach(player => {
        const prev = oldPlayers[player.id];
        if (!prev) return;

        const oldStatus = String(prev.status || "").trim();
        const newStatus = String(player.status || "").trim();
        if (!oldStatus || !newStatus || oldStatus === newStatus) return;

        const type = mapStatusToType(newStatus);
        if (!type) return;

        const dedupeKey = `${tableId}_${player.id}_${type}_${table.currentHandId || "nohand"}`;
        if (LAST_ACTION[dedupeKey]) return;
        LAST_ACTION[dedupeKey] = true;

        queue(tableId, {
            type,
            player_id: Number(player.id),
            player_name: player.name,
            amount: msg.amountCall || null,
            stack_before: prev.stack,
            stack_after: player.stack,
            hand_id: table.currentHandId || null
        });
    });
}

function updatePlayersFromState(tableId, msg) {
    const table = ensureTable(tableId);
    const oldPlayers = {};

    Object.entries(table.playersById).forEach(([id, row]) => {
        oldPlayers[id] = { ...row };
    });

    table.currentHandId = String(msg.token || msg.gameToken || msg.handId || msg.hand_id || table.currentHandId || "");

    const fresh = {};
    Object.entries(msg.players || {}).forEach(([seat, p]) => {
        if (!p || !p.userID) return;
        const uid = String(p.userID);
        const name = p.playername || p.name || ("ID " + uid);

        fresh[uid] = {
            id: uid,
            name,
            seat,
            status: p.status || null,
            stack: parseMoney(p.money)
        };
        ensurePlayerStats(uid, name);
    });

    table.playersById = fresh;
    detectActions(tableId, table, oldPlayers, msg);
}

function updateFromUpdatePlayer(tableId, msg) {
    const table = ensureTable(tableId);
    const oldPlayers = {};

    Object.entries(table.playersById).forEach(([id, row]) => {
        oldPlayers[id] = { ...row };
    });

    const playersObj = msg.player || msg.players || {};
    Object.entries(playersObj).forEach(([seat, p]) => {
        if (!p || !p.userID) return;
        const uid = String(p.userID);
        const name = p.playername || p.name || ("ID " + uid);

        table.playersById[uid] = {
            id: uid,
            name,
            seat,
            status: p.status || null,
            stack: parseMoney(p.money)
        };
        ensurePlayerStats(uid, name);
    });

    table.currentHandId = String(msg.token || msg.gameToken || msg.handId || msg.hand_id || table.currentHandId || "");
    detectActions(tableId, table, oldPlayers, msg);
}

function handleHoldemMessage(parsed) {
    const channel = parsed?.push?.channel;
    const msg = parsed?.push?.pub?.data?.message;
    if (!channel || !msg) return;

    const m = String(channel).match(/^holdem(\d+)$/);
    if (!m) return;

    const tableId = m[1];

    if (!isPageActive()) return;

    switchActiveTable(tableId);

    if (STATE.authorized && !STATE.sessionId && !STATE.sessionStarting) {
        startSession();
    }

    if (!STATE.authorized) return;

    const eventType = msg.eventType || "";
    if (eventType === "getState" || eventType === "playerMakeMove") {
        updatePlayersFromState(tableId, msg);
        renderHUD();
        return;
    }

    if (eventType === "updatePlayer") {
        updateFromUpdatePlayer(tableId, msg);
        renderHUD();
    }
}

function installWS() {
    const OriginalWebSocket = globalWindow.WebSocket;
    if (!OriginalWebSocket) return;

    const WrappedWebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args) {
            const ws = new target(...args);
            ws.addEventListener("message", e => {
                if (!isPageActive()) return;
                if (typeof e.data !== "string") return;

                const parsed = safeParse(e.data, null);
                if (!parsed) return;

                const channel = parsed?.push?.channel;
                if (!channel) return;

                if (/^holdem\d+$/.test(channel)) {
                    handleHoldemMessage(parsed);
                }
            });
            return ws;
        }
    });

    globalWindow.WebSocket = WrappedWebSocket;
}

function authorizeFromKey(key) {
    req("GET", `https://api.torn.com/user/?selections=basic&key=${encodeURIComponent(key)}`, {}, null, (err, res) => {
        if (err || res.status !== 200) {
            updateAuthStatus("Authorization failed: invalid key.", "#f87171");
            return alert("Invalid key");
        }

        const data = safeParse(res.responseText, {});
        if (!data.player_id) {
            updateAuthStatus("Authorization failed: missing player_id.", "#f87171");
            return alert("Unable to read player_id from Torn response");
        }

        saveLocalApiKey(key);
        bootstrap(data.player_id);
    });
}

function renderMenuStatus() {
    const el = document.getElementById("atpu-menu-status");
    if (!el) return;

    const authDot = STATE.authorized ? "#22c55e" : "#ef4444";
    const sessionDot = STATE.sessionId ? "#22c55e" : (STATE.sessionStarting ? "#f59e0b" : "#ef4444");
    const queueDot = STATE.eventQueue.length ? "#f59e0b" : "#22c55e";
    const hudDot = STATE.hudVisible ? "#22c55e" : "#6b7280";
    const pageDot = isPageActive() ? "#22c55e" : "#ef4444";

    el.innerHTML =
        `<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">` +
            `<div style="display:flex;align-items:center;gap:8px;">` +
                `<span style="width:8px;height:8px;border-radius:50%;background:${authDot};display:inline-block;"></span>` +
                `<span>AUTH</span>` +
            `</div>` +
            `<div style="display:flex;align-items:center;gap:8px;">` +
                `<span style="width:8px;height:8px;border-radius:50%;background:${sessionDot};display:inline-block;"></span>` +
                `<span>SESSION</span>` +
            `</div>` +
            `<div style="display:flex;align-items:center;gap:8px;">` +
                `<span style="width:8px;height:8px;border-radius:50%;background:${queueDot};display:inline-block;"></span>` +
                `<span>Q: ${STATE.eventQueue.length}</span>` +
            `</div>` +
            `<div style="display:flex;align-items:center;gap:8px;">` +
                `<span style="width:8px;height:8px;border-radius:50%;background:${hudDot};display:inline-block;"></span>` +
                `<span>HUD: ${STATE.hudVisible ? "ON" : "OFF"}</span>` +
            `</div>` +
            `<div style="display:flex;align-items:center;gap:8px;">` +
                `<span style="width:8px;height:8px;border-radius:50%;background:${pageDot};display:inline-block;"></span>` +
                `<span>PAGE: ${isPageActive() ? "ACTIVE" : "BACKGROUND"}</span>` +
            `</div>` +
            `<div style="opacity:0.8;">T: ${STATE.activeTableId || "-"}</div>` +
        `</div>`;
}

function setHudVisible(value) {
    saveHudVisible(value);
    renderHUD();
    renderMenuStatus();

    const btn = document.getElementById("atpu-hud-toggle");
    if (btn) {
        btn.textContent = STATE.hudVisible ? "HUD ON" : "HUD OFF";
        btn.style.background = STATE.hudVisible ? "#15803d" : "#444";
    }
}

function mountButton() {
    if (!document.body || document.getElementById("atpu-auth-btn")) return;

    const btn = document.createElement("button");
    btn.id = "atpu-auth-btn";
    btn.textContent = "AT";

    Object.assign(btn.style, {
        position: "fixed",
        left: "10px",
        bottom: "10px",
        zIndex: 999999,
        width: "40px",
        height: "34px",
        borderRadius: "50%",
        background: "#000",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.15)",
        fontWeight: "700"
    });

    const modal = document.createElement("div");
    modal.id = "atpu-auth-modal";
    Object.assign(modal.style, {
        display: "none",
        position: "fixed",
        inset: "0",
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000000
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
        position: "absolute",
        left: "10px",
        bottom: "56px",
        width: "min(360px, calc(100vw - 20px))",
        background: "#101726",
        color: "#fff",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.10)",
        padding: "12px",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 10px 28px rgba(0,0,0,0.45)"
    });

    panel.innerHTML = `
        <div style="font-weight:700;margin-bottom:8px;">ATornPokerUtility</div>
        <div id="atpu-auth-status" style="font-size:12px;opacity:0.9;margin-bottom:8px;color:#cbd5e1;">Status: not authorized</div>

        <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=ATornPokerUtility&user=basic"
           target="_blank"
           style="display:inline-block;margin-bottom:8px;color:#9fd4ff;">Create custom API key (basic / owner id)</a>

        <input id="atpu-key-input" type="password" placeholder="Paste Torn custom API key"
               style="width:100%;padding:8px;border-radius:8px;border:none;background:#1a2336;color:#fff;margin-bottom:10px;">

        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <button id="atpu-auth-run" style="padding:8px 10px;border:none;border-radius:8px;background:#335eea;color:#fff;font-weight:700;">Authorize</button>
            <button id="atpu-hud-toggle" style="padding:8px 10px;border:none;border-radius:8px;background:#15803d;color:#fff;font-weight:700;">HUD ON</button>
            <button id="atpu-auth-logout" style="padding:8px 10px;border:none;border-radius:8px;background:#b91c1c;color:#fff;">Logout</button>
            <button id="atpu-auth-close" style="padding:8px 10px;border:none;border-radius:8px;background:#444;color:#fff;">Close</button>
        </div>

        <div id="atpu-menu-status"
             style="padding:10px;border-radius:10px;background:#0b1220;border:1px solid rgba(255,255,255,0.08);"></div>
    `;

    modal.appendChild(panel);
    document.body.appendChild(modal);
    document.body.appendChild(btn);

    const input = panel.querySelector("#atpu-key-input");
    input.value = loadLocalApiKey();

    panel.querySelector("#atpu-auth-run").onclick = () => {
        const key = String(input.value || "").trim();
        if (!key) return;
        updateAuthStatus("Authorizing…", "#fbbf24");
        authorizeFromKey(key);
        modal.style.display = "none";
    };

    panel.querySelector("#atpu-hud-toggle").onclick = () => {
        setHudVisible(!STATE.hudVisible);
    };

    panel.querySelector("#atpu-auth-logout").onclick = () => {
        clearAuthState();
        updateAuthStatus("Status: not authorized", "#cbd5e1");
        renderMenuStatus();
    };

    panel.querySelector("#atpu-auth-close").onclick = () => {
        modal.style.display = "none";
    };

    modal.addEventListener("click", e => {
        if (e.target === modal) modal.style.display = "none";
    });

    btn.onclick = () => {
        updateAuthStatus(
            STATE.authorized ? "Status: authorized" : "Status: not authorized",
            STATE.authorized ? "#4ade80" : "#cbd5e1"
        );
        input.value = loadLocalApiKey();
        modal.style.display = modal.style.display === "none" ? "block" : "none";
        renderMenuStatus();
    };

    setHudVisible(STATE.hudVisible);
    renderMenuStatus();
}

function waitForBody(fn) {
    if (document.body) return fn();
    setTimeout(() => waitForBody(fn), 200);
}

function autoAuthorizeFromLocalKey() {
    const now = Date.now();
    if (now - STATE.authCheckedAt < 10000) return;

    STATE.authCheckedAt = now;

    if (!isPageActive()) return;
    if (STATE.authorized && STATE.publicToken) return;

    const key = loadLocalApiKey();
    if (!key) return;

    authorizeFromKey(key);
}

function installVisibilityGuard() {
    STATE.pageVisible = isPageActive();

    function refreshPageState() {
        STATE.pageVisible = isPageActive();

        if (!STATE.pageVisible) {
            STATE.sessionStarting = false;
            STATE.eventQueue = [];
        } else {
            if (STATE.authorized && STATE.activeTableId && !STATE.sessionId) {
                startSession();
            }
            loadStatsFromServer();
        }

        renderMenuStatus();
    }

    document.addEventListener("visibilitychange", refreshPageState);
    globalWindow.addEventListener("focus", refreshPageState);
    globalWindow.addEventListener("blur", refreshPageState);
}

function boot() {
    if (STATE.started) return;
    STATE.started = true;

    installWS();
    installVisibilityGuard();
    loadAuthState();
    loadHudVisible();

    waitForBody(() => {
        mountButton();
        autoAuthorizeFromLocalKey();

        setInterval(flush, 3000);
        setInterval(renderHUD, 1000);
        setInterval(loadStatsFromServer, 5000);
        setInterval(autoAuthorizeFromLocalKey, 15000);
        setInterval(renderMenuStatus, 2000);
    });
}

boot();
})();