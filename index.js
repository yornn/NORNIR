/*
 * Norse Calendar — расширение-инфоблок для SillyTavern.
 *
 * Модель работы: расширение инжектит в промпт инструкцию, модель отвечает
 * служебным блоком <yorni>...</yorni> с метаданными сцены, а виджет YORNIE
 * рендерит из него эйкту, положение солнца, дату, день недели и фазу Луны.
 *
 * Реальное время не используется — только данные из чата.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Constants .......... Имя расширения, настройки, скан-глубина
 * 2. Regex Scripts ...... Скрытие/вырезание блока <yorni> в чате и промпте
 * 3. Prompt ............. Инструкция <yorni> для модели
 * 4. Lore Data .......... Месяцы, дни недели, эйкты, фазы Луны
 * 5. Date Parsing ....... Парсинг даты и времени из блока <yorni>
 * 6. Calendar Math ...... Серийные дни, дни недели, addDays
 * 7. State & Render ..... Состояние виджета и его отрисовка
 * 8. Widget Mounting .... Встраивание в DOM сообщения
 * 9. Widget Building .... Построение DOM-структуры виджета
 * 10. Settings .......... Панель настроек SillyTavern
 * 11. Init .............. Точка входа, подписки на события
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

/* ============================================================
 * 1. CONSTANTS
 * ============================================================ */

const extensionName = "Norse-Calendar";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const defaultSettings = {
    enabled: true,
    inject: true,
    collapsed: true,
    theme: "default",
};

const SCAN_DEPTH = 25;

/* ============================================================
 * 2. REGEX SCRIPTS (SillyTavern)
 *
 * Два скрипта для обработки блока <yorni>:
 *  - display: скрывает блок из отрендеренного текста сообщения
 *  - prompt:  вырезает блок из контекста на глубине >= 1,
 *             оставляя последний (depth 0) как baseline
 * ============================================================ */

const YORNI_TAG_RE = /<yorni>([\s\S]{10,800}?)<\/yorni>/i;

const YORNI_REGEX_SCRIPTS = [
    {
        id: "norse_calendar_yorni_display",
        scriptName: "Norse Calendar — скрыть <yorni> в чате",
        findRegex: "/<yorni>(?:(?!<\\/think(?:ing)?>|<yorni>)[\\s\\S])*?<\\/yorni>/gim",
        replaceString: "",
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    },
    {
        id: "norse_calendar_yorni_prompt",
        scriptName: "Norse Calendar — вырезать <yorni> из контекста",
        findRegex: "/<yorni>(?:(?!<\\/think(?:ing)?>|<yorni>)[\\s\\S])*?<\\/yorni>/gim",
        replaceString: "",
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: true,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: 1,
        maxDepth: null,
    },
];

/** Регистрирует regex-скрипты в настройках ST (без дублей по id). */
function ensureYorniRegexScripts() {
    if (!extension_settings.regex) extension_settings.regex = [];
    for (const script of YORNI_REGEX_SCRIPTS) {
        const idx = extension_settings.regex.findIndex((s) => s.id === script.id);
        if (idx === -1) {
            extension_settings.regex.push({ ...script });
        } else {
            extension_settings.regex[idx] = { ...script };
        }
    }
    saveSettingsDebounced();
}

/* ============================================================
 * 3. PROMPT (инструкция <yorni> для модели)
 * ============================================================ */

