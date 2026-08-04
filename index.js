/*
 * Norse Calendar — расширение-виджет для SillyTavern.
 *
 * Показывает плавающий виджет с календарём и часами, подхватывая
 * дату и время из «инфоблока» в сообщениях чата, например:
 *   [Date: 12 March 875 | Time: 14:30]
 *   Дата: 12 марта 875, время: 21:45
 *   875-03-12 14:30
 *
 * Расширение чисто визуальное и никак не влияет на генерацию.
 *
 * Написано по официальному гайду:
 * https://docs.sillytavern.app/for-contributors/writing-extensions/
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// Имя должно совпадать с именем папки расширения
const extensionName = "Norse-Calendar";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Настройки по умолчанию
const defaultSettings = {
    enabled: true,          // показывать виджет
    realTimeFallback: true, // показывать реальное время, если в чате даты нет
    tickLoreTime: false,    // «тикать» ли время из чата в реальном темпе
    norseNames: true,       // скандинавские названия месяцев/дней недели
    hours24: true,          // 24-часовой формат часов
    collapsed: false,       // свёрнут ли виджет
    customRegex: "",        // пользовательский regex для инфоблока
    posX: null,             // сохранённая позиция виджета
    posY: null,
};

// Сколько последних сообщений сканировать в поисках инфоблока
const SCAN_DEPTH = 25;

/* ------------------------------------------------------------------ */
/* Названия месяцев и дней недели                                      */
/* ------------------------------------------------------------------ */

const MONTHS_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Упрощённое соответствие месяцам современного календаря
const MONTHS_NORSE = [
    "Þorri", "Gói", "Einmánuðr", "Harpa", "Skerpla", "Sólmánuðr",
    "Heyannir", "Kornskurðarmánuðr", "Haustmánuðr", "Frermánuðr",
    "Hrútmánuðr", "Jólmánuðr",
];

const WEEKDAYS_SHORT_EN = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const WEEKDAYS_SHORT_NORSE = ["Mán", "Týs", "Óðn", "Þór", "Frj", "Lau", "Sun"];
const WEEKDAYS_FULL_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_FULL_NORSE = ["sunnudagr", "mánadagr", "týsdagr", "óðinsdagr", "þórsdagr", "frjádagr", "laugardagr"];

// «Корни» названий месяцев для распознавания (en/ru/norse, включая падежи)
const MONTH_STEMS = [
    ["jan", "янв", "þorri"],
    ["feb", "фев", "gói", "goi"],
    ["mar", "мар", "einm"],
    ["apr", "апр", "harpa"],
    ["may", "мая", "май", "skerpla"],
    ["jun", "июн", "sólm", "solm"],
    ["jul", "июл", "heyan"],
    ["aug", "авг", "korn"],
    ["sep", "сен", "haust"],
    ["oct", "окт", "frer"],
    ["nov", "ноя", "ной", "hrút", "hrut"],
    ["dec", "дек", "jól", "jol"],
];

