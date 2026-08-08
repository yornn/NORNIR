/*
 * Norse Calendar — состояние сцены, привязанное к сообщениям чата.
 *
 * Источник правды — последнее актуальное сообщение {{char}}, а не какое-то
 * «текущее состояние» внутри расширения. Разобранный снимок сцены лежит
 * в msg.extra, и этим всё решается само собой:
 *
 *  - SillyTavern держит на каждый свайп свою копию extra (swipe_info[i].extra)
 *    и подставляет её обратно при переключении, так что у каждой перегенерации
 *    своя погода, одежда и мысль;
 *  - удалили сообщение — оно ушло из chat[] вместе со своими данными, и поиск
 *    с конца находит предыдущее;
 *  - откат назад работает без отдельной логики, потому что откатывать нечего.
 *
 * Ровно на этом ломаются трекеры с глобальным состоянием: оно двигается только
 * вперёд, и после удаления сообщения инфоблок показывает данные, которых в чате
 * уже нет.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Keys & Stamps ...... Ключи в extra и отпечаток генерации
 * 2. Sync ............... Приведение сообщения к каноническому виду
 * 3. Lookup ............. Поиск актуального состояния в чате
 * 4. Maintenance ........ Разовый проход по всей истории
 */

import { hasYorniMarker, parseYorniTag, stripYorniMarkers } from "./parser.js";

/* ============================================================
 * 1. KEYS & STAMPS
 * ============================================================ */

/** Разобранный снимок сцены. */
const KEY_STATE = "norseCalendar";
/** Исходный маркер — чтобы перечитать его, если парсер поумнеет. */
const KEY_MARKER = "norseMarker";
/** Отпечаток генерации, которой принадлежит снимок. */
const KEY_STAMP = "norseStamp";

/** Глубина поиска состояния вверх по чату. */
export const SCAN_DEPTH = 25;

/**
 * Отпечаток конкретной генерации сообщения.
 *
 * `gen_finished` меняется при каждой новой генерации и хранится
 * в swipe_info вместе с extra, поэтому по нему видно, относится ли снимок
 * к текущему свайпу. Правка текста руками отпечаток не меняет — значит,
 * отредактированная проза не уносит с собой календарь.
 */
function stampOf(msg) {
    return String(msg?.gen_finished ?? msg?.send_date ?? "");
}

function clearKeys(msg) {
    let changed = false;
    for (const key of [KEY_STATE, KEY_MARKER, KEY_STAMP]) {
        if (msg.extra?.[key] !== undefined) {
            delete msg.extra[key];
            changed = true;
        }
    }
    return changed;
}

