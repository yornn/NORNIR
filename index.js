/*
 * Norse Calendar — расширение-виджет для SillyTavern.
 *
 * Показывает плавающий виджет с календарём, часами, текущей эйктой
 * и фазой Луны (Tungl), подхватывая дату и время из «инфоблока»
 * в сообщениях чата, например:
 *   [Date: 12 Góa 875 | Time: 14:30]
 *   Дата: 12 марта 875, время: Hádegi
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
    showMoon: true,         // показывать фазу Луны (Tungl)
    showEykt: true,         // показывать текущую эйкту
    collapsed: false,       // свёрнут ли виджет
    customRegex: "",        // пользовательский regex для инфоблока
    posX: null,             // сохранённая позиция виджета
    posY: null,
};

// Сколько последних сообщений сканировать в поисках инфоблока
const SCAN_DEPTH = 25;

/* ------------------------------------------------------------------ */
/* ЛОР: Викингские месяцы                                              */
/*                                                                     */
/* Vetr (зима):  Gormánaður (ноябрь), Ýlir (декабрь), Mörsugur (январь),*/
/*               Þorri (февраль), Góa (март), Einmánuður (апрель)      */
/* Sumar (лето): Harpa (май), Skerpla (июнь), Sólmánuður (июль),       */
/*               Heyannir (август), Tvímánuður (сентябрь),             */
/*               Haustmánuður (октябрь)                                */
/* ------------------------------------------------------------------ */

// Современные английские названия (при выключенных норс-названиях)
const MONTHS_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Викингские месяцы, индекс = номер современного месяца - 1
const MONTHS_NORSE = [
    "Mörsugur", "Þorri", "Góa", "Einmánuður", "Harpa", "Skerpla",
    "Sólmánuður", "Heyannir", "Tvímánuður", "Haustmánuður", "Gormánaður", "Ýlir",
];

const WEEKDAYS_SHORT_EN = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const WEEKDAYS_SHORT_NORSE = ["Mán", "Týs", "Óðn", "Þór", "Frj", "Lau", "Sun"];
const WEEKDAYS_FULL_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_FULL_NORSE = ["sunnudagr", "mánadagr", "týsdagr", "óðinsdagr", "þórsdagr", "frjádagr", "laugardagr"];

// Лор дней недели (индекс 0 = воскресенье / sunnudagr)
const WEEKDAY_DESC_EN = [
    "Day of the Sun", "Day of the Moon", "Day of Týr", "Day of Odin",
    "Day of Thor", "Day of Frigg / Freyja", "Bath day — day of washing",
];
const WEEKDAY_DESC_RU = [
    "День Солнца", "День Луны", "День Тюра", "День Одина",
    "День Тора", "День Фригг / Фрейи", "«Банный день» — день омовения",
];

// Названия дополнительных дней (Sumarauki / Auknætr) для распознавания
const AUK_STEMS = ["sumarauki", "aukn", "auk"];

// Сезоны: Vetr — ноябрь..апрель, Sumar — май..октябрь (+ Auknætr)
function seasonOf(month) {
    return isAuk(month) || (month >= 5 && month <= 10)
        ? { norse: "Sumar", ru: "Лето" }
        : { norse: "Vetr", ru: "Зима" };
}

// «Корни» названий месяцев для распознавания из чата.
// Индекс массива = современный месяц (0 = январь).
// Понимаем en / ru / norse / транслит, включая падежи (startsWith).
const MONTH_STEMS = [
    // 1 — Январь / Mörsugur
    ["jan", "янв", "mörs", "mors", "морс"],
    // 2 — Февраль / Þorri
    ["feb", "фев", "þor", "thor", "торр"],
    // 3 — Март / Góa
    ["mar", "мар", "góa", "goa", "гоа"],
    // 4 — Апрель / Einmánuður
    ["apr", "апр", "einm", "эйн"],
    // 5 — Май / Harpa
    ["may", "мая", "май", "harp", "харп"],
    // 6 — Июнь / Skerpla
    ["jun", "июн", "skerp", "скерп"],
    // 7 — Июль / Sólmánuður
    ["jul", "июл", "sólm", "solm", "сольм"],
    // 8 — Август / Heyannir
    ["aug", "авг", "heyan", "хейан"],
    // 9 — Сентябрь / Tvímánuður
    ["sep", "сен", "tvím", "tvim", "твим"],
    // 10 — Октябрь / Haustmánuður
    ["oct", "окт", "haust", "хауст"],
    // 11 — Ноябрь / Gormánaður
    ["nov", "ноя", "ной", "gorm", "горм"],
    // 12 — Декабрь / Ýlir
    ["dec", "дек", "ýl", "ylir", "юлир"],
];