/** Определяет номер месяца (1–12) по названию или числу. */
function monthFromName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    if (/^\d{1,2}$/.test(n)) {
        const v = parseInt(n, 10);
        return v >= 1 && v <= 12 ? v : null;
    }
    for (let i = 0; i < MONTH_STEMS.length; i++) {
        if (MONTH_STEMS[i].some((s) => n.startsWith(s))) return i + 1;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Парсинг даты и времени из текста                                    */
/* ------------------------------------------------------------------ */

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;

// Встроенные форматы даты. map() должен вернуть {day, month, year} или null.
const DATE_PATTERNS = [
    {
        // "12 March 875", "12th of March, 875", "12 марта 875"
        re: /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([^\W\d_]+)\s*,?\s*(\d{3,4})?/giu,
        map: (m) => ({ day: +m[1], month: monthFromName(m[2]), year: m[3] ? +m[3] : null }),
    },
    {
        // "March 12, 875"
        re: /([^\W\d_]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{3,4})?/giu,
        map: (m) => ({ day: +m[2], month: monthFromName(m[1]), year: m[3] ? +m[3] : null }),
    },
    {
        // "875-03-12"
        re: /(\d{3,4})-(\d{1,2})-(\d{1,2})/g,
        map: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
    },
    {
        // "12.03.875" или "12/03/875" (день.месяц.год)
        re: /(\d{1,2})[./](\d{1,2})[./](\d{2,4})/g,
        map: (m) => ({ day: +m[1], month: +m[2], year: +m[3] }),
    },
];

/** Проверяет, что распарсенная дата правдоподобна. */
function isValidDate(d) {
    if (!d) return false;
    if (!d.month || d.month < 1 || d.month > 12) return false;
    if (!d.day || d.day < 1 || d.day > 31) return false;
    if (d.year !== null && (isNaN(d.year) || d.year < 1)) return false;
    return true;
}

/** Парсинг по пользовательскому regex с именованными группами. */
function parseWithCustomRegex(text) {
    const src = extension_settings[extensionName].customRegex?.trim();
    if (!src) return null;
    let re;
    try {
        re = new RegExp(src, "i");
    } catch (e) {
        console.warn(`[${extensionName}] Некорректный customRegex:`, e);
        return null;
    }
    const m = text.match(re);
    if (!m || !m.groups) return null;
    const g = m.groups;
    const date = {
        day: g.day ? parseInt(g.day, 10) : null,
        month: g.month ? monthFromName(g.month) : null,
        year: g.year ? parseInt(g.year, 10) : null,
    };
    if (!isValidDate(date)) return null;
    date.hour = g.hour !== undefined ? parseInt(g.hour, 10) : null;
    date.minute = g.minute !== undefined ? parseInt(g.minute, 10) : null;
    return date;
}

/**
 * Ищет дату и время в тексте сообщения.
 * Возвращает {day, month, year, hour, minute} или null.
 */
function parseDateTime(text) {
    // 1. Пользовательский regex имеет приоритет
    const custom = parseWithCustomRegex(text);
    if (custom) return custom;

    // 2. Встроенные форматы даты
    let date = null;
    for (const { re, map } of DATE_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const candidate = map(m);
            if (isValidDate(candidate)) {
                date = candidate;
                break;
            }
        }
        if (date) break;
    }
    if (!date) return null;

    // 3. Время (опционально) — первое вхождение ЧЧ:ММ в сообщении
    date.hour = null;
    date.minute = null;
    const tm = text.match(TIME_PATTERN);
    if (tm) {
        const h = parseInt(tm[1], 10);
        const min = parseInt(tm[2], 10);
        if (h >= 0 && h <= 24 && min >= 0 && min <= 59) {
            date.hour = h;
            date.minute = min;
        }
    }
    return date;
}

