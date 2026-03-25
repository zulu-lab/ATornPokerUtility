// ==UserScript==
// @name         ATornPokerUtility
// @namespace    zulu.atornpoker.utility
// @version      4.7.0
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
// ==/UserScript==

(function () {
"use strict";

const globalWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
if (globalWindow.__A_TPU__) return;
globalWindow.__A_TPU__ = true;

const SERVER = "https://torn-poker-server-production.up.railway.app";
const LS = { token: "atpu.publicToken", authorized: "atpu.authorized" };

const STATE = {
    sessionId: null,
    sessionStarting: false,
    eventQueue: [],
    tables: {},
    activeTableId: null,
    authorized: false,
    publicToken: null,
    started: false,
    lastFlush: "-"
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
    try {
        localStorage.removeItem(LS.token);
        localStorage.setItem(LS.authorized, "false");
    } catch {}
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

function bootstrap(ownerId) {
    req("POST", SERVER + "/api/public/bootstrap", {
        "Content-Type": "application/json"
    }, {
        owner_torn_id: ownerId,
        script_version: "4.7.0"
    }, (err, res) => {
        if (err || res.status !== 200) return;

        const data = safeParse(res.responseText, {});
        if (!data.session_token) return;

        STATE.publicToken = data.session_token;
        STATE.authorized = true;
        saveAuthState();
    });
}

function startSession() {
    if (!STATE.publicToken || !STATE.activeTableId || STATE.sessionId || STATE.sessionStarting) return;
    STATE.sessionStarting = true;

    api("/api/public/sessions/start", "POST", {
        table_id: String(STATE.activeTableId),
        source_url: location.href
    }, (err, res) => {
        STATE.sessionStarting = false;
        if (err || res.status !== 200) {
            if (res && res.status === 401) clearAuthState();
            return;
        }

        const data = safeParse(res.responseText, {});
        STATE.sessionId = data.session_id || null;
    });
}

function flush() {
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
            return;
        }
        STATE.lastFlush = "ok " + batch.length;
    });
}

function loadStatsFromServer() {
    if (!STATE.authorized || !STATE.publicToken || !STATE.activeTableId) return;

    api(`/api/public/stats/table?table_id=${encodeURIComponent(String(STATE.activeTableId))}`, "GET", null, (err, res) => {
        if (err || res.status !== 200) {
            if (res && res.status === 401) clearAuthState();
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
    if (!STATE.authorized) return;

    STATE.eventQueue.push({
        table_id: String(tableId),
        type: ev.type,
        player_id: ev.player_id,
        player_name: ev.player_name,
        amount: ev.amount || null,
        stack_before: ev.stack_before || null,
        stack_after: ev.stack_after || null,
        hand_id: null,
        event_ts: Date.now(),
        metadata: {
            raw_hand_ref: ev.hand_id || null
        }
    });
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
    if (!STATE.authorized) return;

    document.querySelectorAll("[id^='player-']").forEach(box => {
        const id = box.id.replace("player-", "");
        const s = PLAYER_STATS[id];
        if (!s) return;

        let hud = box.querySelector(".atpu-hud");
        if (!hud) {
            hud = document.createElement("div");
            hud.className = "atpu-hud";

            Object.assign(hud.style, {
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                background: "rgba(0,0,0,0.9)",
                color: "#fff",
                fontSize: "10px",
                padding: "4px 6px",
                borderRadius: "6px",
                zIndex: 9999,
                pointerEvents: "none"
            });

            if (getComputedStyle(box).position === "static") {
                box.style.position = "relative";
            }

            box.appendChild(hud);
        }

        const vpip = s.hands ? (s.vpipHands / s.hands * 100) : 0;
        const pfr = s.hands ? (s.pfrHands / s.hands * 100) : 0;
        const st = getStyle(vpip, pfr, s.hands);

        hud.innerHTML =
            `<div>${s.name}</div>` +
            `<div style="color:${st.c}">${st.l}</div>` +
            `<div>${vpip.toFixed(0)} / ${pfr.toFixed(0)}</div>` +
            `<div>H:${s.hands}</div>`;
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

        const dedupeKey = `${player.id}_${type}_${table.currentHandId || "nohand"}`;
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
    STATE.activeTableId = tableId;

    if (STATE.authorized && !STATE.sessionId) startSession();
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
        if (err || res.status !== 200) return alert("Invalid key");

        const data = safeParse(res.responseText, {});
        if (!data.player_id) return alert("Unable to read player_id from Torn response");
        bootstrap(data.player_id);
    });
}

function mountButton() {
    if (!document.body || document.getElementById("atpu-auth-btn")) return;

    const btn = document.createElement("button");
    btn.id = "atpu-auth-btn";
    btn.textContent = "A";

    Object.assign(btn.style, {
        position: "fixed",
        left: "10px",
        bottom: "10px",
        zIndex: 999999,
        width: "32px",
        height: "32px",
        borderRadius: "50%",
        background: "#000",
        color: "#fff"
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
        <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=ATornPokerUtility&user=basic"
           target="_blank"
           style="display:inline-block;margin-bottom:8px;color:#9fd4ff;">Create custom API key (basic / owner id)</a>
        <input id="atpu-key-input" type="password" placeholder="Paste Torn custom API key"
               style="width:100%;padding:8px;border-radius:8px;border:none;background:#1a2336;color:#fff;margin-bottom:8px;">
        <div style="display:flex;gap:8px;">
            <button id="atpu-auth-run" style="padding:8px 10px;border:none;border-radius:8px;background:#335eea;color:#fff;font-weight:700;">Authorize</button>
            <button id="atpu-auth-close" style="padding:8px 10px;border:none;border-radius:8px;background:#444;color:#fff;">Close</button>
        </div>
    `;

    modal.appendChild(panel);
    document.body.appendChild(modal);
    document.body.appendChild(btn);

    const input = panel.querySelector("#atpu-key-input");
    panel.querySelector("#atpu-auth-run").onclick = () => {
        const key = String(input.value || "").trim();
        if (!key) return;
        authorizeFromKey(key);
        modal.style.display = "none";
    };

    panel.querySelector("#atpu-auth-close").onclick = () => {
        modal.style.display = "none";
    };

    modal.addEventListener("click", e => {
        if (e.target === modal) modal.style.display = "none";
    });

    btn.onclick = () => {
        modal.style.display = modal.style.display === "none" ? "block" : "none";
    };
}

function waitForBody(fn) {
    if (document.body) return fn();
    setTimeout(() => waitForBody(fn), 200);
}

function boot() {
    if (STATE.started) return;
    STATE.started = true;

    installWS();
    loadAuthState();

    waitForBody(() => {
        mountButton();
        setInterval(flush, 3000);
        setInterval(renderHUD, 1000);
        setInterval(loadStatsFromServer, 5000);
    });
}

boot();
})();