/** Определяет номер месяца (1–12) по названию или числу. */
function monthFromName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    if (AUK_STEMS.some((s) => n.startsWith(s))) return "AUK";
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
/* ЛОР: Эйкты — 8 отрезков суток по 3 часа                             */
/* ------------------------------------------------------------------ */

const EYKTIR = [
    { norse: "Miðnætti",  en: "Midnatti", ru: "Миднатти", desc: "Полночь",                dir: "С",  start: 0,  mid: 1.5 },
    { norse: "Ótta",      en: "Otta",     ru: "Отта",     desc: "Ночь перед рассветом",   dir: "СВ", start: 3,  mid: 4.5 },
    { norse: "Morgun",    en: "Morgun",   ru: "Моргун",   desc: "Утро, подъём",           dir: "В",  start: 6,  mid: 7.5 },
    { norse: "Dagmál",    en: "Dagmal",   ru: "Дагмал",   desc: "Дневное время, завтрак", dir: "ЮВ", start: 9,  mid: 10.5 },
    { norse: "Hádegi",    en: "Hadegi",   ru: "Хадеги",   desc: "Полдень",                dir: "Ю",  start: 12, mid: 13.5 },
    { norse: "Undorn",    en: "Undorn",   ru: "Ундорн",   desc: "Полдник",                dir: "ЮЗ", start: 15, mid: 16.5 },
    { norse: "Miðaftann", en: "Midaftan", ru: "Мидафтан", desc: "Вечер",                  dir: "З",  start: 18, mid: 19.5 },
    { norse: "Náttmál",   en: "Nattmal",  ru: "Наттмал",  desc: "Ужин, ночь",             dir: "СЗ", start: 21, mid: 22.5 },
];

// Алиасы для распознавания эйкты из текста чата (все в нижнем регистре).
// Внимание к пересечениям: "полночь" содержит "ночь", "afternoon" содержит
// "noon" — побеждает алиас, встретившийся раньше в тексте.
const EYKT_ALIASES = [
    ["miðn", "midn", "мидн", "полноч", "midnight"],                          // Miðnætti
    ["ótta", "otta", "отта", "предрассвет", "рассвет"],                      // Ótta
    ["morgun", "моргун", "rismál", "rismal", "утро", "morning"],             // Morgun
    ["dagmál", "dagmal", "дагмал"],                                          // Dagmál
    ["hádegi", "hadegi", "хадеги", "полдень", "полдня", "midday", "noon"],   // Hádegi
    ["undorn", "ундорн", "полдник", "afternoon"],                            // Undorn
    ["miðaftan", "midaftan", "мидафтан", "вечер", "evening"],                // Miðaftann
    ["náttmál", "nattmal", "наттмал", "ужин", "ночь", "night"],              // Náttmál
];

/** Индекс эйкты по часу (0–24). */
function eyktForHour(hour) {
    return Math.floor((hour % 24) / 3) % 8;
}

/** Ищет название эйкты в тексте. Возвращает индекс эйкты или null. */
function eyktFromText(text) {
    const t = text.toLowerCase();
    let bestIdx = null;
    let bestPos = Infinity;
    for (let i = 0; i < EYKT_ALIASES.length; i++) {
        for (const alias of EYKT_ALIASES[i]) {
            const pos = t.indexOf(alias);
            if (pos !== -1 && pos < bestPos) {
                bestPos = pos;
                bestIdx = i;
            }
        }
    }
    return bestIdx;
}

/* ------------------------------------------------------------------ */
/* ЛОР: Фазы Луны (Tungl). Цикл 29.53 дня от астрономического          */
/* новолуния. Точка отсчёта: новолуние 2000-01-06 18:14 UTC.           */
/* ------------------------------------------------------------------ */

const MOON_CYCLE = 29.53;
// Точка отсчёта лунного цикла: 6 Mörsugur 2000 — соответствует реальному
// астрономическому новолунию 2000-01-06. Возраст считается по серийным
// дням лорного календаря (см. serialOf в разделе календарной математики).

const MOON_PHASES = [
    { norse: "Ný",             en: "New Moon",    ru: "Новолуние",      icon: "🌑", from: 0,    to: 1.8,
      desc: "Символ зарождения месяца, время планирования" },
    { norse: "Vaxandi tungl",  en: "Waxing Moon", ru: "Растущая луна",  icon: "🌒", from: 1.8,  to: 13.0,
      desc: "Время активных дел, похода и строительства" },
    { norse: "Fullt tungl",    en: "Full Moon",   ru: "Полнолуние",     icon: "🌕", from: 13.0, to: 16.5,
      desc: "Пик силы, время проведения священных Блотов и Тинга" },
    { norse: "Minnandi tungl", en: "Waning Moon", ru: "Убывающая луна", icon: "🌖", from: 16.5, to: 27.7,
      desc: "Время завершения дел, сбора урожая и возвращения домой" },
    { norse: "Nið",            en: "Dark Moon",   ru: "Безлуние",       icon: "🌚", from: 27.7, to: 29.53,
      desc: "Ночи волка Хати, время отдыха и осторожности перед рождением Ný" },
];

