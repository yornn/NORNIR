/*
 * Norse Calendar — расширение-виджет для SillyTavern.
 *
 * Показывает плавающий виджет в формате Yorni: текущая эйкта,
 * положение солнца, дата, день недели и фаза Луны (Tungl).
 * Данные подхватываются только из «инфоблока» в сообщениях чата,
 * например: [Date: 12 Góa 875 | Time: Hádegi]
 * Реальное время не используется.
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
    enabled: true,   // показывать виджет
    collapsed: true, // свёрнута ли сетка дней (шапка Yorni видна всегда)
    posX: null,      // сохранённая позиция виджета
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

// Русские названия месяцев (именительный падеж) — для кликабельной адаптации
const MONTHS_RU_NOM = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

// Русские названия викингских месяцев, индекс = номер современного месяца - 1
const MONTHS_NORSE_RU = [
    "Морсугур", "Торри", "Гоа", "Эйнмануд", "Харпа", "Скерпла",
    "Сольмануд", "Хейаннир", "Твимануд", "Хаустмануд", "Гормануд", "Юлир",
];

const WEEKDAYS_SHORT_NORSE = ["Mán", "Týs", "Óðn", "Þór", "Frj", "Lau", "Sun"];
const WEEKDAYS_FULL_RU = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

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
    { norse: "Miðnætti",  ru: "Миднатти", desc: "Полночь",                dir: "С",  dirText: "Солнце строго на Севере",       start: 0,  mid: 1.5 },
    { norse: "Ótta",      ru: "Отта",     desc: "Ночь перед рассветом",   dir: "СВ", dirText: "Солнце на Северо-Востоке",      start: 3,  mid: 4.5 },
    { norse: "Morgun",    ru: "Моргун",   desc: "Утро, подъём",           dir: "В",  dirText: "Солнце строго на Востоке",      start: 6,  mid: 7.5 },
    { norse: "Dagmál",    ru: "Дагмал",   desc: "Дневное время, завтрак", dir: "ЮВ", dirText: "Солнце на Юго-Востоке",         start: 9,  mid: 10.5 },
    { norse: "Hádegi",    ru: "Хадеги",   desc: "Полдень",                dir: "Ю",  dirText: "Солнце строго на Юге",          start: 12, mid: 13.5 },
    { norse: "Undorn",    ru: "Ундорн",   desc: "Полдник",                dir: "ЮЗ", dirText: "Солнце на Юго-Западе",          start: 15, mid: 16.5 },
    { norse: "Miðaftann", ru: "Мидафтан", desc: "Вечер",                  dir: "З",  dirText: "Солнце строго на Западе",       start: 18, mid: 19.5 },
    { norse: "Náttmál",   ru: "Наттмал",  desc: "Ужин, ночь",             dir: "СЗ", dirText: "Солнце на Северо-Западе",       start: 21, mid: 22.5 },
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
      desc: "время зарождения и планов" },
    { norse: "Vaxandi tungl",  en: "Waxing Moon", ru: "Растущая луна",  icon: "🌒", from: 1.8,  to: 13.0,
      desc: "время дел, походов и строительства" },
    { norse: "Fullt tungl",    en: "Full Moon",   ru: "Полнолуние",     icon: "🌕", from: 13.0, to: 16.5,
      desc: "пик силы, время Блотов и Тинга" },
    { norse: "Minnandi tungl", en: "Waning Moon", ru: "Убывающая луна", icon: "🌖", from: 16.5, to: 27.7,
      desc: "время завершать дела и возвращаться домой" },
    { norse: "Nið",            en: "Dark Moon",   ru: "Безлуние",       icon: "🌚", from: 27.7, to: 29.53,
      desc: "ночи волка Хати, время отдыха и осторожности" },
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

/**
 * Ищет дату и время в тексте сообщения.
 * Возвращает {day, month, year, hour, minute} или null.
 */
function parseDateTime(text) {
    // 1. Встроенные форматы даты
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

    // 2. Время: сначала точное ЧЧ:ММ, затем название эйкты
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
    source: "none", // "lore" | "none"
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    lastDateKey: "",
};

let refreshTimer = null;
const hintTimers = {}; // таймеры возврата кликабельных подсказок

function hasDate() {
    return state.day !== null && state.month !== null;
}

/** Ставит элементу текст с адаптацией на 5 секунд, затем возвращает назад. */
function swapHint(id, hintText) {
    const el = $(`#${id}`);
    const original = el.data("base") ?? el.text();
    if (!el.data("base")) el.data("base", original);
    el.text(hintText).addClass("ncw-hint");
    clearTimeout(hintTimers[id]);
    hintTimers[id] = setTimeout(() => {
        el.text(el.data("base")).removeClass("ncw-hint");
    }, 5000);
}

/** Сбрасывает все активные подсказки и обновляет базовые тексты. */
function clearHints() {
    for (const id of Object.keys(hintTimers)) {
        clearTimeout(hintTimers[id]);
        delete hintTimers[id];
    }
    $(".ncw-hint").removeClass("ncw-hint");
}

