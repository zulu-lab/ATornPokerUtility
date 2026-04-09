// ==UserScript==
// @name         ATornPokerUtility
// @namespace    zulu.atornpoker.utility
// @version      5.0.1
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
const SCRIPT_VERSION = "5.0.1";

const LS = {
    token: "atpu.publicToken",
    authorized: "atpu.authorized",
    tornApiKey: "atpu.tornApiKey",
    hudVisible: "atpu.hudVisible"
};

const ALLOWED_TYPES = new Set([
    "join",
    "leave",
    "stack_update",
    "fold",
    "call",
    "call_preflop",
    "raise",
    "raise_preflop",
    "bet",
    "check",
    "allin",
    "win",
    "hand_dealt",
    "saw_flop",
    "showdown",
    "win_showdown",
    "limp",
    "3bet",
    "faced_raise_preflop",
    "fold_to_3bet",
    "faced_3bet",
    "cbet_flop",
    "raised_preflop_opportunity",
    "fold_to_cbet",
    "faced_cbet",
    "squeeze",
    "squeeze_opportunity",
    "donk_bet",
    "donk_opportunity",
    "check_raise",
    "check_raise_opportunity",
    "fold_bb_to_steal",
    "faced_steal_bb"
]);

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
const HUD_STATE = {};
const DETAIL_CARD_STATE = {
    mounted: false,
    card: null,
    backdrop: null,
    activePlayerId: null,
    lastOpenAt: 0
};

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

function safeNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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
    closeDetailCard();
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
            currentHandId: null,
            currentStreet: "preflop",
            actionIndex: 0,
            streetActionIndex: 0,
            lastAggressorId: null,
            preflopAggressorId: null,
            flopCbetterId: null,
            preflopRaiseCount: 0,
            streetBetCount: 0,
            playerCheckedStreet: {},
            emittedHandDealt: false,
            sawFlopEmitted: {},
            showdownEmitted: {},
            winShowdownEmitted: {},
            facedCbetEmitted: {},
            foldToCbetEmitted: {},
            faced3BetEmitted: {},
            foldTo3BetEmitted: {},
            facedRaisePreflopEmitted: {},
            raisedPreflopOpportunityEmitted: {},
            squeezeOpportunityEmitted: {},
            squeezeEmitted: {},
            donkOpportunityEmitted: {},
            donkEmitted: {},
            checkRaiseOpportunityEmitted: {},
            checkRaiseEmitted: {},
            facedStealBbEmitted: {},
            foldBbToStealEmitted: {}
        };
    }
    return STATE.tables[key];
}

