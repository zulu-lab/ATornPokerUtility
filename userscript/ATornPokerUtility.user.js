// ==UserScript==
// @name         ATornPokerUtility
// @namespace    zulu.atornpoker.utility
// @version      4.3.1
// @description  Torn Poker HUD with whitelist auth, persistent server stats and inline player overlays
// @match        https://www.torn.com/page.php?sid=holdem*
// @match        https://www.torn.com/pda.php?sid=holdem*
// @match        https://www.torn.com/loader.php?sid=holdem*
// @match        https://www.torn.com/*sid=holdem*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      torn-poker-server-production.up.railway.app
// @connect      api.torn.com
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/zulu-lab/ATornPokerUtility/main/userscript/ATornPokerUtility.user.js
// @downloadURL  https://raw.githubusercontent.com/zulu-lab/ATornPokerUtility/main/userscript/ATornPokerUtility.user.js
// ==/UserScript==

(function () {
    "use strict";

    const globalWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (globalWindow.__A_TORN_POKER_UTILITY__) return;
    globalWindow.__A_TORN_POKER_UTILITY__ = true;

    const SERVER = "https://torn-poker-server-production.up.railway.app";
    const SCRIPT_VERSION = "4.3.1";

    const LS = {
        tornKey: "atpu.tornKey",
        ownerId: "atpu.ownerId",
        ownerName: "atpu.ownerName",
        publicToken: "atpu.publicToken",
        publicEnabled: "atpu.publicEnabled"
    };

    const STATE = {
        started: false,
        authorized: false,
        ownerTornId: null,
        ownerName: null,
        tornKey: null,
        publicToken: null,

        sessionId: null,
        eventQueue: [],
        tables: {},
        activeTableId: null,

        wsInstalled: false,
        sniffingEnabled: false,
        settingsMounted: false,
        playerHudLoopStarted: false,
        flushLoopStarted: false,
        sessionStarted: false,
        persistedFetchLoopStarted: false,

        lastFlush: "-",
        lastAction: "-",
        lastPersistFetchAt: 0
    };

    const PLAYER_STATS = {};
    const LAST_ACTION_DEDUPE = {};

    function safeParse(text, fallback = null) {
        try {
            return JSON.parse(text);
        } catch {
            return fallback;
        }
    }

    function setLS(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch {}
    }

    function getLS(key, fallback = "") {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : v;
        } catch {
            return fallback;
        }
    }

    function delLS(key) {
        try {
            localStorage.removeItem(key);
        } catch {}
    }

    function req(method, url, headers, body, cb) {
        GM_xmlhttpRequest({
            method,
            url,
            headers: headers || {},
            data: body ? JSON.stringify(body) : undefined,
            timeout: 15000,
            onload: function (r) {
                cb(null, {
                    status: r?.status ?? 0,
                    text: r?.responseText ?? ""
                });
            },
            onerror: function () {
                cb(new Error("onerror"), null);
            },
            ontimeout: function () {
                cb(new Error("timeout"), null);
            }
        });
    }

    function reqServer(method, path, body, cb, useBearer = false) {
        const headers = { "Content-Type": "application/json" };
        if (useBearer && STATE.publicToken) {
            headers["Authorization"] = "Bearer " + STATE.publicToken;
        }
        req(method, SERVER + path, headers, body, cb);
    }

    function waitForBody(fn) {
        if (document.body) return fn();
        setTimeout(() => waitForBody(fn), 250);
    }

    function parseMoney(text) {
        if (text == null) return null;
        const cleaned = String(text).replace(/[$,\s]/g, "");
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
    }

    function normalizeName(name) {
        return String(name || "").trim();
    }

    function ensurePlayerStats(userId, name) {
        const id = String(userId);
        if (!PLAYER_STATS[id]) {
            PLAYER_STATS[id] = {
                name: name || ("ID " + id),
                hands: 0,
                vpipHands: 0,
                pfrHands: 0,
                persistedLoaded: false
            };
        } else if (name) {
            PLAYER_STATS[id].name = name;
        }
        return PLAYER_STATS[id];
    }

    function ensureTable(tableId) {
        const key = String(tableId);
        if (!STATE.tables[key]) {
            STATE.tables[key] = {
                id: key,
                playersById: {},
                nameToId: {},
                currentHandId: null,
                lastHandId: null,
                street: "preflop",
                handTracker: {
                    active: false,
                    vpip: {},
                    pfr: {},
                    participants: {}
                }
            };
        }
        return STATE.tables[key];
    }

    function loadPersistedState() {
        STATE.tornKey = getLS(LS.tornKey, "") || null;
        STATE.ownerTornId = Number(getLS(LS.ownerId, "0")) || null;
        STATE.ownerName = getLS(LS.ownerName, "") || null;
        STATE.publicToken = getLS(LS.publicToken, "") || null;
        STATE.authorized = getLS(LS.publicEnabled, "false") === "true";
        STATE.sniffingEnabled = STATE.authorized && !!STATE.publicToken;
    }

    function currentStatusLabel() {
        if (!STATE.tornKey) return "NO KEY";
        if (!STATE.ownerTornId) return "NO ID";
        if (!STATE.authorized) return "BLOCKED";
        return "ON";
    }

    function testTornKey(key, cb) {
        req(
            "GET",
            "https://api.torn.com/user/?selections=basic&key=" + encodeURIComponent(key),
            {},
            null,
            function (err, res) {
                if (err || !res || res.status !== 200) {
                    cb(false, "request failed");
                    return;
                }

                const data = safeParse(res.text, {});
                if (!data || data.error) {
                    cb(false, data?.error?.error || "invalid key");
                    return;
                }

                const playerId = Number(data.player_id || data.playerID || 0);
                if (!playerId) {
                    cb(false, "player_id missing");
                    return;
                }

                cb(true, {
                    player_id: playerId,
                    name: data.name || null
                });
            }
        );
    }

    function bootstrapPublic(cb) {
        if (!STATE.ownerTornId) {
            cb(false, "owner id missing");
            return;
        }

        reqServer(
            "POST",
            "/api/public/bootstrap",
            {
                owner_torn_id: STATE.ownerTornId,
                script_version: SCRIPT_VERSION
            },
            function (err, res) {
                if (err || !res) {
                    STATE.authorized = false;
                    STATE.publicToken = null;
                    STATE.sniffingEnabled = false;
                    delLS(LS.publicToken);
                    setLS(LS.publicEnabled, "false");
                    cb(false, "bootstrap request failed");
                    return;
                }

                const data = safeParse(res.text, {});
                if (res.status !== 200 || !data || !data.ok || !data.enabled || !data.session_token) {
                    STATE.authorized = false;
                    STATE.publicToken = null;
                    STATE.sniffingEnabled = false;
                    delLS(LS.publicToken);
                    setLS(LS.publicEnabled, "false");
                    cb(false, "not authorized");
                    return;
                }

                STATE.authorized = true;
                STATE.publicToken = String(data.session_token);
                STATE.sniffingEnabled = true;

                setLS(LS.publicToken, STATE.publicToken);
                setLS(LS.publicEnabled, "true");

                ensureLoops();
                startSession();
                fetchPersistedStatsForActiveTable();

                cb(true, "authorized");
            },
            false
        );
    }

    function mountSettingsUI() {
        if (STATE.settingsMounted || !document.body) return;
        STATE.settingsMounted = true;

        const btn = document.createElement("button");
        btn.id = "atpu-settings-btn";
        btn.textContent = "A";
        Object.assign(btn.style, {
            position: "fixed",
            right: "10px",
            bottom: "10px",
            width: "34px",
            height: "34px",
            borderRadius: "999px",
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(0,0,0,0.88)",
            color: "#fff",
            zIndex: "999999",
            fontWeight: "700",
            fontSize: "14px",
            cursor: "pointer",
            boxShadow: "0 6px 18px rgba(0,0,0,0.35)"
        });

        const badge = document.createElement("div");
        badge.id = "atpu-settings-badge";
        Object.assign(badge.style, {
            position: "fixed",
            right: "46px",
            bottom: "16px",
            background: "rgba(0,0,0,0.88)",
            color: "#c8f7ff",
            padding: "4px 8px",
            borderRadius: "999px",
            fontFamily: "monospace",
            fontSize: "11px",
            zIndex: "999999",
            border: "1px solid rgba(255,255,255,0.10)"
        });
        badge.textContent = currentStatusLabel();

        const modal = document.createElement("div");
        modal.id = "atpu-settings-modal";
        Object.assign(modal.style, {
            display: "none",
            position: "fixed",
            zIndex: "1000000",
            inset: "0",
            background: "rgba(0,0,0,0.55)"
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            position: "absolute",
            right: "10px",
            bottom: "54px",
            width: "min(380px, calc(100vw - 20px))",
            background: "#101726",
            color: "#fff",
            borderRadius: "14px",
            border: "1px solid rgba(255,255,255,0.10)",
            padding: "14px",
            fontFamily: "system-ui, sans-serif",
            boxShadow: "0 14px 34px rgba(0,0,0,0.45)"
        });

        panel.innerHTML = `
            <div style="font-size:16px;font-weight:700;margin-bottom:8px;">ATornPokerUtility</div>
            <div style="font-size:12px;opacity:0.8;margin-bottom:10px;">
                Status: <span id="atpu-settings-status">${currentStatusLabel()}</span><br>
                Owner ID: <span id="atpu-settings-owner">${STATE.ownerTornId || "-"}</span><br>
                Last Flush: <span id="atpu-settings-flush">${STATE.lastFlush}</span>
            </div>

            <a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=ATornPokerUtility&user=basic"
               target="_blank"
               style="display:inline-block;margin-bottom:10px;color:#9fd4ff;">
               Create a Torn custom key
            </a>

            <label style="display:block;font-size:12px;opacity:0.8;margin-bottom:6px;">Custom Torn Key</label>
            <input id="atpu-settings-key" type="password" placeholder="Paste your Torn custom key"
                style="width:100%;padding:10px;border-radius:10px;border:none;background:#1a2336;color:#fff;margin-bottom:10px;">

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
                <button id="atpu-test-key-btn" style="padding:10px 12px;border:none;border-radius:10px;background:#335eea;color:#fff;font-weight:700;cursor:pointer;">Test Key</button>
                <button id="atpu-authorize-btn" style="padding:10px 12px;border:none;border-radius:10px;background:#14b86f;color:#fff;font-weight:700;cursor:pointer;">Authorize</button>
                <button id="atpu-clear-key-btn" style="padding:10px 12px;border:none;border-radius:10px;background:#9b2c2c;color:#fff;font-weight:700;cursor:pointer;">Clear</button>
            </div>

            <div id="atpu-settings-message" style="font-size:12px;white-space:pre-wrap;opacity:0.9;">Ready</div>
        `;

        modal.appendChild(panel);
        document.body.appendChild(modal);
        document.body.appendChild(badge);
        document.body.appendChild(btn);

        const input = panel.querySelector("#atpu-settings-key");
        const msg = panel.querySelector("#atpu-settings-message");
        const ownerEl = panel.querySelector("#atpu-settings-owner");
        const statusEl = panel.querySelector("#atpu-settings-status");
        const flushEl = panel.querySelector("#atpu-settings-flush");

        input.value = STATE.tornKey || "";

        function refreshPanelStatus(text) {
            badge.textContent = currentStatusLabel();
            statusEl.textContent = currentStatusLabel();
            ownerEl.textContent = STATE.ownerTornId || "-";
            flushEl.textContent = STATE.lastFlush;
            if (text) msg.textContent = text;
        }

        btn.addEventListener("click", () => {
            modal.style.display = modal.style.display === "none" ? "block" : "none";
            refreshPanelStatus();
        });

        modal.addEventListener("click", (e) => {
            if (e.target === modal) modal.style.display = "none";
        });

        panel.querySelector("#atpu-test-key-btn").addEventListener("click", () => {
            const key = input.value.trim();
            if (!key) {
                refreshPanelStatus("Insert a Torn custom key.");
                return;
            }

            testTornKey(key, function (ok, dataOrMsg) {
                if (!ok) {
                    refreshPanelStatus("Key test failed:\n" + dataOrMsg);
                    return;
                }

                STATE.tornKey = key;
                STATE.ownerTornId = dataOrMsg.player_id;
                STATE.ownerName = dataOrMsg.name || null;

                setLS(LS.tornKey, key);
                setLS(LS.ownerId, STATE.ownerTornId);
                setLS(LS.ownerName, STATE.ownerName || "");

                refreshPanelStatus(
                    "Key valid.\nOwner ID: " +
                    STATE.ownerTornId +
                    "\nName: " +
                    (STATE.ownerName || "-")
                );
            });
        });

        panel.querySelector("#atpu-authorize-btn").addEventListener("click", () => {
            const key = input.value.trim();
            if (!key) {
                refreshPanelStatus("Insert a Torn custom key.");
                return;
            }

            testTornKey(key, function (ok, dataOrMsg) {
                if (!ok) {
                    refreshPanelStatus("Key test failed:\n" + dataOrMsg);
                    return;
                }

                STATE.tornKey = key;
                STATE.ownerTornId = dataOrMsg.player_id;
                STATE.ownerName = dataOrMsg.name || null;

                setLS(LS.tornKey, key);
                setLS(LS.ownerId, STATE.ownerTornId);
                setLS(LS.ownerName, STATE.ownerName || "");

                bootstrapPublic(function (enabled, info) {
                    refreshPanelStatus(info || (enabled ? "Authorized" : "Blocked"));
                });
            });
        });

        panel.querySelector("#atpu-clear-key-btn").addEventListener("click", () => {
            input.value = "";
            STATE.tornKey = null;
            STATE.ownerTornId = null;
            STATE.ownerName = null;
            STATE.publicToken = null;
            STATE.authorized = false;
            STATE.sniffingEnabled = false;
            STATE.sessionId = null;
            STATE.sessionStarted = false;

            delLS(LS.tornKey);
            delLS(LS.ownerId);
            delLS(LS.ownerName);
            delLS(LS.publicToken);
            delLS(LS.publicEnabled);

            refreshPanelStatus("Key removed.");
            removePlayerHUDs();
        });

        setInterval(() => {
            if (modal.style.display !== "none") refreshPanelStatus();
        }, 1500);

        refreshPanelStatus();
    }

    function normalizePlayers(table, playersObj) {
        const freshPlayersById = {};
        const freshNameToId = {};

        Object.entries(playersObj || {}).forEach(([seat, p]) => {
            if (!p || !p.userID) return;

            const uid = String(p.userID);
            const name = normalizeName(p.playername || p.name || ("ID " + uid));
            const stack = p.money != null ? parseMoney(p.money) : null;
            const status = p.status || null;

            freshPlayersById[uid] = {
                id: uid,
                name,
                seat,
                stack,
                status
            };
            freshNameToId[name] = uid;

            ensurePlayerStats(uid, name);
        });

        table.playersById = freshPlayersById;
        table.nameToId = freshNameToId;
    }

    function mapStatusToType(status) {
        const s = String(status || "").toLowerCase().trim();

        if (
            s.includes("blind") ||
            s.includes("waiting") ||
            s.includes("thinking") ||
            s.includes("dealer") ||
            s.includes("active")
        ) {
            return null;
        }

        if (s.includes("fold")) return "fold";
        if (s.includes("check")) return "check";
        if (s.includes("call")) return "call";
        if (s.includes("raise")) return "raise";
        if (s === "bet" || s.includes(" bet")) return "bet";
        if (s.includes("all in")) return "allin";

        return null;
    }

    function startNewHand(table) {
        table.handTracker = {
            active: true,
            vpip: {},
            pfr: {},
            participants: {}
        };

        Object.values(table.playersById).forEach(p => {
            table.handTracker.participants[p.id] = true;
        });
    }

    function finalizePreviousHand(table) {
        const ht = table.handTracker;
        if (!ht || !ht.active) return;

        Object.keys(ht.participants).forEach(id => {
            const ps = ensurePlayerStats(id);
            ps.hands += 1;
            if (ht.vpip[id]) ps.vpipHands += 1;
            if (ht.pfr[id]) ps.pfrHands += 1;
        });

        table.handTracker.active = false;
    }

    function maybeRotateHand(table) {
        const current = table.currentHandId;
        if (!current) return;

        if (!table.lastHandId) {
            table.lastHandId = current;
            startNewHand(table);
            return;
        }

        if (table.lastHandId !== current) {
            finalizePreviousHand(table);
            table.lastHandId = current;
            startNewHand(table);

            Object.keys(LAST_ACTION_DEDUPE).forEach(key => delete LAST_ACTION_DEDUPE[key]);
            fetchPersistedStatsForActiveTable();
        }
    }

    function markPreflopAction(table, playerId, type) {
        if (!table || table.street !== "preflop") return;
        if (!table.handTracker || !table.handTracker.active) return;

        const id = String(playerId);

        if (type === "call" || type === "bet" || type === "raise" || type === "allin") {
            table.handTracker.vpip[id] = true;
        }

        if (type === "bet" || type === "raise" || type === "allin") {
            table.handTracker.pfr[id] = true;
        }
    }

    function queueEvent(tableId, ev) {
        if (!STATE.sniffingEnabled) return;

        STATE.eventQueue.push({
            type: ev.type,
            player_id: ev.player_id ?? null,
            player_name: ev.player_name ?? null,
            amount: ev.amount ?? null,
            stack_before: ev.stack_before ?? null,
            stack_after: ev.stack_after ?? null,
            hand_id: ev.hand_id ?? null,
            timestamp: Date.now(),
            metadata: {
                table_id: String(tableId)
            }
        });

        STATE.lastAction = ev.type + " " + (ev.player_name || "");
    }

    function detectRosterChanges(tableId, newPlayers, oldPlayers, currentHandId) {
        const newIds = new Set(Object.keys(newPlayers));
        const oldIds = new Set(Object.keys(oldPlayers));

        for (const id of newIds) {
            if (!oldIds.has(id)) {
                const p = newPlayers[id];
                queueEvent(tableId, {
                    type: "join",
                    player_id: Number(p.id),
                    player_name: p.name,
                    stack_after: p.stack,
                    hand_id: currentHandId
                });
            }
        }

        for (const id of oldIds) {
            if (!newIds.has(id)) {
                const p = oldPlayers[id];
                queueEvent(tableId, {
                    type: "leave",
                    player_id: Number(p.id),
                    player_name: p.name,
                    stack_before: p.stack,
                    hand_id: currentHandId
                });
            }
        }

        for (const id of newIds) {
            if (!oldIds.has(id)) continue;
            const prev = oldPlayers[id];
            const curr = newPlayers[id];
            if (prev && curr && prev.stack !== curr.stack) {
                queueEvent(tableId, {
                    type: "stack_update",
                    player_id: Number(curr.id),
                    player_name: curr.name,
                    stack_before: prev.stack,
                    stack_after: curr.stack,
                    hand_id: currentHandId
                });
            }
        }
    }

    function detectActions(tableId, table, oldPlayers, msg) {
        Object.values(table.playersById).forEach(p => {
            const prev = oldPlayers[p.id];
            if (!prev) return;

            const oldStatus = String(prev.status || "").trim();
            const newStatus = String(p.status || "").trim();
            if (!oldStatus || !newStatus || oldStatus === newStatus) return;

            const type = mapStatusToType(newStatus);
            if (!type) return;

            const dedupeKey = `${p.id}_${type}_${table.currentHandId || "nohand"}`;
            if (LAST_ACTION_DEDUPE[dedupeKey]) return;
            LAST_ACTION_DEDUPE[dedupeKey] = true;

            markPreflopAction(table, p.id, type);

            queueEvent(tableId, {
                type,
                player_id: Number(p.id),
                player_name: p.name,
                amount: msg.amountCall || null,
                stack_before: prev.stack,
                stack_after: p.stack,
                hand_id: table.currentHandId
            });
        });
    }

    function updatePlayersFromState(tableId, msg) {
        const table = ensureTable(tableId);

        if (STATE.activeTableId !== String(tableId)) {
            STATE.activeTableId = String(tableId);
            fetchPersistedStatsForActiveTable();
        }

        const oldPlayers = {};
        Object.entries(table.playersById).forEach(([k, v]) => {
            oldPlayers[k] = { ...v };
        });

        normalizePlayers(table, msg.players || {});

        const cc = msg.communityCards || [];
        if (cc.length === 0) table.street = "preflop";
        else if (cc.length === 3) table.street = "flop";
        else if (cc.length === 4) table.street = "turn";
        else if (cc.length === 5) table.street = "river";

        const token = msg.token || msg.gameToken || msg.handId || msg.hand_id || null;
        if (token) table.currentHandId = String(token);

        detectRosterChanges(tableId, table.playersById, oldPlayers, table.currentHandId);
        maybeRotateHand(table);
        detectActions(tableId, table, oldPlayers, msg);
    }

    function updateFromUpdatePlayer(tableId, msg) {
        const table = ensureTable(tableId);

        if (STATE.activeTableId !== String(tableId)) {
            STATE.activeTableId = String(tableId);
            fetchPersistedStatsForActiveTable();
        }

        const oldPlayers = {};
        Object.entries(table.playersById).forEach(([k, v]) => {
            oldPlayers[k] = { ...v };
        });

        const playersObj = msg.player || msg.players || {};
        if (msg.phase) {
            const ph = String(msg.phase).toLowerCase();
            if (ph.includes("pre")) table.street = "preflop";
            else if (ph.includes("flop")) table.street = "flop";
            else if (ph.includes("turn")) table.street = "turn";
            else if (ph.includes("river")) table.street = "river";
        }

        if (playersObj && typeof playersObj === "object") {
            Object.entries(playersObj).forEach(([seat, p]) => {
                if (!p || !p.userID) return;

                const uid = String(p.userID);
                const name = normalizeName(p.playername || p.name || ("ID " + uid));
                const stack = p.money != null ? parseMoney(p.money) : null;
                const status = p.status || null;

                table.playersById[uid] = {
                    id: uid,
                    name,
                    seat,
                    stack,
                    status
                };
                table.nameToId[name] = uid;

                ensurePlayerStats(uid, name);
            });
        }

        detectRosterChanges(tableId, table.playersById, oldPlayers, table.currentHandId);
        maybeRotateHand(table);
        detectActions(tableId, table, oldPlayers, msg);
    }

    function handleHoldemMessage(raw) {
        if (!STATE.sniffingEnabled) return;

        const push = raw?.push;
        if (!push || !push.channel) return;

        const channel = push.channel;
        const msg = push?.pub?.data?.message;
        if (!msg) return;

        const m = String(channel).match(/^holdem(\d+)$/);
        if (!m) return;

        const tableId = m[1];
        const eventType = msg.eventType || null;

        if (eventType === "getState" || eventType === "playerMakeMove") {
            updatePlayersFromState(tableId, msg);
            return;
        }

        if (eventType === "updatePlayer") {
            updateFromUpdatePlayer(tableId, msg);
        }
    }

    function installWSHook() {
        if (STATE.wsInstalled) return;
        STATE.wsInstalled = true;

        const OriginalWebSocket = globalWindow.WebSocket;
        if (!OriginalWebSocket) return;

        function WrappedWebSocket(url, protocols) {
            const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

            ws.addEventListener("message", function (ev) {
                if (!STATE.sniffingEnabled) return;
                if (typeof ev.data !== "string") return;

                let parsed;
                try {
                    parsed = JSON.parse(ev.data);
                } catch {
                    return;
                }

                const channel = parsed?.push?.channel;
                if (!channel) return;

                if (/^holdem\d+$/.test(channel)) {
                    handleHoldemMessage(parsed);
                }
            });

            return ws;
        }

        WrappedWebSocket.prototype = OriginalWebSocket.prototype;
        globalWindow.WebSocket = WrappedWebSocket;
    }

    function startSession() {
        if (!STATE.sniffingEnabled || !STATE.publicToken) return;
        if (STATE.sessionStarted) return;

        STATE.sessionStarted = true;

        reqServer(
            "POST",
            "/api/public/sessions/start",
            {
                table_id: location.href,
                stack_start: null
            },
            function (err, res) {
                if (err || !res || res.status !== 200) {
                    STATE.sessionStarted = false;
                    return;
                }

                const data = safeParse(res.text, {});
                if (!data || !data.session_id) {
                    STATE.sessionStarted = false;
                    return;
                }

                STATE.sessionId = String(data.session_id);
            },
            true
        );
    }

    function flushEvents() {
        if (!STATE.sniffingEnabled || !STATE.publicToken) return;
        if (!STATE.sessionId) return;
        if (STATE.eventQueue.length === 0) return;

        const batch = STATE.eventQueue.splice(0, 50);

        reqServer(
            "POST",
            "/api/public/events",
            {
                session_id: STATE.sessionId,
                events: batch
            },
            function (err, res) {
                if (err || !res || res.status !== 200) {
                    STATE.eventQueue = batch.concat(STATE.eventQueue);
                    STATE.lastFlush = "failed";
                    return;
                }

                STATE.lastFlush = "ok " + batch.length;
            },
            true
        );
    }

    function fetchPersistedStatsForActiveTable() {
        if (!STATE.sniffingEnabled || !STATE.publicToken) return;
        if (!STATE.activeTableId) return;

        const now = Date.now();
        if (now - STATE.lastPersistFetchAt < 2500) return;
        STATE.lastPersistFetchAt = now;

        reqServer(
            "GET",
            "/api/public/stats/table?table_id=" + encodeURIComponent(STATE.activeTableId),
            null,
            function (err, res) {
                if (err || !res || res.status !== 200) return;

                const data = safeParse(res.text, {});
                const stats = Array.isArray(data?.stats) ? data.stats : [];

                stats.forEach(s => {
                    const id = String(s.player_id);
                    const ps = ensurePlayerStats(id, s.player_name || ("ID " + id));

                    const hands = Number(s.hands || 0);
                    const vpip = Number(s.vpip || 0);
                    const pfr = Number(s.pfr || 0);

                    ps.hands = Math.max(ps.hands || 0, hands);
                    ps.vpipHands = Math.max(ps.vpipHands || 0, Math.round(hands * vpip / 100));
                    ps.pfrHands = Math.max(ps.pfrHands || 0, Math.round(hands * pfr / 100));
                    ps.persistedLoaded = true;
                });
            },
            true
        );
    }

    function ensureLoops() {
        if (!STATE.flushLoopStarted) {
            STATE.flushLoopStarted = true;
            setInterval(flushEvents, 3000);
        }

        if (!STATE.playerHudLoopStarted) {
            STATE.playerHudLoopStarted = true;
            setInterval(renderPlayerHUDs, 900);
        }

        if (!STATE.persistedFetchLoopStarted) {
            STATE.persistedFetchLoopStarted = true;
            setInterval(fetchPersistedStatsForActiveTable, 5000);
        }
    }

    function getPlayerStyle(vpip, pfr, hands) {
        if (!hands || hands <= 0) return { label: "NEW", color: "#9ca3af" };
        if (vpip < 15 && pfr < 10) return { label: "NIT", color: "#60a5fa" };
        if (vpip >= 15 && vpip <= 26 && pfr >= 10 && pfr <= 20) return { label: "TAG", color: "#22c55e" };
        if (vpip > 26 && pfr >= 18) return { label: "LAG", color: "#f97316" };
        if (vpip > 30 && pfr < 12) return { label: "CALL", color: "#eab308" };
        return { label: "FISH", color: "#ef4444" };
    }

    function removePlayerHUDs() {
        document.querySelectorAll(".atpu-player-hud").forEach(el => el.remove());
    }

    function renderPlayerHUDs() {
        if (!STATE.sniffingEnabled) {
            removePlayerHUDs();
            return;
        }

        const boxes = document.querySelectorAll("[id^='player-']");
        if (!boxes.length) return;

        boxes.forEach(box => {
            const match = String(box.id || "").match(/^player-(\d+)/);
            if (!match) return;

            const userId = match[1];
            const stats = PLAYER_STATS[userId];
            if (!stats) return;

            let hud = box.querySelector(".atpu-player-hud");
            if (!hud) {
                hud = document.createElement("div");
                hud.className = "atpu-player-hud";

                Object.assign(hud.style, {
                    position: "absolute",
                    top: "-4px",
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "rgba(0,0,0,0.92)",
                    color: "#fff",
                    fontSize: "10px",
                    padding: "4px 6px",
                    borderRadius: "6px",
                    zIndex: 9999,
                    pointerEvents: "none",
                    textAlign: "center",
                    lineHeight: "1.2",
                    minWidth: "84px",
                    boxShadow: "0 0 4px rgba(0,0,0,0.8)"
                });

                if (getComputedStyle(box).position === "static") {
                    box.style.position = "relative";
                }

                box.appendChild(hud);
            }

            const vpip = stats.hands ? (stats.vpipHands / stats.hands * 100) : 0;
            const pfr = stats.hands ? (stats.pfrHands / stats.hands * 100) : 0;
            const style = getPlayerStyle(vpip, pfr, stats.hands);

            hud.innerHTML =
                `<div style="font-weight:bold;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${stats.name}</div>` +
                `<div style="color:${style.color};font-weight:bold;">${style.label}</div>` +
                `<div>${vpip.toFixed(0)} / ${pfr.toFixed(0)}</div>` +
                `<div style="font-size:9px;opacity:0.75;">H:${stats.hands}</div>`;
        });
    }

    function boot() {
        if (STATE.started) return;
        STATE.started = true;

        loadPersistedState();
        installWSHook();

        waitForBody(() => {
            mountSettingsUI();

            if (STATE.tornKey && STATE.ownerTornId && STATE.publicToken && STATE.authorized) {
                STATE.sniffingEnabled = true;
                ensureLoops();
                startSession();
                fetchPersistedStatsForActiveTable();
            }
        });
    }

    boot();
})();