const YORNI_PROMPT = [
    "[Norse Calendar — System Metadata Instruction]",
    "At the VERY BEGINNING of every response, before writing any narrative prose, output exactly one metadata block enclosed strictly within <yorni> and </yorni> tags.",
    "",
    "STRICT CONTINUITY & STATE TRACKING (CRITICAL):",
    "- Look at the MOST RECENT <yorni> block in the chat history as your baseline state.",
    "- DO NOT jump backward in time, reset dates, or hallucinate unrelated months. Time moves strictly forward or stays the same.",
    "- If a scene continues seamlessly, keep the same date and advance the eykt/time logically.",
    "- Dynamically update attire, location, weather, and mood based on the CURRENT events in the RP.",
    "",
    "Use the following key-value format inside the tag (write all field values in Russian):",
    "<yorni>",
    "eykt: <Current Eykt>",
    "date: <Day VikingMonth Year>",
    "weather: <Current weather>",
    "location: <Current precise location>",
    "mood: <{{char}}'s current mood(s)>",
    "user_attire: <{{user}}'s current attire>",
    "char_attire: <{{char}}'s current attire>",
    "thought: <{{char}}'s inner thought about {{user}}>",
    "</yorni>",
    "",
    "RULES FOR EYKT (Old Norse 3-hour time divisions):",
    "- миднатти (00:00–03:00 / Midnight)",
    "- отта (03:00–06:00 / Dawn)",
    "- моргун (06:00–09:00 / Morning)",
    "- дагмал (09:00–12:00 / Day-meal)",
    "- хадеги (12:00–15:00 / Noon)",
    "- ундорн (15:00–18:00 / Mid-afternoon)",
    "- мидафтан (18:00–21:00 / Mid-evening)",
    "- наттмал (21:00–24:00 / Night-meal)",
    "",
    "RULES FOR VIKING DATE (30 days per month):",
    "- Winter months (Vetr): 11.гормануд, 12.юлир, 1.морсугур, 2.торри, 3.гоа, 4.эйнмануд",
    "- Summer months (Sumar): 5.харпа, 6.скерпла, 7.сольмануд, 8.хейаннир, 9.твимануд, 10.хаустмануд",
    "",
    "CRITICAL MANDATES:",
    "1. Place the <yorni> block at the VERY TOP of your output before any narrative text.",
    "2. Inherit state strictly from the previous turn — continuous story progression only.",
    "3. Fill all field values in Russian.",
    "4. Never mention or react to the <yorni> tags inside the actual roleplay content.",
    "",
    "EXAMPLE OUTPUT:",
    "<yorni>",
    "eykt: дагмал",
    "date: 4 хаустмануд 1014",
    "weather: Прохладный воздух, сильный северный ветер",
    "location: Деревня, Длинный дом",
    "mood: весёлый, азартный, воодушевлённый",
    "user_attire: Шерстяное платье, меховой плащ",
    "char_attire: Волчьи шкуры, льняная рубаха",
    "thought: Сегодня отличный день для доброй драки!",
    "</yorni>",
].join("\n");

/* ============================================================
 * 4. LORE DATA
 *
 * Месяцы: 12 × 30 дней, индекс = современный месяц - 1
 * Дни недели: индекс 0 = воскресенье (sunnudagr)
 * Эйкты: 8 × 3 часа
 * Луна: цикл 29.53 дня от 2000-01-06
 * ============================================================ */

const MONTHS_RU_NOM = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const MONTHS_NORSE_RU = [
    "Морсугур", "Торри", "Гоа", "Эйнмануд", "Харпа", "Скерпла",
    "Сольмануд", "Хейаннир", "Твимануд", "Хаустмануд", "Гормануд", "Юлир",
];

const WEEKDAYS_SHORT_NORSE = ["Mán", "Týs", "Óðn", "Þór", "Frj", "Lau", "Sun"];
const WEEKDAYS_FULL_RU = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

const WEEKDAY_DESC_RU = [
    "День Солнца", "День Луны", "День Тюра", "День Одина",
    "День Тора", "День Фригг / Фрейи", "«Банный день» — день омовения",
];

const AUK_STEMS = ["sumarauki", "aukn", "auk"];

function seasonOf(month) {
    return isAuk(month) || (month >= 5 && month <= 10)
        ? { norse: "Sumar", ru: "Лето" }
        : { norse: "Vetr", ru: "Зима" };
}

const MONTH_STEMS = [
    ["jan", "янв", "mörs", "mors", "морс"],
    ["feb", "фев", "þor", "thor", "торр"],
    ["mar", "мар", "góa", "goa", "гоа"],
    ["apr", "апр", "einm", "эйн"],
    ["may", "мая", "май", "harp", "харп"],
    ["jun", "июн", "skerp", "скерп"],
    ["jul", "июл", "sólm", "solm", "сольм"],
    ["aug", "авг", "heyan", "хейан"],
    ["sep", "сен", "tvím", "tvim", "твим"],
    ["oct", "окт", "haust", "хауст"],
    ["nov", "ноя", "ной", "gorm", "горм"],
    ["dec", "дек", "ýl", "ylir", "юлир"],
];

/** Номер месяца (1–12) по названию или числу. */
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

const EYKT_ALIASES = [
    ["miðn", "midn", "мидн", "полноч", "midnight"],
    ["ótta", "otta", "отта", "предрассвет", "рассвет"],
    ["morgun", "моргун", "rismál", "rismal", "утро", "morning"],
    ["dagmál", "dagmal", "дагмал"],
    ["hádegi", "hadegi", "хадеги", "полдень", "полдня", "midday", "noon"],
    ["undorn", "ундорн", "полдник", "afternoon"],
    ["miðaftan", "midaftan", "мидафтан", "вечер", "evening"],
    ["náttmál", "nattmal", "наттмал", "ужин", "ночь", "night"],
];