/** Сканирует чат с конца в поисках последнего инфоблока с датой. */
function findLoreDateTime() {
    const context = getContext();
    const chat = context?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const from = Math.max(0, chat.length - SCAN_DEPTH);
    for (let i = chat.length - 1; i >= from; i--) {
        const text = chat[i]?.mes;
        if (typeof text !== "string" || !text) continue;
        const parsed = parseDateTime(text);
        if (parsed) return parsed;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Календарная математика                                              */
/* ------------------------------------------------------------------ */

function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** День недели (0 = воскресенье). Корректно работает с годами < 100. */
function weekdayOf(year, month, day) {
    const d = new Date(2000, 0, 1);
    d.setFullYear(year, month - 1, day);
    d.setHours(12, 0, 0, 0);
    return d.getDay();
}

/** Прибавляет n дней к дате, корректно обрабатывая переполнение. */
function addDays(year, month, day, n) {
    const d = new Date(2000, 0, 1);
    d.setFullYear(year, month - 1, day + n);
    d.setHours(12, 0, 0, 0);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/* ------------------------------------------------------------------ */
/* Состояние и рендер виджета                                          */
/* ------------------------------------------------------------------ */

const state = {
    source: "none", // "lore" | "real" | "none"
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    loreBase: null,   // {at, year, month, day, hour, minute} для «тикающего» времени
    lastElapsed: -1,
    lastDateKey: "",
};

let tickTimer = null;
let refreshTimer = null;

function formatTime(h, m) {
    if (h === null || m === null) return "--:--";
    const mm = String(m).padStart(2, "0");
    if (extension_settings[extensionName].hours24) {
        return `${String(h).padStart(2, "0")}:${mm}`;
    }
    const ap = h >= 12 ? "PM" : "AM";
    let hh = h % 12;
    if (hh === 0) hh = 12;
    return `${hh}:${mm} ${ap}`;
}

/** Строит сетку календаря для state (или реальной даты, если данных нет). */
function buildGrid() {
    const s = extension_settings[extensionName];
    const grid = $("#ncw-grid").empty();

    let { year, month, day } = state;
    const dimmed = state.source === "none" || !day || !month;
    if (dimmed) {
        const now = new Date();
        year = now.getFullYear();
        month = now.getMonth() + 1;
        day = null; // без подсветки
    }
    grid.toggleClass("ncw-dim", dimmed);

    const shortNames = s.norseNames ? WEEKDAYS_SHORT_NORSE : WEEKDAYS_SHORT_EN;
    for (const n of shortNames) {
        grid.append($("<div>", { "class": "ncw-cell ncw-wd", text: n }));
    }

    // Неделя начинается с понедельника
    const offset = (weekdayOf(year, month, 1) + 6) % 7;
    for (let i = 0; i < offset; i++) {
        grid.append($("<div>", { "class": "ncw-cell ncw-empty" }));
    }

    const dim = daysInMonth(year, month);
    for (let d = 1; d <= dim; d++) {
        const cls = d === day ? "ncw-cell ncw-day ncw-today" : "ncw-cell ncw-day";
        grid.append($("<div>", { "class": cls, text: d }));
    }
}

function renderAll(force = false) {
    if (!extension_settings[extensionName].enabled) return;
    const s = extension_settings[extensionName];

    // Часы
    $("#ncw-clock").text(formatTime(state.hour, state.minute));

    // Строка даты
    if (state.source === "none" || !state.day || !state.month) {
        $("#ncw-date").text("— no date in chat —");
    } else {
        const wdIdx = weekdayOf(state.year, state.month, state.day);
        const wdFull = s.norseNames ? WEEKDAYS_FULL_NORSE[wdIdx] : WEEKDAYS_FULL_EN[wdIdx];
        const monthName = s.norseNames ? MONTHS_NORSE[state.month - 1] : MONTHS_EN[state.month - 1];
        $("#ncw-date").text(`${wdFull}, ${state.day} ${monthName} ${state.year}`);
    }

    // Сетка перестраивается только при смене даты или настроек
    const dateKey = `${state.source}|${state.year}|${state.month}|${state.day}|${s.norseNames}`;
    if (force || dateKey !== state.lastDateKey) {
        state.lastDateKey = dateKey;
        buildGrid();
    }

    // Подпись источника времени
    const srcText = {
        lore: "⚔ chat time",
        real: "🕯 real time",
        none: "no infoblock found",
    }[state.source];
    $("#ncw-source").text(`— ${srcText} —`);
}

/* ------------------------------------------------------------------ */
/* Обновление состояния из чата / реального времени                    */
/* ------------------------------------------------------------------ */

function stopTicking() {
    if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
    }
}

function startTicking() {
    stopTicking();
    tickTimer = setInterval(() => {
        if (state.source === "real") {
            applyReal();
        } else if (state.source === "lore") {
            advanceLore();
        }
        renderAll();
    }, 10000);
}

function applyReal() {
    const now = new Date();
    state.source = "real";
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;
    state.day = now.getDate();
    state.hour = now.getHours();
    state.minute = now.getMinutes();
}

function applyLore(lore) {
    const now = new Date();
    state.source = "lore";
    state.year = lore.year ?? now.getFullYear();
    state.month = lore.month;
    state.day = lore.day;
    state.hour = lore.hour;
    state.minute = lore.minute;
    state.lastElapsed = -1;
    state.loreBase = {
        at: Date.now(),
        year: state.year,
        month: state.month,
        day: state.day,
        hour: lore.hour,
        minute: lore.minute,
    };
}

/** Продвигает «время мира» в реальном темпе (если включено). */
function advanceLore() {
    const base = state.loreBase;
    if (!base || base.hour === null) return;
    const elapsedMin = Math.floor((Date.now() - base.at) / 60000);
    if (elapsedMin === state.lastElapsed) return;
    state.lastElapsed = elapsedMin;
    const total = base.hour * 60 + base.minute + elapsedMin;
    const dayShift = Math.floor(total / 1440);
    const minutes = total % 1440;
    const d = addDays(base.year, base.month, base.day, dayShift);
    state.year = d.year;
    state.month = d.month;
    state.day = d.day;
    state.hour = Math.floor(minutes / 60);
    state.minute = minutes % 60;
}

/** Полное обновление: ищем дату в чате и перерисовываем виджет. */
function refresh() {
    const s = extension_settings[extensionName];
    stopTicking();
    const lore = findLoreDateTime();
    if (lore) {
        applyLore(lore);
        renderAll(true);
        if (s.tickLoreTime && lore.hour !== null) startTicking();
    } else if (s.realTimeFallback) {
        applyReal();
        renderAll(true);
        startTicking();
    } else {
        state.source = "none";
        state.day = null;
        state.month = null;
        state.hour = null;
        state.minute = null;
        renderAll(true);
    }
}

function refreshDebounced() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 200);
}

/* ------------------------------------------------------------------ */
/* Построение виджета, перетаскивание, сворачивание                    */
/* ------------------------------------------------------------------ */