/** Сетка календаря (дни 1–30), только когда есть дата из чата. */
function buildGrid() {
    const grid = $("#ncw-grid").empty();
    if (!hasDate()) {
        grid.hide();
        return;
    }
    grid.show();
    const { year, month, day } = state;

    // Auknætr: счёт дней месяца отключён — показываем особый статус
    if (isAuk(month)) {
        const total = aukDays(year);
        grid.append($("<div>", { "class": "ncw-auk-title", text: "— Sumarauki · Auknætr —" }));
        for (let d = 1; d <= total; d++) {
            const cls = d === day ? "ncw-cell ncw-day ncw-aukday ncw-today" : "ncw-cell ncw-day ncw-aukday";
            grid.append($("<div>", { "class": cls, text: d }));
        }
        return;
    }

    for (let i = 0; i < WEEKDAYS_SHORT_NORSE.length; i++) {
        const wd = (i + 1) % 7; // порядок с понедельника
        const tip = `${WEEKDAY_DESC_RU[wd]} — ${WEEKDAYS_FULL_RU[wd]}`;
        grid.append($("<div>", { "class": "ncw-cell ncw-wd", text: WEEKDAYS_SHORT_NORSE[i], title: tip }));
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

/** Полный рендер виджета в формате Yorni. */
function renderAll(force = false) {
    if (!extension_settings[extensionName].enabled) return;
    clearHints();

    if (!hasDate()) {
        // Нет инфоблока — весь виджет скрыт
        $("#ncw-body").hide();
        state.lastDateKey = "";
        return;
    }
    $("#ncw-body").show();

    const { year, month, day, hour, minute } = state;
    const dateKey = `${year}|${month}|${day}|${hour}|${minute}`;
    if (!force && dateKey === state.lastDateKey) return;
    state.lastDateKey = dateKey;

    // --- Блок 1: эйкта и положение солнца ---
    const eyktEl = $("#ncw-eykt").removeData("base");
    const sunEl = $("#ncw-sun");
    if (hour !== null) {
        const idx = eyktForHour(hour);
        const e = EYKTIR[idx];
        eyktEl.text(`${e.ru} • ${idx + 1}-я эйкта`).show();
        sunEl.text(e.dirText).show();
    } else {
        eyktEl.hide();
        sunEl.hide();
    }

    // --- Блок 2: сезон + дата, день недели + луна ---
    const season = seasonOf(month);
    const seasonIcon = season.norse === "Sumar" ? "🌿" : "❄️";

    const dateEl = $("#ncw-date").removeData("base");
    if (isAuk(month)) {
        const total = aukDays(year);
        dateEl.text(`${seasonIcon} ${season.norse} • Sumarauki ${day} из ${total}, ${year}`);
    } else {
        dateEl.text(`${seasonIcon} ${season.norse} • ${day} ${MONTHS_NORSE_RU[month - 1]} ${year}`);
    }

    const wdIdx = weekdayOf(year, month, day);
    const { phase } = moonPhase(year, month, day);
    $("#ncw-lore").removeData("base")
        .text(`${WEEKDAY_DESC_RU[wdIdx]} • ${phase.icon} ${phase.norse} ${phase.desc}`);

    // Сетка
    buildGrid();
}

/* ------------------------------------------------------------------ */
/* Обновление состояния из чата                                        */
/* ------------------------------------------------------------------ */

function applyLore(lore) {
    state.source = "lore";
    state.year = lore.year ?? 1;
    state.month = lore.month;
    state.day = lore.day;
    state.hour = lore.hour;
    state.minute = lore.minute;
}

/** Полное обновление: ищем дату в чате и перерисовываем виджет. */
function refresh() {
    const lore = findLoreDateTime();
    if (lore) {
        applyLore(lore);
        renderAll(true);
    } else {
        state.source = "none";
        state.year = null;
        state.month = null;
        state.day = null;
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
            $("<span>", { id: "ncw-collapse", title: "Показать / скрыть сетку дней", text: "+" }),
        ),
        $("<div>", { id: "ncw-body" }).append(
            // Блок 1: время (кликабельно)
            $("<div>", { id: "ncw-eykt", "class": "ncw-clickable" }),
            $("<div>", { id: "ncw-sun" }),
            // Блок 2: дата и лор (кликабельно)
            $("<div>", { id: "ncw-date", "class": "ncw-clickable" }),
            $("<div>", { id: "ncw-lore", "class": "ncw-clickable" }),
            // Разворачиваемая сетка дней
            $("<div>", { id: "ncw-grid" }),
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

    // Разворачивание сетки календаря по кнопке в шапке
    $("#ncw-collapse").on("click", () => {
        const collapsed = !widget.hasClass("ncw-collapsed");
        widget.toggleClass("ncw-collapsed", collapsed);
        $("#ncw-collapse").text(collapsed ? "+" : "–");
        extension_settings[extensionName].collapsed = collapsed;
        saveSettingsDebounced();
    });

    // Кликабельные адаптации формата Yorni (текст на 5 секунд)
    $("#ncw-eykt").on("click", () => {
        if (state.hour === null) return;
        const mm = String(state.minute ?? 0).padStart(2, "0");
        swapHint("ncw-eykt", `${String(state.hour).padStart(2, "0")}:${mm}`);
    });

    $("#ncw-date").on("click", () => {
        if (!hasDate()) return;
        if (isAuk(state.month)) {
            swapHint("ncw-date", "Особые дни в середине лета перед сенокосом (между Сольмануд и Хейаннир)");
        } else {
            swapHint("ncw-date", `${state.day} ${MONTHS_RU_NOM[state.month - 1]} ${state.year}`);
        }
    });

    $("#ncw-lore").on("click", () => {
        if (!hasDate()) return;
        const wdIdx = weekdayOf(state.year, state.month, state.day);
        const { phase } = moonPhase(state.year, state.month, state.day);
        swapHint("ncw-lore", `${WEEKDAYS_FULL_RU[wdIdx]} • ${phase.icon} ${phase.ru} ${phase.desc}`);
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