/** Индекс эйкты по часу (0–24). */
function eyktForHour(hour) {
    return Math.floor((hour % 24) / 3) % 8;
}

/** Ищет название эйкты в тексте. Возвращает индекс или null. */
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

const MOON_CYCLE = 29.53;

const MOON_PHASES = [
    { norse: "Ný",             ru: "Новолуние",      icon: "🌑", from: 0,    to: 1.8,
      desc: "время зарождения и планов" },
    { norse: "Vaxandi",        ru: "Растущая луна",  icon: "🌒", from: 1.8,  to: 13.0,
      desc: "время дел, походов и строительства" },
    { norse: "Fullt tungl",    ru: "Полнолуние",     icon: "🌕", from: 13.0, to: 16.5,
      desc: "пик силы, время Блотов и Тинга" },
    { norse: "Minnandi",       ru: "Убывающая луна", icon: "🌖", from: 16.5, to: 27.7,
      desc: "время завершать дела и возвращаться домой" },
    { norse: "Nið",            ru: "Безлуние",       icon: "🌚", from: 27.7, to: 29.53,
      desc: "ночи волка Хати, время отдыха и осторожности" },
];

/** Возраст Луны и её фаза для заданной даты. */
function moonPhase(year, month, day) {
    const anchor = serialOf(2000, 1, 6);
    const age = (((serialOf(year, month, day) - anchor) % MOON_CYCLE) + MOON_CYCLE) % MOON_CYCLE;
    const phase = MOON_PHASES.find((p) => age >= p.from && age < p.to) ?? MOON_PHASES[0];
    return { age, phase };
}

/* ============================================================
 * 5. DATE PARSING (из блока <yorni>)
 * ============================================================ */

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;
const MWORD = "A-Za-zÀ-ÿÞðþÁ-ž\\u0400-\\u04FF";