function buildWidget() {
    const s = extension_settings[extensionName];

    const widget = $("<div>", { id: "norse-calendar-widget" }).append(
        $("<div>", { id: "ncw-header" }).append(
            $("<span>", { "class": "ncw-runes", text: "ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ" }),
            $("<span>", { id: "ncw-collapse", title: "Collapse / expand", text: "–" }),
        ),
        $("<div>", { id: "ncw-body" }).append(
            $("<div>", { id: "ncw-clock", text: "--:--" }),
            $("<div>", { id: "ncw-date", text: "—" }),
            $("<div>", { id: "ncw-grid" }),
            $("<div>", { id: "ncw-source" }),
        ),
    );

    $("body").append(widget);
    widget.toggle(s.enabled);
    widget.toggleClass("ncw-collapsed", s.collapsed);
    $("#ncw-collapse").text(s.collapsed ? "+" : "–");

    // Восстанавливаем сохранённую позицию
    if (s.posX !== null && s.posY !== null) {
        const el = widget.get(0);
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.left = `${s.posX}px`;
        el.style.top = `${s.posY}px`;
    }

    // Сворачивание по кнопке в шапке
    $("#ncw-collapse").on("click", () => {
        const collapsed = !widget.hasClass("ncw-collapsed");
        widget.toggleClass("ncw-collapsed", collapsed);
        $("#ncw-collapse").text(collapsed ? "+" : "–");
        extension_settings[extensionName].collapsed = collapsed;
        saveSettingsDebounced();
    });

    enableDrag(widget.get(0), document.getElementById("ncw-header"));
}

/** Перетаскивание виджета за шапку с сохранением позиции. */
function enableDrag(widgetEl, handleEl) {
    let startX, startY, originX, originY, dragging = false;

    handleEl.addEventListener("pointerdown", (e) => {
        if (e.target.id === "ncw-collapse") return;
        dragging = true;
        const r = widgetEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        originX = r.left;
        originY = r.top;
        widgetEl.style.right = "auto";
        widgetEl.style.bottom = "auto";
        handleEl.setPointerCapture(e.pointerId);
    });

    handleEl.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        widgetEl.style.left = `${originX + e.clientX - startX}px`;
        widgetEl.style.top = `${originY + e.clientY - startY}px`;
    });

    handleEl.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        extension_settings[extensionName].posX = parseInt(widgetEl.style.left, 10);
        extension_settings[extensionName].posY = parseInt(widgetEl.style.top, 10);
        saveSettingsDebounced();
    });
}

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
}

function bindCheckbox(selector, key, onChange) {
    const $el = $(selector);
    $el.prop("checked", extension_settings[extensionName][key]);
    $el.on("input", function () {
        extension_settings[extensionName][key] = Boolean($(this).prop("checked"));
        saveSettingsDebounced();
        if (onChange) onChange(extension_settings[extensionName][key]);
    });
}

function bindSettings() {
    bindCheckbox("#nc_enabled", "enabled", (v) => {
        $("#norse-calendar-widget").toggle(v);
        if (v) refresh();
    });
    bindCheckbox("#nc_realtime", "realTimeFallback", refresh);
    bindCheckbox("#nc_tick", "tickLoreTime", refresh);
    bindCheckbox("#nc_norse", "norseNames", () => renderAll(true));
    bindCheckbox("#nc_24h", "hours24", () => renderAll(true));

    const $re = $("#nc_regex");
    $re.val(extension_settings[extensionName].customRegex);
    $re.on("input", function () {
        extension_settings[extensionName].customRegex = String($(this).val());
        saveSettingsDebounced();
        refreshDebounced();
    });

    $("#nc_reset_pos").on("click", () => {
        extension_settings[extensionName].posX = null;
        extension_settings[extensionName].posY = null;
        saveSettingsDebounced();
        const el = document.getElementById("norse-calendar-widget");
        el.style.left = "";
        el.style.top = "";
        el.style.right = "";
        el.style.bottom = "";
        toastr.info("Norse Calendar: widget position reset");
    });
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

jQuery(async () => {
    loadSettings();

    // Панель настроек (правая колонка — для визуальных расширений)
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        const target = $("#extensions_settings2").length ? "#extensions_settings2" : "#extensions_settings";
        $(target).append(settingsHtml);
        bindSettings();
    } catch (e) {
        console.error(`[${extensionName}] Не удалось загрузить settings.html:`, e);
    }

    buildWidget();
    refresh();

    // Реагируем на изменения в чате
    const events = [
        event_types.CHAT_CHANGED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
    ].filter(Boolean);
    for (const ev of events) {
        eventSource.on(ev, refreshDebounced);
    }

    console.log(`[${extensionName}] loaded`);
});