function resetHandState(table, newHandId) {
    table.currentHandId = String(newHandId || "");
    table.currentStreet = "preflop";
    table.actionIndex = 0;
    table.streetActionIndex = 0;
    table.lastAggressorId = null;
    table.preflopAggressorId = null;
    table.flopCbetterId = null;
    table.preflopRaiseCount = 0;
    table.streetBetCount = 0;
    table.playerCheckedStreet = {};
    table.emittedHandDealt = false;
    table.sawFlopEmitted = {};
    table.showdownEmitted = {};
    table.winShowdownEmitted = {};
    table.facedCbetEmitted = {};
    table.foldToCbetEmitted = {};
    table.faced3BetEmitted = {};
    table.foldTo3BetEmitted = {};
    table.facedRaisePreflopEmitted = {};
    table.raisedPreflopOpportunityEmitted = {};
    table.squeezeOpportunityEmitted = {};
    table.squeezeEmitted = {};
    table.donkOpportunityEmitted = {};
    table.donkEmitted = {};
    table.checkRaiseOpportunityEmitted = {};
    table.checkRaiseEmitted = {};
    table.facedStealBbEmitted = {};
    table.foldBbToStealEmitted = {};
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

function normalizeHandId(msg, fallback) {
    return String(
        msg?.token ||
        msg?.gameToken ||
        msg?.handId ||
        msg?.hand_id ||
        fallback ||
        ""
    );
}

function extractBoardCards(msg) {
    const candidates = [
        msg?.board,
        msg?.boardCards,
        msg?.board_cards,
        msg?.communityCards,
        msg?.community_cards,
        msg?.tableCards,
        msg?.table_cards,
        msg?.openCards,
        msg?.open_cards,
        msg?.sharedCards,
        msg?.shared_cards,
        msg?.cardsOnTable,
        msg?.cards_on_table
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate.filter(Boolean).map(v => String(v));
        if (candidate && typeof candidate === "object") {
            const values = Object.values(candidate).filter(Boolean).map(v => String(v));
            if (values.length) return values;
        }
    }

    return [];
}

function inferStreetFromMessage(msg, fallbackStreet) {
    const boardCards = extractBoardCards(msg);
    const boardCount = boardCards.length;

    if (boardCount >= 5) return "river";
    if (boardCount === 4) return "turn";
    if (boardCount === 3) return "flop";
    if (boardCount === 0) return "preflop";

    return fallbackStreet || "preflop";
}

function cloneLightPlayers(playersById) {
    return Object.values(playersById || {}).map(p => ({
        id: p.id,
        name: p.name,
        seat: p.seat || null,
        status: p.status || null,
        stack: p.stack ?? null,
        folded: !!p.folded
    }));
}

function syncTableHandContext(table, msg) {
    const nextHandId = normalizeHandId(msg, table.currentHandId);
    const handChanged = !!nextHandId && String(nextHandId) !== String(table.currentHandId || "");

    if (handChanged) {
        resetHandState(table, nextHandId);
    } else if (!table.currentHandId && nextHandId) {
        resetHandState(table, nextHandId);
    }

    const previousStreet = table.currentStreet || "preflop";
    const inferredStreet = inferStreetFromMessage(msg, previousStreet);

    if (inferredStreet !== previousStreet) {
        table.currentStreet = inferredStreet;
        table.streetActionIndex = 0;
        table.streetBetCount = 0;
        table.playerCheckedStreet = {};
    } else {
        table.currentStreet = inferredStreet;
    }
}

function inferHandResult(type, statusText) {
    const s = String(statusText || "").toLowerCase().trim();

    if (type === "fold") return "fold";
    if (s.includes("winner") || s.includes("won") || s.includes("wins") || s.includes("collected")) return "win";
    if (s.includes("lost") || s.includes("lose") || s.includes("loses")) return "lose";

    return null;
}

function resetTableSession(newTableId) {
    STATE.sessionId = null;
    STATE.sessionStarting = false;
    STATE.eventQueue = [];

    Object.keys(LAST_ACTION).forEach(k => delete LAST_ACTION[k]);

    STATE.activeTableId = String(newTableId);
    closeDetailCard();

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
                pfrHands: (pfr / 100) * hands,
                raw: row
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
    if (s.includes("winner") || s.includes("won") || s.includes("wins") || s.includes("collected")) return "win";

    return null;
}

function queue(tableId, ev) {
    if (!isPageActive()) return;
    if (!STATE.authorized) return;
    if (String(tableId) !== String(STATE.activeTableId)) return;
    if (!ALLOWED_TYPES.has(String(ev.type || "").toLowerCase())) return;

    const handRef = ev.hand_id || null;
    const metadata = ev.metadata && typeof ev.metadata === "object" ? { ...ev.metadata } : {};

    metadata.raw_hand_ref = handRef;
    metadata.street = ev.street ?? metadata.street ?? null;
    metadata.action_index = Number.isFinite(ev.action_index) ? ev.action_index : (Number.isFinite(metadata.action_index) ? metadata.action_index : null);
    metadata.is_aggressor = typeof ev.is_aggressor === "boolean" ? ev.is_aggressor : (typeof metadata.is_aggressor === "boolean" ? metadata.is_aggressor : null);
    metadata.hand_result = ev.hand_result ?? metadata.hand_result ?? null;
    metadata.seat = ev.seat ?? metadata.seat ?? null;
    metadata.status_raw = ev.status_raw ?? metadata.status_raw ?? null;
    metadata.previous_status = ev.previous_status ?? metadata.previous_status ?? null;
    metadata.raw_event_type = ev.raw_event_type ?? metadata.raw_event_type ?? ev.type ?? null;
    metadata.board_cards = Array.isArray(ev.board_cards) ? ev.board_cards : (Array.isArray(metadata.board_cards) ? metadata.board_cards : null);
    metadata.players_snapshot_light = Array.isArray(ev.players_snapshot_light)
        ? ev.players_snapshot_light
        : (Array.isArray(metadata.players_snapshot_light) ? metadata.players_snapshot_light : null);

    STATE.eventQueue.push({
        table_id: String(tableId),
        type: String(ev.type || "").toLowerCase(),
        player_id: ev.player_id ?? null,
        player_name: ev.player_name ?? null,
        amount: ev.amount ?? null,
        stack_before: ev.stack_before ?? null,
        stack_after: ev.stack_after ?? null,
        hand_id: handRef,
        street: metadata.street,
        action_index: metadata.action_index,
        is_aggressor: metadata.is_aggressor,
        hand_result: metadata.hand_result,
        event_ts: Date.now(),
        metadata
    });

    renderMenuStatus();
}

function emitEvent(tableId, player, type, extra = {}) {
    const table = ensureTable(tableId);
    const eventType = String(type || "").toLowerCase();
    if (!ALLOWED_TYPES.has(eventType)) return;

    const metadataPlayers = cloneLightPlayers(table.playersById);
    const boardCards = Array.isArray(extra.board_cards) ? extra.board_cards : extractBoardCards(extra.msg || {});
    const previousStatus = extra.previous_status ?? null;
    const statusRaw = extra.status_raw ?? player?.status ?? null;
    const handResult = extra.hand_result ?? inferHandResult(eventType, statusRaw);
    const street = extra.street || table.currentStreet || "preflop";
    const actionIndex = Number.isFinite(extra.action_index) ? extra.action_index : table.actionIndex || 0;

    queue(tableId, {
        type: eventType,
        player_id: player ? Number(player.id) : null,
        player_name: player ? player.name : null,
        amount: extra.amount ?? null,
        stack_before: extra.stack_before ?? (player ? player.stack : null),
        stack_after: extra.stack_after ?? (player ? player.stack : null),
        hand_id: table.currentHandId || null,
        street,
        action_index: actionIndex,
        is_aggressor: typeof extra.is_aggressor === "boolean" ? extra.is_aggressor : null,
        hand_result: handResult,
        seat: extra.seat ?? (player ? (player.seat ?? null) : null),
        status_raw: statusRaw,
        previous_status: previousStatus,
        raw_event_type: extra.raw_event_type ?? eventType,
        board_cards: boardCards,
        players_snapshot_light: metadataPlayers,
        metadata: {
            street,
            action_index: actionIndex,
            is_aggressor: typeof extra.is_aggressor === "boolean" ? extra.is_aggressor : null,
            hand_result: handResult,
            seat: extra.seat ?? (player ? (player.seat ?? null) : null),
            status_raw: statusRaw,
            previous_status: previousStatus,
            raw_event_type: extra.raw_event_type ?? eventType,
            board_cards: boardCards,
            players_snapshot_light: metadataPlayers
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

function isTouchLikeDevice() {
    try {
        return globalWindow.matchMedia && globalWindow.matchMedia("(pointer: coarse)").matches;
    } catch {
        return false;
    }
}

function ensureHudStyles() {
    if (document.getElementById("atpu-v5-style")) return;

    const style = document.createElement("style");
    style.id = "atpu-v5-style";
    style.textContent = `
        .atpu-mini-hud {
            position: absolute;
            top: 6px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 9999;
            min-width: 42px;
            max-width: 68px;
            padding: 3px 7px;
            border-radius: 999px;
            background: rgba(7,10,16,0.90);
            color: #fff;
            font-size: 10px;
            line-height: 1;
            font-weight: 800;
            letter-spacing: 0.35px;
            text-align: center;
            border: 1px solid rgba(255,255,255,0.10);
            box-shadow: 0 4px 12px rgba(0,0,0,0.28);
            pointer-events: auto;
            user-select: none;
            -webkit-user-select: none;
            cursor: pointer;
            opacity: 1;
            transition: opacity 220ms ease, transform 180ms ease, box-shadow 180ms ease;
            -webkit-tap-highlight-color: transparent;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            backdrop-filter: blur(2px);
            touch-action: manipulation;
        }
        .atpu-mini-hud.atpu-mini-hidden {
            display: none !important;
        }
        .atpu-mini-hud.atpu-mini-faded {
            opacity: 0.20;
        }
        .atpu-mini-hud.atpu-mini-active {
            opacity: 1;
            box-shadow: 0 6px 16px rgba(0,0,0,0.34);
        }
        .atpu-mini-hud.atpu-mini-flip {
            animation: atpuMiniFlip 420ms ease;
        }
        @keyframes atpuMiniFlip {
            0% { transform: translateX(-50%) rotateY(0deg) scale(1); }
            50% { transform: translateX(-50%) rotateY(90deg) scale(1.06); }
            100% { transform: translateX(-50%) rotateY(180deg) scale(1); }
        }
        .atpu-detail-backdrop {
            position: fixed;
            inset: 0;
            z-index: 1000001;
            background: rgba(0,0,0,0.42);
            display: none;
        }
        .atpu-detail-backdrop.atpu-open {
            display: block;
        }
        .atpu-detail-card {
            position: fixed;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            width: min(320px, calc(100vw - 22px));
            background: linear-gradient(180deg, rgba(15,23,42,0.98), rgba(9,14,24,0.98));
            color: #fff;
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.10);
            box-shadow: 0 18px 40px rgba(0,0,0,0.40);
            padding: 14px;
            font-family: system-ui, sans-serif;
            opacity: 0;
            pointer-events: none;
            transition: opacity 180ms ease, transform 220ms ease;
        }
        .atpu-detail-backdrop.atpu-open .atpu-detail-card {
            opacity: 1;
            pointer-events: auto;
            transform: translate(-50%, -50%) scale(1);
        }
        .atpu-detail-card.atpu-detail-from-flip {
            transform: translate(-50%, -50%) rotateY(0deg) scale(1);
            animation: atpuDetailFlipIn 260ms ease;
        }
        @keyframes atpuDetailFlipIn {
            0% { opacity: 0; transform: translate(-50%, -50%) rotateY(-90deg) scale(0.96); }
            100% { opacity: 1; transform: translate(-50%, -50%) rotateY(0deg) scale(1); }
        }
        .atpu-detail-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
        }
        .atpu-detail-title {
            font-size: 14px;
            font-weight: 800;
            display: flex;
            flex-direction: column;
            gap: 3px;
            min-width: 0;
        }
        .atpu-detail-title strong {
            font-size: 15px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .atpu-detail-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 4px 8px;
            border-radius: 999px;
            font-size: 10px;
            font-weight: 800;
            border: 1px solid rgba(255,255,255,0.14);
            background: rgba(255,255,255,0.06);
        }
        .atpu-detail-close {
            width: 28px;
            height: 28px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,0.10);
            background: rgba(255,255,255,0.06);
            color: #fff;
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
        }
        .atpu-detail-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 8px;
        }
        .atpu-detail-item {
            padding: 9px 10px;
            border-radius: 12px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.06);
        }
        .atpu-detail-label {
            display: block;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #94a3b8;
            margin-bottom: 4px;
        }
        .atpu-detail-value {
            display: block;
            font-size: 13px;
            font-weight: 700;
            color: #fff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .atpu-detail-foot {
            margin-top: 10px;
            color: #94a3b8;
            font-size: 11px;
            line-height: 1.3;
        }
    `;

    document.head.appendChild(style);
}

function getHudState(playerId) {
    const key = String(playerId);
    if (!HUD_STATE[key]) {
        HUD_STATE[key] = {
            fadeTimer: null,
            clickTimer: null,
            lastSignature: null,
            hudEl: null,
            boxEl: null,
            isFaded: false,
            lastTapAt: 0,
            suppressClickUntil: 0
        };
    }
    return HUD_STATE[key];
}

function clearHudTimers(playerId) {
    const st = HUD_STATE[String(playerId)];
    if (!st) return;
    if (st.fadeTimer) {
        clearTimeout(st.fadeTimer);
        st.fadeTimer = null;
    }
    if (st.clickTimer) {
        clearTimeout(st.clickTimer);
        st.clickTimer = null;
    }
}

function removeHud(playerId) {
    const key = String(playerId);
    const st = HUD_STATE[key];
    if (!st) return;
    clearHudTimers(key);
    if (st.hudEl && st.hudEl.parentNode) st.hudEl.parentNode.removeChild(st.hudEl);
    delete HUD_STATE[key];
    if (DETAIL_CARD_STATE.activePlayerId === key) closeDetailCard();
}

function cleanupStaleHud(validPlayerIds) {
    const keep = new Set((validPlayerIds || []).map(v => String(v)));
    Object.keys(HUD_STATE).forEach(id => {
        const st = HUD_STATE[id];
        const hudEl = st && st.hudEl;
        const hudInDom = !!(hudEl && hudEl.isConnected);
        const box = document.getElementById("player-" + id);
        if (!keep.has(id) || !hudInDom || !box) removeHud(id);
    });
}

function scheduleHudFade(playerId, shouldStartTimer) {
    const st = getHudState(playerId);
    const hud = st.hudEl;
    if (!hud) return;

    if (st.fadeTimer) clearTimeout(st.fadeTimer);
    st.fadeTimer = null;

    hud.classList.remove("atpu-mini-faded");
    hud.classList.add("atpu-mini-active");
    st.isFaded = false;

    if (shouldStartTimer === false) return;

    st.fadeTimer = setTimeout(() => {
        const current = HUD_STATE[String(playerId)];
        if (!current || !current.hudEl) return;
        current.hudEl.classList.add("atpu-mini-faded");
        current.hudEl.classList.remove("atpu-mini-active");
        current.isFaded = true;
        current.fadeTimer = null;
    }, 6000);
}

function pulseMiniHud(playerId) {
    const st = getHudState(playerId);
    if (!st.hudEl) return;
    st.hudEl.classList.remove("atpu-mini-flip");
    void st.hudEl.offsetWidth;
    st.hudEl.classList.add("atpu-mini-flip");
    setTimeout(() => {
        const current = HUD_STATE[String(playerId)];
        if (current && current.hudEl) current.hudEl.classList.remove("atpu-mini-flip");
    }, 460);
}

function buildDetailMetric(label, value) {
    return `<div class="atpu-detail-item"><span class="atpu-detail-label">${label}</span><span class="atpu-detail-value">${value}</span></div>`;
}

function ensureDetailCardMounted() {
    ensureHudStyles();
    if (DETAIL_CARD_STATE.mounted && DETAIL_CARD_STATE.backdrop && DETAIL_CARD_STATE.card) return;

    const backdrop = document.createElement("div");
    backdrop.className = "atpu-detail-backdrop";

    const card = document.createElement("div");
    card.className = "atpu-detail-card";
    backdrop.appendChild(card);

    backdrop.addEventListener("click", e => {
        if (e.target === backdrop) closeDetailCard();
    });

    document.body.appendChild(backdrop);

    DETAIL_CARD_STATE.mounted = true;
    DETAIL_CARD_STATE.backdrop = backdrop;
    DETAIL_CARD_STATE.card = card;
}

function closeDetailCard() {
    if (!DETAIL_CARD_STATE.mounted || !DETAIL_CARD_STATE.backdrop || !DETAIL_CARD_STATE.card) return;
    DETAIL_CARD_STATE.backdrop.classList.remove("atpu-open");
    DETAIL_CARD_STATE.backdrop.style.display = "none";
    DETAIL_CARD_STATE.card.classList.remove("atpu-detail-from-flip");
    DETAIL_CARD_STATE.activePlayerId = null;
}

function openDetailCard(playerId, preferFlip) {
    const id = String(playerId);
    const stats = PLAYER_STATS[id];
    const table = ensureTable(STATE.activeTableId || "");
    const livePlayer = table && table.playersById ? table.playersById[id] : null;
    if (!stats || !livePlayer) return;

    ensureDetailCardMounted();

    const hands = stats.hands || 0;
    const vpip = hands ? (stats.vpipHands / hands * 100) : 0;
    const pfr = hands ? (stats.pfrHands / hands * 100) : 0;

    const raw = stats.raw || {};

    const af = raw.af ?? raw.aggression ?? "-";
    const threebet = raw.threebet ?? raw["3bet"] ?? "-";
    const cbet = raw.cbet_flop ?? "-";
    const wtsd = raw.wtsd ?? "-";
    const wsd = raw.wsd ?? "-";

    const style = getStyle(vpip, pfr, hands);

    DETAIL_CARD_STATE.card.innerHTML = `
        <div class="atpu-detail-head">
            <div class="atpu-detail-title">
                <strong>
                    ${stats.name || ("ID " + id)}
                    <span style="margin-left:6px;color:${style.c};font-size:11px;">${style.l}</span>
                </strong>
            </div>
            <button class="atpu-detail-close" type="button">×</button>
        </div>

        <div class="atpu-detail-grid">
            ${buildDetailMetric("HANDS", hands)}
            ${buildDetailMetric("VPIP", vpip.toFixed(0) + "%")}
            ${buildDetailMetric("PFR", pfr.toFixed(0) + "%")}

            ${buildDetailMetric("AF", af)}
            ${buildDetailMetric("3B", threebet)}
            ${buildDetailMetric("CBET", cbet)}

            ${buildDetailMetric("WTSD", wtsd)}
            ${buildDetailMetric("WSD", wsd)}
            ${buildDetailMetric("STACK", livePlayer.stack ? "$" + formatMoneyShort(livePlayer.stack) : "-")}
        </div>
    `;

    const closeBtn = DETAIL_CARD_STATE.card.querySelector(".atpu-detail-close");
    if (closeBtn) closeBtn.onclick = closeDetailCard;

    DETAIL_CARD_STATE.activePlayerId = id;
    DETAIL_CARD_STATE.lastOpenAt = Date.now();

    DETAIL_CARD_STATE.backdrop.style.display = "block";
    DETAIL_CARD_STATE.backdrop.classList.add("atpu-open");

    DETAIL_CARD_STATE.card.classList.remove("atpu-detail-from-flip");
    if (preferFlip && !isTouchLikeDevice()) {
        void DETAIL_CARD_STATE.card.offsetWidth;
        DETAIL_CARD_STATE.card.classList.add("atpu-detail-from-flip");
    }
}

function bindMiniHudEvents(playerId) {
    const st = getHudState(playerId);
    const hud = st.hudEl;
    if (!hud || hud.dataset.bound === "1") return;

    hud.dataset.bound = "1";

    const DOUBLE_TAP_MS = 320;
    const SINGLE_TAP_DELAY = 260;

    function handleTapLike(e) {
        if (!STATE.hudVisible) return;

        e.preventDefault();
        e.stopPropagation();

        const current = getHudState(playerId);
        const now = Date.now();

        if (current.clickTimer && (now - current.lastTapAt) <= DOUBLE_TAP_MS) {
            clearTimeout(current.clickTimer);
            current.clickTimer = null;
            current.lastTapAt = 0;
            current.suppressClickUntil = now + 500;

            pulseMiniHud(playerId);
            openDetailCard(playerId, true);
            scheduleHudFade(playerId, true);
            return;
        }

        current.lastTapAt = now;

        if (current.clickTimer) {
            clearTimeout(current.clickTimer);
            current.clickTimer = null;
        }

        current.clickTimer = setTimeout(() => {
            const latest = getHudState(playerId);
            latest.clickTimer = null;
            scheduleHudFade(playerId, true);
        }, SINGLE_TAP_DELAY);
    }

    function handleClickFallback(e) {
        const current = getHudState(playerId);
        if (Date.now() < current.suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        handleTapLike(e);
    }

    if ("PointerEvent" in globalWindow) {
        hud.addEventListener("pointerup", handleTapLike, { passive: false });
        hud.addEventListener("click", handleClickFallback, { passive: false });
    } else {
        hud.addEventListener("touchend", handleTapLike, { passive: false });
        hud.addEventListener("click", handleClickFallback, { passive: false });
    }
}

function getPlayerHudSignature(stats, livePlayer) {
    const vpip = stats.hands ? (stats.vpipHands / stats.hands * 100) : 0;
    const pfr = stats.hands ? (stats.pfrHands / stats.hands * 100) : 0;
    const style = getStyle(vpip, pfr, stats.hands);
    return [
        style.l,
        stats.hands || 0,
        vpip.toFixed(0),
        pfr.toFixed(0),
        livePlayer && livePlayer.stack != null ? livePlayer.stack : "-",
        livePlayer && livePlayer.status ? livePlayer.status : "-"
    ].join("|");
}

function renderMiniHudForPlayer(box, playerId, stats, livePlayer) {
    ensureHudStyles();

    const st = getHudState(playerId);
    st.boxEl = box;

    let hud = st.hudEl;
    if (!hud || !hud.isConnected || hud.parentNode !== box) {
        if (hud && hud.parentNode) hud.parentNode.removeChild(hud);
        hud = document.createElement("div");
        hud.className = "atpu-mini-hud atpu-mini-active";
        hud.setAttribute("data-player-id", String(playerId));
        st.hudEl = hud;
        if (getComputedStyle(box).position === "static") box.style.position = "relative";
        box.appendChild(hud);
        bindMiniHudEvents(playerId);
        st.lastSignature = null;
    }

    const vpip = stats.hands ? (stats.vpipHands / stats.hands * 100) : 0;
    const pfr = stats.hands ? (stats.pfrHands / stats.hands * 100) : 0;
    const style = getStyle(vpip, pfr, stats.hands);
    const signature = getPlayerHudSignature(stats, livePlayer);

    hud.style.display = STATE.hudVisible ? "block" : "none";
    if (!STATE.hudVisible) return;

    hud.style.color = style.c;
    hud.textContent = style.l;
    hud.title = `${stats.name || ("ID " + playerId)} • ${style.l}`;

    if (st.lastSignature !== signature) {
        st.lastSignature = signature;
        scheduleHudFade(playerId, true);
        if (DETAIL_CARD_STATE.activePlayerId === String(playerId) && DETAIL_CARD_STATE.backdrop && DETAIL_CARD_STATE.backdrop.classList.contains("atpu-open")) {
            openDetailCard(playerId, false);
        }
    } else if (st.isFaded) {
        hud.classList.add("atpu-mini-faded");
        hud.classList.remove("atpu-mini-active");
    }
}

function renderHUD() {
    ensureHudStyles();

    const activeTableKey = String(STATE.activeTableId || "");
    const currentTable = STATE.tables[activeTableKey] || null;
    const validPlayerIds = [];

    document.querySelectorAll("[id^='player-']").forEach(box => {
        const id = box.id.replace("player-", "");
        const stats = PLAYER_STATS[id];
        if (!stats) return;

        const livePlayer = currentTable && currentTable.playersById ? currentTable.playersById[id] : null;
        if (!livePlayer) {
            removeHud(id);
            return;
        }

        validPlayerIds.push(id);
        renderMiniHudForPlayer(box, id, stats, livePlayer);
    });

    cleanupStaleHud(validPlayerIds);
}

function emitHandDealtIfNeeded(tableId) {
    const table = ensureTable(tableId);
    if (!table.currentHandId || table.emittedHandDealt) return;

    const boardCards = [];
    Object.values(table.playersById).forEach(player => {
        emitEvent(tableId, player, "hand_dealt", {
            street: "preflop",
            action_index: 0,
            is_aggressor: false,
            hand_result: null,
            seat: player.seat || null,
            status_raw: player.status || null,
            previous_status: null,
            raw_event_type: "hand_dealt",
            board_cards: boardCards
        });
    });

    table.emittedHandDealt = true;
}

function emitSawFlopIfNeeded(tableId, boardCards) {
    const table = ensureTable(tableId);
    if (table.currentStreet !== "flop") return;
    if (!Array.isArray(boardCards) || boardCards.length < 3) return;

    Object.values(table.playersById).forEach(player => {
        if (player.folded) return;
        if (table.sawFlopEmitted[player.id]) return;

        emitEvent(tableId, player, "saw_flop", {
            street: "flop",
            action_index: table.actionIndex,
            is_aggressor: false,
            hand_result: null,
            seat: player.seat || null,
            status_raw: player.status || null,
            previous_status: null,
            raw_event_type: "saw_flop",
            board_cards: boardCards
        });

        table.sawFlopEmitted[player.id] = true;
    });
}

function maybeEmitPreflopAdvanced(tableId, table, player, prev, type, commonMeta) {
    const playerId = String(player.id);
    const handKey = table.currentHandId || "nohand";

    if ((type === "call_preflop" || type === "fold") && table.preflopRaiseCount >= 1) {
        const key = `${tableId}|${handKey}|faced_raise_preflop|${playerId}|${table.actionIndex}`;
        if (!table.facedRaisePreflopEmitted[key]) {
            emitEvent(tableId, player, "faced_raise_preflop", commonMeta);
            table.facedRaisePreflopEmitted[key] = true;
        }
    }

    if (type === "raise_preflop" || type === "allin") {
        const keyOpp = `${tableId}|${handKey}|raised_preflop_opportunity|${playerId}|${table.actionIndex}`;
        if (!table.raisedPreflopOpportunityEmitted[keyOpp]) {
            emitEvent(tableId, player, "raised_preflop_opportunity", commonMeta);
            table.raisedPreflopOpportunityEmitted[keyOpp] = true;
        }
    }

    if (type === "call_preflop" && table.preflopRaiseCount === 0) {
        emitEvent(tableId, player, "limp", commonMeta);
    }

    if ((type === "raise_preflop" || type === "allin") && table.preflopRaiseCount === 1) {
        emitEvent(tableId, player, "3bet", { ...commonMeta, is_aggressor: true });

        const keyFaced = `${tableId}|${handKey}|faced_3bet|${playerId}|${table.actionIndex}`;
        if (!table.faced3BetEmitted[keyFaced]) {
            emitEvent(tableId, player, "faced_3bet", commonMeta);
            table.faced3BetEmitted[keyFaced] = true;
        }
    }

    if (type === "fold" && table.preflopRaiseCount >= 2) {
        const keyFold3 = `${tableId}|${handKey}|fold_to_3bet|${playerId}|${table.actionIndex}`;
        if (!table.foldTo3BetEmitted[keyFold3]) {
            emitEvent(tableId, player, "fold_to_3bet", commonMeta);
            table.foldTo3BetEmitted[keyFold3] = true;
        }
    }

    const isBbSeat = String(player.seat || "").toLowerCase() === "bb";
    const isLateStealPressure = table.preflopRaiseCount >= 1;

    if (isBbSeat && isLateStealPressure) {
        const facedStealKey = `${tableId}|${handKey}|faced_steal_bb|${playerId}|${table.actionIndex}`;
        if (!table.facedStealBbEmitted[facedStealKey]) {
            emitEvent(tableId, player, "faced_steal_bb", commonMeta);
            table.facedStealBbEmitted[facedStealKey] = true;
        }

        if (type === "fold") {
            const foldStealKey = `${tableId}|${handKey}|fold_bb_to_steal|${playerId}|${table.actionIndex}`;
            if (!table.foldBbToStealEmitted[foldStealKey]) {
                emitEvent(tableId, player, "fold_bb_to_steal", commonMeta);
                table.foldBbToStealEmitted[foldStealKey] = true;
            }
        }
    }

    const othersStillIn =
        Object.values(table.playersById).filter(p => !p.folded && String(p.id) !== playerId).length;

    if ((type === "raise_preflop" || type === "allin") && table.preflopRaiseCount >= 2 && othersStillIn >= 2) {
        const sqOppKey = `${tableId}|${handKey}|squeeze_opportunity|${playerId}|${table.actionIndex}`;
        if (!table.squeezeOpportunityEmitted[sqOppKey]) {
            emitEvent(tableId, player, "squeeze_opportunity", commonMeta);
            table.squeezeOpportunityEmitted[sqOppKey] = true;
        }

        const sqKey = `${tableId}|${handKey}|squeeze|${playerId}|${table.actionIndex}`;
        if (!table.squeezeEmitted[sqKey]) {
            emitEvent(tableId, player, "squeeze", { ...commonMeta, is_aggressor: true });
            table.squeezeEmitted[sqKey] = true;
        }
    }
}

function maybeEmitFlopAdvanced(tableId, table, player, type, commonMeta) {
    const playerId = String(player.id);
    const handKey = table.currentHandId || "nohand";
    const boardCards = commonMeta.board_cards || [];

    if ((type === "bet" || type === "raise") && table.preflopAggressorId && String(table.preflopAggressorId) === playerId && table.streetBetCount === 0) {
        table.flopCbetterId = player.id;
        emitEvent(tableId, player, "cbet_flop", { ...commonMeta, is_aggressor: true });
    }

    if (table.flopCbetterId && String(table.flopCbetterId) !== playerId && (type === "call" || type === "fold" || type === "raise")) {
        const keyFaced = `${tableId}|${handKey}|faced_cbet|${playerId}|${table.actionIndex}`;
        if (!table.facedCbetEmitted[keyFaced]) {
            emitEvent(tableId, player, "faced_cbet", commonMeta);
            table.facedCbetEmitted[keyFaced] = true;
        }
    }

    if (type === "fold" && table.flopCbetterId && String(table.flopCbetterId) !== playerId) {
        const keyFold = `${tableId}|${handKey}|fold_to_cbet|${playerId}|${table.actionIndex}`;
        if (!table.foldToCbetEmitted[keyFold]) {
            emitEvent(tableId, player, "fold_to_cbet", commonMeta);
            table.foldToCbetEmitted[keyFold] = true;
        }
    }

    if ((type === "bet" || type === "raise") && table.streetBetCount === 0 && table.preflopAggressorId && String(table.preflopAggressorId) !== playerId) {
        const keyOpp = `${tableId}|${handKey}|donk_opportunity|${playerId}|${table.actionIndex}`;
        if (!table.donkOpportunityEmitted[keyOpp]) {
            emitEvent(tableId, player, "donk_opportunity", commonMeta);
            table.donkOpportunityEmitted[keyOpp] = true;
        }

        const keyDonk = `${tableId}|${handKey}|donk_bet|${playerId}|${table.actionIndex}`;
        if (!table.donkEmitted[keyDonk]) {
            emitEvent(tableId, player, "donk_bet", { ...commonMeta, is_aggressor: true, board_cards: boardCards });
            table.donkEmitted[keyDonk] = true;
        }
    }

    if (type === "raise" && table.playerCheckedStreet[playerId]) {
        const keyOpp = `${tableId}|${handKey}|check_raise_opportunity|${playerId}|${table.actionIndex}`;
        if (!table.checkRaiseOpportunityEmitted[keyOpp]) {
            emitEvent(tableId, player, "check_raise_opportunity", commonMeta);
            table.checkRaiseOpportunityEmitted[keyOpp] = true;
        }

        const keyCr = `${tableId}|${handKey}|check_raise|${playerId}|${table.actionIndex}`;
        if (!table.checkRaiseEmitted[keyCr]) {
            emitEvent(tableId, player, "check_raise", { ...commonMeta, is_aggressor: true });
            table.checkRaiseEmitted[keyCr] = true;
        }
    }
}

function maybeEmitShowdownWin(tableId, table, player, type, commonMeta) {
    const playerId = String(player.id);
    const handKey = table.currentHandId || "nohand";

    if (type === "win" || commonMeta.hand_result === "win" || String(commonMeta.status_raw || "").toLowerCase().includes("winner")) {
        if (!table.winShowdownEmitted[playerId]) {
            emitEvent(tableId, player, "win_showdown", commonMeta);
            table.winShowdownEmitted[playerId] = true;
        }
    }

    if (String(commonMeta.status_raw || "").toLowerCase().includes("showdown")) {
        if (!table.showdownEmitted[playerId]) {
            emitEvent(tableId, player, "showdown", commonMeta);
            table.showdownEmitted[playerId] = true;
        }
    }

    const boardCards = commonMeta.board_cards || [];
    if (boardCards.length >= 5 && (type === "win" || String(commonMeta.status_raw || "").toLowerCase().includes("showdown"))) {
        const keySd = `${tableId}|${handKey}|showdown|${playerId}`;
        if (!table.showdownEmitted[keySd]) {
            emitEvent(tableId, player, "showdown", commonMeta);
            table.showdownEmitted[keySd] = true;
        }
    }
}

function detectActions(tableId, table, oldPlayers, msg) {
    const boardCards = extractBoardCards(msg);
    emitHandDealtIfNeeded(tableId);
    emitSawFlopIfNeeded(tableId, boardCards);

    Object.values(table.playersById).forEach(player => {
        const prev = oldPlayers[player.id];
        if (!prev) return;

        const oldStatus = String(prev.status || "").trim();
        const newStatus = String(player.status || "").trim();
        if (!oldStatus || !newStatus || oldStatus === newStatus) return;

        let type = mapStatusToType(newStatus);
        if (!type) return;

        if (table.currentStreet === "preflop" && type === "call") type = "call_preflop";
        if (table.currentStreet === "preflop" && type === "raise") type = "raise_preflop";

        const dedupeKey = `${tableId}_${player.id}_${type}_${table.currentHandId || "nohand"}_${table.currentStreet || "nostreet"}_${table.actionIndex}`;
        if (LAST_ACTION[dedupeKey]) return;
        LAST_ACTION[dedupeKey] = true;

        table.actionIndex = Number(table.actionIndex || 0) + 1;
        table.streetActionIndex = Number(table.streetActionIndex || 0) + 1;

        const isAggressor = type === "raise" || type === "raise_preflop" || type === "bet" || type === "allin";
        if (isAggressor) {
            table.lastAggressorId = String(player.id);
        }

        const commonMeta = {
            amount: msg.amountCall || null,
            stack_before: prev.stack,
            stack_after: player.stack,
            hand_id: table.currentHandId || null,
            street: table.currentStreet || "preflop",
            action_index: table.actionIndex,
            is_aggressor: isAggressor,
            hand_result: inferHandResult(type, newStatus),
            seat: player.seat || null,
            status_raw: newStatus,
            previous_status: oldStatus,
            raw_event_type: type,
            board_cards: boardCards
        };

        if (table.currentStreet === "preflop") {
            maybeEmitPreflopAdvanced(tableId, table, player, prev, type, commonMeta);
        } else if (table.currentStreet === "flop") {
            maybeEmitFlopAdvanced(tableId, table, player, type, commonMeta);
        }

        emitEvent(tableId, player, type, commonMeta);

        if (type === "check") {
            table.playerCheckedStreet[String(player.id)] = true;
        }

        if (["bet", "raise", "raise_preflop", "allin"].includes(type)) {
            table.lastAggressorId = String(player.id);
            table.streetBetCount += 1;

            if (table.currentStreet === "preflop") {
                if (!table.preflopAggressorId) table.preflopAggressorId = player.id;
                table.preflopRaiseCount += 1;
            }
        }

        if (type === "fold") {
            player.folded = true;
        }

        maybeEmitShowdownWin(tableId, table, player, type, commonMeta);
    });
}

function updatePlayersFromState(tableId, msg) {
    const table = ensureTable(tableId);
    const oldPlayers = {};

    Object.entries(table.playersById).forEach(([id, row]) => {
        oldPlayers[id] = { ...row };
    });

    syncTableHandContext(table, msg);

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
            stack: parseMoney(p.money),
            folded: String(p.status || "").toLowerCase().includes("fold")
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

    syncTableHandContext(table, msg);

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
            stack: parseMoney(p.money),
            folded: String(p.status || "").toLowerCase().includes("fold")
        };
        ensurePlayerStats(uid, name);
    });

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
    if (!STATE.hudVisible) closeDetailCard();
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
        ensureHudStyles();
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