/** Вырезает сам маркер из текста — то, что показывается в чате. */
function markerOf(text) {
    const clean = stripYorniMarkers(text);
    const raw = String(text ?? "");
    // Маркер — это разница между исходником и очищенным текстом. Хранить его
    // отдельно надёжнее, чем весь сырой текст: правка прозы его не затрагивает.
    if (clean === raw) return null;
    const m = raw.match(/<!--\s*\[YORNI:[\s\S]*?\]\s*-->|<!--\s*\[YORNI:[\s\S]*$|<yorni>[\s\S]*?<\/yorni>/i);
    return m ? m[0] : null;
}

/* ============================================================
 * 2. SYNC
 * ============================================================ */

/**
 * Приводит сообщение к каноническому виду.
 *
 * Снимок всегда выводится из ТЕКСТА ЭТОГО СВАЙПА. Если маркера в нём нет,
 * а в extra висит чужой снимок (SillyTavern копирует extra в новый свайп) —
 * снимок удаляется, а не остаётся показываться от прошлой генерации.
 *
 * Идемпотентна: повторный вызов на уже обработанном сообщении ничего не меняет.
 *
 * @param {object} msg Сообщение чата
 * @param {{ keepMarker?: boolean }} options keepMarker — не вырезать маркер (режим отладки)
 * @returns {boolean} true, если сообщение изменилось и чат стоит сохранить
 */
export function syncMessage(msg, { keepMarker = false } = {}) {
    if (!msg || msg.is_user || typeof msg.mes !== "string") return false;
    msg.extra = msg.extra || {};

    // 1. В тексте есть маркер — свежая генерация, она и есть источник.
    if (hasYorniMarker(msg.mes)) {
        const parsed = parseYorniTag(msg.mes);
        const marker = markerOf(msg.mes);
        if (!parsed) {
            // Маркер есть, но пустой или сплошь плейсхолдеры — данных нет.
            return clearKeys(msg) || stripMarker(msg, keepMarker);
        }
        let changed = false;
        if (JSON.stringify(msg.extra[KEY_STATE]) !== JSON.stringify(parsed)) {
            msg.extra[KEY_STATE] = parsed;
            changed = true;
        }
        if (msg.extra[KEY_MARKER] !== marker) { msg.extra[KEY_MARKER] = marker; changed = true; }
        const stamp = stampOf(msg);
        if (msg.extra[KEY_STAMP] !== stamp) { msg.extra[KEY_STAMP] = stamp; changed = true; }
        return stripMarker(msg, keepMarker) || changed;
    }

    // 2. Маркера в тексте нет, но есть снимок от ЭТОЙ же генерации — он валиден.
    if (msg.extra[KEY_STATE] && msg.extra[KEY_STAMP] === stampOf(msg)) {
        // Перечитываем сохранённый маркер: если парсер с тех пор стал умнее,
        // снимок подтянется сам, без повторной генерации.
        const marker = msg.extra[KEY_MARKER];
        if (typeof marker === "string") {
            const reparsed = parseYorniTag(marker);
            if (reparsed && JSON.stringify(reparsed) !== JSON.stringify(msg.extra[KEY_STATE])) {
                msg.extra[KEY_STATE] = reparsed;
                return true;
            }
        }
        return false;
    }

    // 3. Ни маркера, ни своего снимка — чужие данные тут висеть не должны.
    return clearKeys(msg);
}

/** Убирает маркер из видимого текста и из копии текущего свайпа. */
function stripMarker(msg, keepMarker) {
    if (keepMarker) return false;
    const clean = stripYorniMarkers(msg.mes);
    if (clean === msg.mes) return false;
    msg.mes = clean;
    // Свайпы держат собственную копию текста — иначе маркер вернётся при переключении.
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === "number") {
        const current = msg.swipes[msg.swipe_id];
        if (typeof current === "string") msg.swipes[msg.swipe_id] = stripYorniMarkers(current);
    }
    return true;
}

/* ============================================================
 * 3. LOOKUP
 * ============================================================ */

/**
 * Ищет актуальное состояние сцены: скан с конца до первого сообщения
 * {{char}} со снимком.
 *
 * По дороге лениво синхронизирует сообщения — так подхватываются старые чаты
 * с видимыми блоками <yorni> без отдельной миграции.
 *
 * @param {Array} chat Массив сообщений
 * @param {{ keepMarker?: boolean }} options
 * @returns {{ state: object, index: number, changed: boolean }|null}
 */
export function findLatestState(chat, options = {}) {
    if (!Array.isArray(chat) || chat.length === 0) return null;

    let changed = false;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== "string") continue;
        if (msg.is_user) continue;

        if (syncMessage(msg, options)) changed = true;

        const state = msg.extra?.[KEY_STATE];
        if (state) return { state, index: i, changed };

        if (chat.length - 1 - i >= SCAN_DEPTH) break;
    }
    return changed ? { state: null, index: -1, changed } : null;
}

/* ============================================================
 * 4. MAINTENANCE
 * ============================================================ */

/**
 * Разовый проход по всей истории: разобрать маркеры, вырезать их из текста.
 * Используется при смене чата (миграция старых блоков) и кнопкой в настройках.
 *
 * @returns {number} Сколько сообщений изменилось
 */
export function syncWholeChat(chat, options = {}) {
    if (!Array.isArray(chat)) return 0;
    let count = 0;
    for (const msg of chat) {
        if (syncMessage(msg, options)) count++;
    }
    return count;
}

/** Есть ли в истории необработанные маркеры (в том числе старые <yorni>). */
export function chatHasRawMarkers(chat) {
    if (!Array.isArray(chat)) return false;
    return chat.some((m) => m && !m.is_user && typeof m.mes === "string" && hasYorniMarker(m.mes));
}