const DATE_PATTERNS = [
    {
        re: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?([${MWORD}]{2,})\\s*,?\\s*(\\d{3,4})?`, "giu"),
        map: (m) => ({ day: +m[1], month: monthFromName(m[2]), year: m[3] ? +m[3] : null, monthWord: true }),
    },
    {
        re: new RegExp(`([${MWORD}]{2,})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{3,4})?`, "giu"),
        map: (m) => ({ day: +m[2], month: monthFromName(m[1]), year: m[3] ? +m[3] : null, monthWord: true }),
    },
    {
        re: /(\d{3,4})-(\d{1,2})-(\d{1,2})/g,
        map: (m) => ({ year: +m[1], month: +m[2], day: +m[3], monthWord: false }),
    },
    {
        re: /(\d{1,2})[./](\d{1,2})[./](\d{3,4})/g,
        map: (m) => ({ day: +m[1], month: +m[2], year: +m[3], monthWord: false }),
    },
];

/** Точность даты: 2 = полная с годом, 1 = месяц словом без года, 0 = мусор. */
function dateScore(d) {
    if (typeof d.month === "string") return d.year !== null ? 2 : 1;
    if (d.year !== null) return 2;
    if (d.monthWord) return 1;
    return 0;
}

function isValidDate(d) {
    if (!d) return false;
    if (d.month === "AUK") {
        if (!d.day || d.day < 1 || d.day > 5) return false;
    } else {
        if (!d.month || d.month < 1 || d.month > 12) return false;
        if (!d.day || d.day < 1 || d.day > 31) return false;
    }
    if (d.year !== null && (isNaN(d.year) || d.year < 1 || d.year > 9999)) return false;
    return true;
}

/** Приводит дату к лорному календарю (в месяце ровно 30 дней). */
function finalizeDate(d) {
    if (d.month !== "AUK" && d.day > 30) d.day = 30;
    return d;
}

/** Ищет лучшую дату в тексте. */
function findDateIn(text) {
    let best = null;
    let bestScore = -1;
    for (const { re, map } of DATE_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const c = map(m);
            if (!isValidDate(c)) continue;
            const s = dateScore(c);
            if (s === 0) continue;
            if (s > bestScore) {
                best = c;
                bestScore = s;
            }
        }
    }
    return best ? finalizeDate(best) : null;
}

/** Расплывчатый поиск месяца в тексте (для составных форматов). */
function monthFromTextLoose(text) {
    const t = text.toLowerCase();
    let best = null;
    let bestPos = Infinity;
    for (const s of AUK_STEMS) {
        const p = t.indexOf(s);
        if (p !== -1 && p < bestPos) { bestPos = p; best = "AUK"; }
    }
    for (let i = 0; i < MONTH_STEMS.length; i++) {
        for (const s of MONTH_STEMS[i]) {
            const p = t.indexOf(s);
            if (p !== -1 && p < bestPos) { bestPos = p; best = i + 1; }
        }
    }
    return best;
}

/** Ищет дату внутри поля date блока <yorni>. */
function findDateInYorni(text) {
    let d = findDateIn(text);

    if (!d) {
        const m = text.match(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{2})(?!\d)/);
        if (m) {
            const c = finalizeDate({ day: +m[1], month: +m[2], year: 2000 + +m[3] });
            if (isValidDate(c)) d = c;
        }
    }

    if (!d) {
        const month = monthFromTextLoose(text);
        if (month !== null) {
            const dayM = text.match(/(?<!\d)(\d{1,2})(?!\d)/);
            const yearM = text.match(/(?<!\d)(\d{3,4})(?!\d)/);
            const c = finalizeDate({
                day: dayM ? +dayM[1] : null,
                month,
                year: yearM ? +yearM[1] : null,
            });
            if (isValidDate(c)) d = c;
        }
    }

    if (d && d.year === null) {
        const yearM = text.match(/(?<!\d)(\d{3,4})(?!\d)/);
        if (yearM) d.year = +yearM[1];
    }

    return d;
}

/** Парсит блок <yorni>...</yorni> — единственный источник метаданных. */
function parseYorniTag(rawText) {
    const m = rawText.match(YORNI_TAG_RE);
    if (!m) return null;
    const inner = m[1];

    const fields = {};
    for (const line of inner.split(/\r?\n/)) {
        const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
        if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
    }

    const candidates = [];
    if (fields.date) candidates.push(fields.date);
    candidates.push(inner);

    let d = null;
    let dateZone = "";
    for (let cand of candidates) {
        const jm = cand.match(/"output"\s*:\s*"([^"]+)"/i);
        if (jm) cand = jm[1].trim();
        if (/[<>{}]/.test(cand)) continue;
        const found = findDateInYorni(cand);
        if (found) { d = found; dateZone = cand; break; }
    }
    if (!d) return null;

    d.hour = null;
    d.minute = null;
    const eyktVal = fields.eykt && !/[<>{}]/.test(fields.eykt) ? fields.eykt : null;
    if (eyktVal) {
        const tm = eyktVal.match(TIME_PATTERN);
        if (tm && +tm[1] <= 24 && +tm[2] <= 59) {
            d.hour = +tm[1];
            d.minute = +tm[2];
        } else {
            const idx = eyktFromText(eyktVal);
            if (idx !== null) {
                const mid = EYKTIR[idx].mid;
                d.hour = Math.floor(mid);
                d.minute = Math.round((mid % 1) * 60);
            }
        }
    }
    if (d.hour === null) {
        const tm = dateZone.match(TIME_PATTERN);
        if (tm && +tm[1] <= 24 && +tm[2] <= 59) {
            d.hour = +tm[1];
            d.minute = +tm[2];
        }
    }

    const clean = (v) => (v && !/[<>{}]/.test(v) ? v : null);
    return {
        ...d,
        weather: clean(fields.weather),
        location: clean(fields.location),
        userAttire: clean(fields.user_attire),
        charMood: clean(fields.mood),
        charAttire: clean(fields.char_attire),
        thought: clean(fields.thought),
    };
}

/** Скан сообщений персонажа с конца в поисках блока <yorni>. */
function findLoreDateTime() {
    const context = getContext();
    const chat = context?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== "string") continue;
        if (msg.is_user) continue;
        const fromTag = parseYorniTag(msg.mes);
        if (fromTag) return fromTag;
        if (chat.length - 1 - i >= SCAN_DEPTH) break;
    }
    return null;
}

/** Инжектит инструкцию в промпт перед генерацией. */
function injectNorsePrompt() {
    if (!extension_settings[extensionName]?.inject) return;
    const context = getContext();
    if (!context || typeof context.setExtensionPrompt !== "function") return;
    context.setExtensionPrompt(extensionName, YORNI_PROMPT, 1, 0);
}

/* ============================================================
 * 6. CALENDAR MATH
 * ============================================================ */

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

function leapsBefore(year) {
    const y = year - 1;
    return Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

/** Серийный номер дня в лорном календаре. */
function serialOf(year, month, day) {
    let doy;
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
    const rem = serial - serialOf(y, 1, 1);
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

/** День недели (0 = воскресенье). 1 Mörsugur года 1 — понедельник. */
function weekdayOf(year, month, day) {
    return (serialOf(year, month, day) + 1) % 7;
}

/** Прибавляет n дней к дате. */
function addDays(year, month, day, n) {
    return serialToDate(serialOf(year, month, day) + n);
}

/* ============================================================
 * 7. STATE & RENDER
 * ============================================================ */

const state = {
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    lastDateKey: "",
    weather: null,
    location: null,
    userAttire: null,
    charMood: null,
    charAttire: null,
    thought: null,
};

let refreshTimer = null;
const hintTimers = {};

function hasDate() {
    return state.day !== null && state.month !== null;
}

/** Меняет текст слова на адаптацию на 5 секунд, затем возвращает. */
function swapHint($el) {
    $el.text($el.data("alt")).addClass("ncw-hint");
    const key = $el.data("key");
    clearTimeout(hintTimers[key]);
    hintTimers[key] = setTimeout(() => {
        $el.text($el.data("base")).removeClass("ncw-hint");
    }, 5000);
}

function clearHints() {
    for (const key of Object.keys(hintTimers)) {
        clearTimeout(hintTimers[key]);
        delete hintTimers[key];
    }
    $(".ncw-hint").removeClass("ncw-hint");
}

function hintSpan(key, base, alt) {
    return $("<span>", {
        "class": "ncw-hintable",
        "data-key": key,
        "data-base": base,
        "data-alt": alt,
        text: base,
    });
}

function plainSpan(text) {
    return $("<span>", { text: text });
}

/** Сетка календаря (дни 1–30), только когда есть дата из чата. */
function buildGrid(grid) {
    grid = grid || $("#ncw-grid");
    grid.empty();
    grid.toggleClass("ncw-hidden", !hasDate());
    if (!hasDate()) {
        return;
    }
    const { year, month, day } = state;

    if (isAuk(month)) {
        const total = aukDays(year);
        grid.append($("<div>", { "class": "ncw-auk-title", text: "— Sumarauki · Auknætr —" }));
        const row = $("<div>", { "class": "ncw-row" });
        for (let d = 1; d <= total; d++) {
            const cls = d === day ? "ncw-cell ncw-day ncw-aukday ncw-today" : "ncw-cell ncw-day ncw-aukday";
            row.append($("<div>", { "class": cls, text: d }));
        }
        grid.append(row);
        return;
    }

    const headRow = $("<div>", { "class": "ncw-row" });
    for (let i = 0; i < WEEKDAYS_SHORT_NORSE.length; i++) {
        const wd = (i + 1) % 7;
        const tip = `${WEEKDAY_DESC_RU[wd]} — ${WEEKDAYS_FULL_RU[wd]}`;
        headRow.append($("<div>", { "class": "ncw-cell ncw-wd", text: WEEKDAYS_SHORT_NORSE[i], title: tip }));
    }
    grid.append(headRow);

    const offsetToday = (weekdayOf(year, month, day) + 6) % 7;
    const weekRow = $("<div>", { "class": "ncw-row" });
    for (let i = 0; i < 7; i++) {
        const d = addDays(year, month, day, i - offsetToday);
        const isToday = i === offsetToday;
        const outOfMonth = d.month !== month;
        let cls = "ncw-cell ncw-day";
        if (outOfMonth) cls += " ncw-dim";
        if (isToday) cls += " ncw-today";
        weekRow.append($("<div>", { "class": cls, text: d.day }));
    }
    grid.append(weekRow);
}

/** Полный рендер виджета. */
function renderAll(force = false) {
    if (!extension_settings[extensionName].enabled) return;
    clearHints();

    if (!hasDate()) {
        state.lastDateKey = "";
        $("#ncw-eykt, #ncw-sun, #ncw-date, #ncw-lore").hide();
        $("#ncw-grid").addClass("ncw-hidden");
        $("#ncw-weather, #ncw-location, #ncw-user-details, #ncw-char-details, #ncw-thought").hide();
        let stub = $("#ncw-stub");
        if (!stub.length) {
            stub = $("<div>", { id: "ncw-stub", text: "ᚱ Ожидание инфоблока…" });
            $("#ncw-body").append(stub);
        }
        stub.show();
        return;
    }
    $("#ncw-stub").hide();

    const { year, month, day, hour, minute } = state;
    const dateKey = [year, month, day, hour, minute,
        state.weather, state.location, state.userAttire, state.charMood, state.charAttire, state.thought].join("|");
    if (!force && dateKey === state.lastDateKey) return;
    state.lastDateKey = dateKey;

    const eyktEl = $("#ncw-eykt").empty();
    const sunEl = $("#ncw-sun");
    if (hour !== null) {
        const idx = eyktForHour(hour);
        const e = EYKTIR[idx];
        const mm = String(minute ?? 0).padStart(2, "0");
        eyktEl.append(
            hintSpan("eykt", e.ru, `${String(hour).padStart(2, "0")}:${mm}`),
            plainSpan(` • ${idx + 1}-я эйкта`),
        ).show();
        sunEl.text(e.dirText).show();
    } else {
        eyktEl.hide();
        sunEl.hide();
    }

    const season = seasonOf(month);
    const seasonIcon = season.norse === "Sumar" ? "🌿" : "❄️";

    const dateEl = $("#ncw-date").empty();
    if (isAuk(month)) {
        const total = aukDays(year);
        dateEl.append(
            plainSpan(`${seasonIcon} ${season.norse} • `),
            hintSpan("date", `Sumarauki ${day} из ${total}, ${year}`,
                "Особые дни в середине лета перед сенокосом"),
        );
    } else {
        dateEl.append(
            plainSpan(`${seasonIcon} `),
            hintSpan("season", season.norse, season.ru),
            plainSpan(` • ${day} `),
            hintSpan("date", MONTHS_NORSE_RU[month - 1], MONTHS_RU_NOM[month - 1]),
            plainSpan(` ${year}`),
        );
    }
    dateEl.show();

    const wdIdx = weekdayOf(year, month, day);
    const { phase } = moonPhase(year, month, day);
    $("#ncw-lore").empty().show().append(
        hintSpan("wd", WEEKDAY_DESC_RU[wdIdx], WEEKDAYS_FULL_RU[wdIdx]),
        plainSpan(` • ${phase.icon} `),
        hintSpan("moon", phase.norse, phase.ru),
        plainSpan(` ${phase.desc}`),
    );

    const weatherEl = $("#ncw-weather");
    if (state.weather) {
        $("#ncw-weather-text").text(state.weather);
        weatherEl.show();
    } else {
        weatherEl.hide();
    }

    renderExtraFields();
    buildGrid($("#ncw-grid"));
}

/** Рендерит правую колонку: локация, {{user}}, {{char}}, мысль. */
function renderExtraFields() {
    const context = getContext();
    const userName = context?.name1 || "{{user}}";
    const charName = context?.name2 || "{{char}}";

    const locEl = $("#ncw-location");
    if (state.location) {
        $("#ncw-location-text").text(state.location);
        locEl.show();
    } else {
        locEl.hide();
    }

    const userDetails = $("#ncw-user-details");
    $("#ncw-user-name").text(userName);
    if (state.userAttire) {
        $("#ncw-attire-user-text").text(state.userAttire);
        userDetails.show();
    } else {
        userDetails.hide();
    }

    const charDetails = $("#ncw-char-details");
    $("#ncw-char-name").text(charName);
    const moods = state.charMood
        ? state.charMood.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const moodEl = $("#ncw-mood-chips").empty();
    for (const m of moods) {
        moodEl.append($("<span>", { "class": "ncw-chip", text: m }));
    }
    moodEl.toggle(moods.length > 0);
    const charAttireRow = $("#ncw-attire-char");
    if (state.charAttire) {
        $("#ncw-attire-char-text").text(state.charAttire);
        charAttireRow.show();
    } else {
        charAttireRow.hide();
    }
    charDetails.toggle(moods.length > 0 || !!state.charAttire);

    const thoughtEl = $("#ncw-thought");
    if (state.thought) {
        $("#ncw-thought-text").text(state.thought);
        thoughtEl.show();
    } else {
        thoughtEl.hide();
    }
}

/* ============================================================
 * 8. WIDGET MOUNTING
 *
 * Обновление состояния из чата и встраивание виджета
 * в начало последнего сообщения персонажа.
 * ============================================================ */

function applyLore(lore) {
    state.year = lore.year ?? 1;
    state.month = lore.month;
    state.day = lore.day;
    state.hour = lore.hour;
    state.minute = lore.minute;
    state.weather = lore.weather ?? null;
    state.location = lore.location ?? null;
    state.userAttire = lore.userAttire ?? null;
    state.charMood = lore.charMood ?? null;
    state.charAttire = lore.charAttire ?? null;
    state.thought = lore.thought ?? null;
}

function resetState() {
    state.year = null;
    state.month = null;
    state.day = null;
    state.hour = null;
    state.minute = null;
    state.weather = null;
    state.location = null;
    state.userAttire = null;
    state.charMood = null;
    state.charAttire = null;
    state.thought = null;
}

function refresh() {
    const lore = findLoreDateTime();
    if (lore) {
        applyLore(lore);
    } else {
        resetState();
    }
    mountWidget();
    renderAll(true);
}

/** Встраивает виджет в начало последнего сообщения от {{char}}. */
function mountWidget() {
    let widget = document.getElementById("norse-calendar-widget");

    if (!widget) {
        widget = buildWidget();
    }
    if (!widget) return;

    if (!extension_settings[extensionName].enabled) {
        widget.style.display = "none";
        return;
    }

    const context = getContext();
    const chat = context?.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        widget.style.display = "none";
        return;
    }

    let msgEl = null;
    const all = document.querySelectorAll("#chat .mes");
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].getAttribute("is_user") === "false") {
            msgEl = all[i];
            break;
        }
    }
    if (!msgEl) {
        widget.style.display = "none";
        return;
    }

    const textEl = msgEl.querySelector(".mes_text");
    if (!textEl) return;

    if (widget.parentElement === textEl && widget === textEl.firstElementChild) {
        widget.style.display = "";
        return;
    }

    widget.style.position = "relative";
    widget.style.right = "auto";
    widget.style.bottom = "auto";
    widget.style.left = "auto";
    widget.style.top = "auto";
    widget.style.width = "100%";
    widget.style.minWidth = "0";
    widget.style.margin = "0 0 10px 0";

    textEl.prepend(widget);
    widget.style.display = "";
}

function refreshDebounced() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 200);
}

/* ============================================================
 * 9. WIDGET BUILDING
 * ============================================================ */

/** Создаёт DOM-структуру виджета. */
function buildWidget() {
    const existing = document.getElementById("norse-calendar-widget");
    if (existing) return existing;

    const s = extension_settings[extensionName];

    const widget = $("<div>", { id: "norse-calendar-widget" }).append(
        $("<div>", { id: "ncw-header" }).append(
            $("<span>", { "class": "ncw-runes", text: "ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ" }),
            $("<span>", { id: "ncw-collapse", title: "Показать / скрыть сетку дней", text: "+" }),
        ),
        $("<div>", { id: "ncw-body" }).append(
            $("<div>", { id: "ncw-columns" }).append(
                $("<div>", { id: "ncw-left" }).append(
                    $("<div>", { id: "ncw-eykt" }),
                    $("<div>", { id: "ncw-sun" }),
                    $("<div>", { id: "ncw-date" }),
                    $("<div>", { id: "ncw-lore" }),
                    $("<div>", { id: "ncw-grid" }),
                ),
                $("<div>", { id: "ncw-right" }).append(
                    $("<div>", { id: "ncw-weather", "class": "ncw-weather" }).append(
                        $("<span>", { "class": "ncw-weather-icon", text: "🌦️" }),
                        $("<span>", { id: "ncw-weather-text" }),
                    ),
                    $("<div>", { id: "ncw-location", "class": "ncw-loc" }).append(
                        $("<span>", { "class": "ncw-loc-icon", text: "📍" }),
                        $("<span>", { id: "ncw-location-text" }),
                    ),
                ),
                $("<div>", { id: "ncw-char-col", "class": "ncw-col" }).append(
                    $("<details>", { id: "ncw-char-details", "class": "ncw-details" }).append(
                        $("<summary>", { "class": "ncw-summary" }).append(
                            $("<span>", { "class": "ncw-dot" }),
                            $("<span>", { id: "ncw-char-name", "class": "ncw-name", text: "{{char}}" }),
                        ),
                        $("<div>", { "class": "ncw-details-body" }).append(
                            $("<div>", { id: "ncw-mood-chips", "class": "ncw-chips" }),
                            $("<div>", { id: "ncw-attire-char", "class": "ncw-attire" }).append(
                                $("<span>", { "class": "ncw-attire-icon", text: "👕" }),
                                $("<span>", { id: "ncw-attire-char-text" }),
                            ),
                            $("<div>", { id: "ncw-thought", "class": "ncw-thought" }).append(
                                $("<span>", { "class": "ncw-thought-icon", text: "💭" }),
                                $("<span>", { id: "ncw-thought-text" }),
                            ),
                        ),
                    ),
                ),
                $("<div>", { id: "ncw-user-col", "class": "ncw-col" }).append(
                    $("<details>", { id: "ncw-user-details", "class": "ncw-details" }).append(
                        $("<summary>", { "class": "ncw-summary" }).append(
                            $("<span>", { "class": "ncw-dot" }),
                            $("<span>", { id: "ncw-user-name", "class": "ncw-name", text: "{{user}}" }),
                        ),
                        $("<div>", { "class": "ncw-details-body" }).append(
                            $("<div>", { id: "ncw-attire-user", "class": "ncw-attire" }).append(
                                $("<span>", { "class": "ncw-attire-icon", text: "👕" }),
                                $("<span>", { id: "ncw-attire-user-text" }),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    );

    $("body").append(widget);
    widget.hide();
    widget.attr("data-theme", extension_settings[extensionName].theme || "default");
    widget.toggleClass("ncw-collapsed", s.collapsed);
    $("#ncw-collapse").text(s.collapsed ? "+" : "–");

    $("#ncw-collapse").on("click", () => {
        const collapsed = !widget.hasClass("ncw-collapsed");
        widget.toggleClass("ncw-collapsed", collapsed);
        $("#ncw-collapse").text(collapsed ? "+" : "–");
        extension_settings[extensionName].collapsed = collapsed;
        saveSettingsDebounced();
    });

    widget.on("click", ".ncw-hintable", function () {
        swapHint($(this));
    });

    return widget[0];
}

/* ============================================================
 * 10. SETTINGS
 * ============================================================ */

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

/** Применяет тему оформления к виджету (атрибут data-theme). */
function applyTheme(theme) {
    const widget = document.getElementById("norse-calendar-widget");
    if (widget) widget.setAttribute("data-theme", theme || "default");
}

function bindSettings() {
    bindCheckbox("#nc_enabled", "enabled", (v) => {
        $("#norse-calendar-widget").toggle(v);
        if (v) refresh();
    });

    const themeSel = $("#nc_theme");
    themeSel.val(extension_settings[extensionName].theme || "default");
    themeSel.on("input", function () {
        extension_settings[extensionName].theme = String($(this).val());
        saveSettingsDebounced();
        applyTheme(extension_settings[extensionName].theme);
    });

    bindCheckbox("#nc_inject", "inject", (v) => {
        const context = getContext();
        if (v) {
            injectNorsePrompt();
        } else if (context && typeof context.setExtensionPrompt === "function") {
            context.setExtensionPrompt(extensionName, "", 1, 0);
        }
    });
}

/* ============================================================
 * 11. INIT
 * ============================================================ */

jQuery(async () => {
    loadSettings();

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        const target = $("#extensions_settings2").length ? "#extensions_settings2" : "#extensions_settings";
        $(target).append(settingsHtml);
        bindSettings();
    } catch (e) {
        console.error(`[${extensionName}] Не удалось загрузить settings.html:`, e);
    }

    buildWidget();
    applyTheme(extension_settings[extensionName].theme);
    refresh();

    ensureYorniRegexScripts();

    if (event_types.GENERATE_AFTER_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, injectNorsePrompt);
    }
    injectNorsePrompt();

    const events = [
        event_types.CHAT_CHANGED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
        event_types.GENERATION_ENDED,
        event_types.CHARACTER_MESSAGE_RENDERED,
    ].filter(Boolean);
    for (const ev of events) {
        eventSource.on(ev, refreshDebounced);
    }

    // MutationObserver: перемонтирует виджет при rebuild .mes_text
    try {
        const chatEl = document.getElementById("chat");
        if (chatEl) {
            let pending = false;
            const reinsert = () => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    try {
                        const all = document.querySelectorAll("#chat .mes");
                        let lastBot = null;
                        for (let i = all.length - 1; i >= 0; i--) {
                            if (all[i].getAttribute("is_user") === "false") {
                                lastBot = all[i];
                                break;
                            }
                        }
                        if (!lastBot) return;
                        if (!lastBot.querySelector("#norse-calendar-widget")) {
                            mountWidget();
                            renderAll(true);
                        }
                    } catch (e) { /* ignore */ }
                });
            };
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.target && (m.target.classList?.contains("mes_text") || m.target.classList?.contains("mes"))) {
                        reinsert();
                        return;
                    }
                    for (const n of m.removedNodes || []) {
                        if (n.id === "norse-calendar-widget" || n.querySelector?.("#norse-calendar-widget")) {
                            reinsert();
                            return;
                        }
                    }
                }
            });
            observer.observe(chatEl, { childList: true, subtree: true });
        }
    } catch (e) { /* ignore */ }

    console.log(`[${extensionName}] loaded`);
});
