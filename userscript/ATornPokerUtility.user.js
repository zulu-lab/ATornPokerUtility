// ==UserScript==
// @name         ATornPokerUtility
// @namespace    zulu.atornpoker.utility
// @version      4.4.1
// @description  Torn Poker HUD with whitelist auth and server stats
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

const STATE = {
    sessionId: null,
    eventQueue: [],
    tables: {},
    activeTableId: null,
    authorized: false,
    publicToken: null,
    started: false
};

const PLAYER_STATS = {};
const LAST_ACTION = {};

function req(method, url, headers, body, cb) {
    GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body ? JSON.stringify(body) : undefined,
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

function bootstrap(ownerId) {
    req("POST", SERVER + "/api/public/bootstrap", {
        "Content-Type": "application/json"
    }, {
        owner_torn_id: ownerId
    }, (err, res) => {
        if (err || res.status !== 200) return;

        const data = JSON.parse(res.responseText || "{}");
        if (!data.session_token) return;

        STATE.publicToken = data.session_token;
        STATE.authorized = true;

        startSession();
    });
}

function startSession() {
    if (!STATE.publicToken) return;

    api("/api/public/sessions/start", "POST", {
        table_id: location.href
    }, (err, res) => {
        if (err || res.status !== 200) return;

        const data = JSON.parse(res.responseText || "{}");
        STATE.sessionId = data.session_id;
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
            STATE.eventQueue = batch.concat(STATE.eventQueue);
        }
    });
}

function queue(tableId, ev) {
    STATE.eventQueue.push({
        type: ev.type,
        player_id: ev.player_id,
        player_name: ev.player_name,
        amount: ev.amount || null,
        stack_before: ev.stack_before || null,
        stack_after: ev.stack_after || null,
        hand_id: ev.hand_id || null,
        event_ts: Date.now(), // ✅ FIX
        table_id: String(tableId), // ✅ FIX
        metadata: {}
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
                top: "50%", // ✅ PIÙ IN BASSO
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
            `<div>${s.hands}</div>`; // ❌ tolto H
    });
}

function installWS() {
    const WS = globalWindow.WebSocket;

    globalWindow.WebSocket = function (url, p) {
        const ws = p ? new WS(url, p) : new WS(url);

        ws.addEventListener("message", e => {
            if (!STATE.authorized) return;

            let data;
            try { data = JSON.parse(e.data); } catch { return; }

            const ch = data?.push?.channel;
            const msg = data?.push?.pub?.data?.message;

            if (!ch || !msg) return;

            const m = ch.match(/^holdem(\d+)/);
            if (!m) return;

            const tableId = m[1];
            STATE.activeTableId = tableId;

            const players = msg.players || {};
            Object.values(players).forEach(p => {
                if (!p.userID) return;

                const id = String(p.userID);

                if (!PLAYER_STATS[id]) {
                    PLAYER_STATS[id] = { name: p.playername, hands: 0, vpipHands: 0, pfrHands: 0 };
                }
            });

            renderHUD();
        });

        return ws;
    };

    globalWindow.WebSocket.prototype = WS.prototype;
}

function mountButton() {
    const btn = document.createElement("button");
    btn.textContent = "A";

    Object.assign(btn.style, {
        position: "fixed",
        left: "10px", // ✅ SINISTRA
        bottom: "10px",
        zIndex: 999999,
        width: "32px",
        height: "32px",
        borderRadius: "50%",
        background: "#000",
        color: "#fff"
    });

    btn.onclick = () => {
        const key = prompt("Insert Torn API Key");
        if (!key) return;

        req("GET", `https://api.torn.com/user/?selections=basic&key=${key}`, {}, null, (err, res) => {
            if (err || res.status !== 200) return alert("Invalid key");

            const data = JSON.parse(res.responseText || "{}");
            bootstrap(data.player_id);
        });
    };

    document.body.appendChild(btn);
}

function boot() {
    if (STATE.started) return;
    STATE.started = true;

    installWS();

    const i = setInterval(() => {
        if (!document.body) return;
        clearInterval(i);

        mountButton();
        setInterval(flush, 3000);
        setInterval(renderHUD, 1000);
    }, 200);
}

boot();

})();
