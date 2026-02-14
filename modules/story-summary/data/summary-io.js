// ═══════════════════════════════════════════════════════════════════════════
// Summary Import/Export
// 剧情总结数据导入导出（当前 chatId 级别）
// ═══════════════════════════════════════════════════════════════════════════

import { getContext } from "../../../../../../extensions.js";
import { xbLog } from "../../../core/debug-core.js";
import { getSummaryStore, saveSummaryStore } from "./store.js";

const MODULE_ID = "summary-io";
const EXPORT_VERSION = 1;
const EXPORT_FORMAT = "lwb-story-summary";

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function toInt(value, fallback = -1) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeSummaryJson(json) {
    if (!json || typeof json !== "object") return null;

    const normalized = structuredClone(json);
    normalized.keywords = Array.isArray(normalized.keywords) ? normalized.keywords : [];
    normalized.events = Array.isArray(normalized.events) ? normalized.events : [];
    normalized.arcs = Array.isArray(normalized.arcs) ? normalized.arcs : [];
    normalized.world = Array.isArray(normalized.world) ? normalized.world : [];

    normalized.characters = normalized.characters && typeof normalized.characters === "object"
        ? normalized.characters
        : {};
    normalized.characters.main = Array.isArray(normalized.characters.main) ? normalized.characters.main : [];
    normalized.characters.relationships = Array.isArray(normalized.characters.relationships)
        ? normalized.characters.relationships
        : [];

    return normalized;
}

function normalizeSummaryStore(rawStore) {
    const src = rawStore && typeof rawStore === "object" ? rawStore : {};

    const normalized = {
        lastSummarizedMesId: Math.max(-1, toInt(src.lastSummarizedMesId, -1)),
        hideSummarizedHistory: !!src.hideSummarizedHistory,
        keepVisibleCount: Math.max(0, Math.min(50, toInt(src.keepVisibleCount, 3))),
        summaryHistory: [],
        updatedAt: Date.now(),
        json: normalizeSummaryJson(src.json),
    };

    if (!normalized.json) {
        normalized.lastSummarizedMesId = -1;
        normalized.summaryHistory = [];
        normalized.hideSummarizedHistory = false;
        return normalized;
    }

    const history = Array.isArray(src.summaryHistory) ? src.summaryHistory : [];
    normalized.summaryHistory = history
        .map(item => ({ endMesId: toInt(item?.endMesId, -1) }))
        .filter(item => item.endMesId >= 0)
        .sort((a, b) => a.endMesId - b.endMesId);

    if (normalized.lastSummarizedMesId >= 0 && normalized.summaryHistory.length === 0) {
        normalized.summaryHistory = [{ endMesId: normalized.lastSummarizedMesId }];
    }

    return normalized;
}

function markAsCarryoverAddedAt(json) {
    if (!json || typeof json !== "object") return;

    (json.keywords || []).forEach((k) => {
        if (k && typeof k === "object") k._addedAt = -1;
    });
    (json.events || []).forEach((e) => {
        if (e && typeof e === "object") e._addedAt = -1;
    });
    (json.world || []).forEach((w) => {
        if (w && typeof w === "object") w._addedAt = -1;
    });

    (json.arcs || []).forEach((a) => {
        if (!a || typeof a !== "object") return;
        a._addedAt = -1;
        (a.moments || []).forEach((m) => {
            if (m && typeof m === "object") m._addedAt = -1;
        });
    });

    const chars = json.characters || {};
    (chars.main || []).forEach((m) => {
        if (m && typeof m === "object") m._addedAt = -1;
    });
    (chars.relationships || []).forEach((r) => {
        if (r && typeof r === "object") r._addedAt = -1;
    });
}

function getStoreFromImportPayload(parsed) {
    if (!parsed || typeof parsed !== "object") return null;

    if (parsed.format === EXPORT_FORMAT) {
        if (parsed.version !== EXPORT_VERSION) {
            throw new Error(`不支持的总结文件版本: ${parsed.version}`);
        }
        return parsed.data?.store ?? null;
    }

    if (parsed.store && typeof parsed.store === "object") {
        return parsed.store;
    }

    return parsed;
}

export async function exportSummaryData(onProgress) {
    const { chatId } = getContext();
    if (!chatId) {
        throw new Error("未打开聊天");
    }

    const store = getSummaryStore();
    if (!store?.json) {
        throw new Error("没有可导出的总结数据");
    }

    onProgress?.("构建导出数据...");

    const payload = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: Date.now(),
        chatId,
        data: {
            store: structuredClone(store),
        },
    };

    const jsonText = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonText], { type: "application/json" });
    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const shortChatId = chatId.slice(0, 8);
    const filename = `summary_${shortChatId}_${timestamp}.json`;

    onProgress?.("下载文件...");
    downloadBlob(blob, filename);

    const eventCount = store.json?.events?.length || 0;
    xbLog.info(MODULE_ID, `导出完成: ${filename}, events=${eventCount}`);

    return {
        filename,
        size: blob.size,
        eventCount,
    };
}

export async function importSummaryData(file, onProgress) {
    const { chatId, chat } = getContext();
    if (!chatId) {
        throw new Error("未打开聊天");
    }

    onProgress?.("读取文件...");
    const text = await file.text();

    onProgress?.("解析文件...");
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("JSON 解析失败");
    }

    const warnings = [];
    if (parsed?.format === EXPORT_FORMAT && parsed?.chatId && parsed.chatId !== chatId) {
        warnings.push(`聊天ID不匹配（文件: ${parsed.chatId}, 当前: ${chatId}）`);
    }

    const rawStore = getStoreFromImportPayload(parsed);
    if (!rawStore || typeof rawStore !== "object") {
        throw new Error("文件中缺少有效的总结数据");
    }

    onProgress?.("校验并写入...");
    const normalized = normalizeSummaryStore(rawStore);
    const currentLength = Array.isArray(chat) ? chat.length : 0;

    // cut 历史后导入旧总结：保留总结内容，但将当前聊天视为“未总结”
    if (currentLength >= 0 && normalized.lastSummarizedMesId >= currentLength) {
        warnings.push(
            `已检测到楼层越界（导入: ${normalized.lastSummarizedMesId + 1} 楼, 当前聊天: ${currentLength} 楼），` +
            "已自动重置为可继续增量总结模式"
        );
        normalized.lastSummarizedMesId = -1;
        normalized.summaryHistory = [];
        normalized.hideSummarizedHistory = false;
        markAsCarryoverAddedAt(normalized.json);
    }

    const store = getSummaryStore();
    if (!store) {
        throw new Error("当前聊天不可用");
    }

    Object.keys(store).forEach((key) => {
        delete store[key];
    });
    Object.assign(store, normalized);
    saveSummaryStore();

    const eventCount = normalized.json?.events?.length || 0;
    xbLog.info(MODULE_ID, `导入完成: events=${eventCount}`);

    return {
        eventCount,
        warnings,
        lastSummarizedMesId: normalized.lastSummarizedMesId,
    };
}