/** Возраст Луны и её фаза для заданной даты (по серийному дню календаря). */
function moonPhase(year, month, day) {
    const anchor = serialOf(2000, 1, 6); // 6 Mörsugur 2000 — новолуние
    const age = (((serialOf(year, month, day) - anchor) % MOON_CYCLE) + MOON_CYCLE) % MOON_CYCLE;
    const phase = MOON_PHASES.find((p) => age >= p.from && age < p.to) ?? MOON_PHASES[0];
    return { age, phase };
}

/* ------------------------------------------------------------------ */
/* Парсинг даты и времени из текста                                    */
/* ------------------------------------------------------------------ */

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;

// Встроенные форматы даты. map() должен вернуть {day, month, year} или null.
const DATE_PATTERNS = [
    {
        // "12 March 875", "12th of March, 875", "12 марта 875", "12 Góa 875"
        re: /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([^\W\d_]+)\s*,?\s*(\d{3,4})?/giu,
        map: (m) => ({ day: +m[1], month: monthFromName(m[2]), year: m[3] ? +m[3] : null }),
    },
    {
        // "March 12, 875", "Góa 12, 875"
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
    // Auknætr: 4 дня (5 в високосный год) — здесь допускаем 1..5
    if (d.month === "AUK") {
        if (!d.day || d.day < 1 || d.day > 5) return false;
    } else {
        if (!d.month || d.month < 1 || d.month > 12) return false;
        if (!d.day || d.day < 1 || d.day > 30) return false; // в месяце ровно 30 дней
    }
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

    // 3. Время: сначала точное ЧЧ:ММ, затем название эйкты
    date.hour = null;
    date.minute = null;
    const tm = text.match(TIME_PATTERN);
    if (tm) {
        const h = parseInt(tm[1], 10);
        const min = parseInt(tm[2], 10);
        if (h >= 0 && h <= 24 && min >= 0 && min <= 59) {
            date.hour = h;
            date.minute = min;
            return date;
        }
    }
    const eyktIdx = eyktFromText(text);
    if (eyktIdx !== null) {
        const mid = EYKTIR[eyktIdx].mid;
        date.hour = Math.floor(mid);
        date.minute = Math.round((mid % 1) * 60);
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

/** Дополнительные дни (Sumarauki / Auknætr): 4, в високосный год — 5. */
function aukDays(year) {
    return isLeapYear(year) ? 5 : 4;
}

function isAuk(month) {
    return month === "AUK";
}

/** В каждом месяце ровно 30 дней; у Auknætr — 4–5 ночей. */
function daysInMonth(year, month) {
    return isAuk(month) ? aukDays(year) : 30;
}

function leapsBefore(year) {
    const y = year - 1;
    return Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

/**
 * Серийный номер дня в лорном календаре.
 * Год = 12 месяцев по 30 дней (360) + Auknætr (364 / 365 дней).
 * Auknætr стоит между Sólmánuður (7) и Heyannir (8).
 */
function serialOf(year, month, day) {
    let doy; // день года (1-based)
    if (isAuk(month)) {
        doy = 7 * 30 + day;
    } else {
        doy = (month - 1) * 30 + day + (month > 7 ? aukDays(year) : 0);
    }
    return (year - 1) * 364 + leapsBefore(year) + doy - 1;
}

function serialToDate(serial) {
    let y = Math.max(1, Math.floor(serial / 364.25) + 1);
    while (serial < serialOf(y, 1, 1)) y--;
    while (serial >= serialOf(y + 1, 1, 1)) y++;
    const rem = serial - serialOf(y, 1, 1); // 0-based день года
    const auk = aukDays(y);
    if (rem < 7 * 30) {
        return { year: y, month: Math.floor(rem / 30) + 1, day: (rem % 30) + 1 };
    }
    if (rem < 7 * 30 + auk) {
        return { year: y, month: "AUK", day: rem - 7 * 30 + 1 };
    }
    const rem2 = rem - auk;
    return { year: y, month: Math.floor(rem2 / 30) + 1, day: (rem2 % 30) + 1 };
}

/** День недели (0 = воскресенье). 1 Mörsugur года 1 — mánadagr (понедельник). */
function weekdayOf(year, month, day) {
    return (serialOf(year, month, day) + 1) % 7;
}

/** Прибавляет n дней к дате (понимает переход через Auknætr и границы лет). */
function addDays(year, month, day, n) {
    return serialToDate(serialOf(year, month, day) + n);
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

    // Auknætr: счёт дней месяца отключён — показываем особый статус
    if (!dimmed && isAuk(month)) {
        const total = aukDays(year);
        grid.append($("<div>", { "class": "ncw-auk-title", text: "— Sumarauki · Auknætr —" }));
        for (let d = 1; d <= total; d++) {
            const cls = d === day ? "ncw-cell ncw-day ncw-aukday ncw-today" : "ncw-cell ncw-day ncw-aukday";
            grid.append($("<div>", { "class": cls, text: d }));
        }
        return;
    }

    const shortNames = s.norseNames ? WEEKDAYS_SHORT_NORSE : WEEKDAYS_SHORT_EN;
    for (let i = 0; i < shortNames.length; i++) {
        const wd = (i + 1) % 7; // порядок с понедельника
        const tip = s.norseNames
            ? `${WEEKDAYS_FULL_NORSE[wd]} — ${WEEKDAY_DESC_RU[wd]}`
            : `${WEEKDAYS_FULL_EN[wd]} — ${WEEKDAY_DESC_EN[wd]}`;
        grid.append($("<div>", { "class": "ncw-cell ncw-wd", text: shortNames[i], title: tip }));
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

/** Строка эйкты: название — описание (сторона света). */
function renderEykt() {
    const s = extension_settings[extensionName];
    const el = $("#ncw-eykt");
    if (!s.showEykt || state.hour === null || state.source === "none") {
        el.hide();
        return;
    }
    const idx = eyktForHour(state.hour);
    const e = EYKTIR[idx];
    const name = s.norseNames ? e.norse : e.en;
    const h0 = String(e.start).padStart(2, "0");
    const h1 = String((e.start + 3) % 24).padStart(2, "0");
    el.text(`${name} — ${e.desc} (${e.dir})`)
        .attr("title", `${idx + 1}-я эйкта · ${h0}:00–${h1}:00 · ${e.ru}`)
        .show();
}

/** Строка сезона и фазы Луны (Tungl). */
function renderMoon() {
    const s = extension_settings[extensionName];
    const el = $("#ncw-moon");
    const hasDate = state.source !== "none" && state.day && state.month;
    if (!s.showMoon || !hasDate) {
        el.hide();
        return;
    }
    const { age, phase } = moonPhase(state.year, state.month, state.day);
    const season = seasonOf(state.month);
    const phaseName = s.norseNames ? phase.norse : phase.en;
    el.text(`${season.norse} · ${phase.icon} ${phaseName} · ${phase.ru}`)
        .attr("title", `${phase.desc}\nДень ${age.toFixed(1)} лунного цикла · ${season.norse} — ${season.ru}`)
        .show();
}

function renderAll(force = false) {
    if (!extension_settings[extensionName].enabled) return;
    const s = extension_settings[extensionName];

    // Часы
    $("#ncw-clock").text(formatTime(state.hour, state.minute));

    // Эйкта
    renderEykt();

    // Строка даты
    if (state.source === "none" || !state.day || !state.month) {
        $("#ncw-date").removeAttr("title").text("— no date in chat —");
    } else if (isAuk(state.month)) {
        const total = aukDays(state.year);
        $("#ncw-date")
            .text(`Sumarauki (Auknætr) — ${state.day} / ${total}, ${state.year}`)
            .attr("title", "Летнее прибавление: особые дни в середине лета перед сенокосом. Счёт дней месяца отключён.");
    } else {
        const wdIdx = weekdayOf(state.year, state.month, state.day);
        const wdFull = s.norseNames ? WEEKDAYS_FULL_NORSE[wdIdx] : WEEKDAYS_FULL_EN[wdIdx];
        const monthName = s.norseNames ? MONTHS_NORSE[state.month - 1] : MONTHS_EN[state.month - 1];
        $("#ncw-date").removeAttr("title").text(`${wdFull}, ${state.day} ${monthName} ${state.year}`);
    }

    // Сезон + Луна
    renderMoon();

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
    state.day = Math.min(now.getDate(), 30); // в лорном месяце ровно 30 дней
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
            $("<div>", { id: "ncw-eykt" }),
            $("<div>", { id: "ncw-date", text: "—" }),
            $("<div>", { id: "ncw-moon" }),
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
    bindCheckbox("#nc_moon", "showMoon", () => renderAll(true));
    bindCheckbox("#nc_eykt", "showEykt", () => renderAll(true));

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
