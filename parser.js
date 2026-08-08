/*
 * Norse Calendar — лор и парсер блока <yorni>.
 *
 * Чистый ES-модуль без зависимостей от SillyTavern: его импортирует и
 * расширение (index.js), и автономный тест (test-parse.mjs). Единственный
 * источник правды для лорных данных и разбора инфоблока.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Lore Data .......... Месяцы, дни недели, эйкты, фазы Луны
 * 2. Calendar Math ...... Серийные дни, дни недели, addDays, фаза Луны
 * 3. Placeholders ....... Отбраковка литеральных плейсхолдеров из шаблона
 * 4. Date Parsing ....... Распознавание даты и времени
 * 5. Yorni Parser ....... Разбор блока <yorni>...</yorni>
 */

/* ============================================================
 * 1. LORE DATA
 *
 * Месяцы: 12 × 30 дней, индекс = современный месяц - 1
 * Дни недели: индекс 0 = воскресенье (sunnudagr)
 * Эйкты: 8 × 3 часа
 * Луна: цикл 29.53 дня от 2000-01-06
 * ============================================================ */

/**
 * Месяцы лорного календаря. Индекс = номер месяца − 1.
 * Зима (Vetr): 11, 12, 1–4. Лето (Sumar): 5–10.
 * `gloss` — перевод самого названия, для справочника Tímatal.
 */
export const MONTHS_LORE = [
    { norse: "Mörsugur",     translit: "Morsugur",   ru: "Морсугур",   modern: "Январь",    gloss: "«сосущий жир» — время жить запасами" },
    { norse: "Þorri",        translit: "Thorri",     ru: "Торри",      modern: "Февраль",   gloss: "по имени зимнего духа Торри; месяц самых злых холодов" },
    { norse: "Góa",          translit: "Goa",        ru: "Гоа",        modern: "Март",      gloss: "по имени Гои, дочери Торри" },
    { norse: "Einmánuður",   translit: "Einmanud",   ru: "Эйнмануд",   modern: "Апрель",    gloss: "«одинокий месяц» — последний месяц зимы" },
    { norse: "Harpa",        translit: "Harpa",      ru: "Харпа",      modern: "Май",       gloss: "по имени Харпы; первый день — начало лета" },
    { norse: "Skerpla",      translit: "Skerpla",    ru: "Скерпла",    modern: "Июнь",      gloss: "происхождение названия неясно" },
    { norse: "Sólmánuður",   translit: "Solmanud",   ru: "Сольмануд",  modern: "Июль",      gloss: "«солнечный месяц» — самые длинные дни" },
    { norse: "Heyannir",     translit: "Heyannir",   ru: "Хейаннир",   modern: "Август",    gloss: "«сенокосные хлопоты» — время косить и сушить сено" },
    { norse: "Tvímánuður",   translit: "Tvimanud",   ru: "Твимануд",   modern: "Сентябрь",  gloss: "«второй месяц» — второй месяц жатвы" },
    { norse: "Haustmánuður", translit: "Haustmanud", ru: "Хаустмануд", modern: "Октябрь",   gloss: "«осенний месяц» — последний месяц лета" },
    { norse: "Gormánaður",   translit: "Gormanud",   ru: "Гормануд",   modern: "Ноябрь",    gloss: "«месяц забоя» — время резать скот на зиму" },
    { norse: "Ýlir",         translit: "Ylir",       ru: "Юлир",       modern: "Декабрь",   gloss: "«месяц Юля» — время середины зимы" },
];

export const MONTHS_NORSE_RU = MONTHS_LORE.map((m) => m.ru);
export const MONTHS_RU_NOM = MONTHS_LORE.map((m) => m.modern);

/** Дни недели. Индекс 0 = воскресенье, как у weekdayOf(). */
export const WEEKDAYS_LORE = [
    { norse: "Sunnudagr",  en: "Sunday",    ru: "Воскресенье",  short: "Sun", desc: "День Солнца" },
    { norse: "Mánadagr",   en: "Monday",    ru: "Понедельник",  short: "Mán", desc: "День Луны" },
    { norse: "Týsdagr",    en: "Tuesday",   ru: "Вторник",      short: "Týs", desc: "День Тюра" },
    { norse: "Óðinsdagr",  en: "Wednesday", ru: "Среда",        short: "Óðn", desc: "День Одина" },
    { norse: "Þórsdagr",   en: "Thursday",  ru: "Четверг",      short: "Þór", desc: "День Тора" },
    { norse: "Frjádagr",   en: "Friday",    ru: "Пятница",      short: "Frj", desc: "День Фригг / Фрейи" },
    { norse: "Laugardagr", en: "Saturday",  ru: "Суббота",      short: "Lau", desc: "«Банный день» — день омовения" },
];

export const WEEKDAYS_FULL_RU = WEEKDAYS_LORE.map((w) => w.ru);
export const WEEKDAY_DESC_RU = WEEKDAYS_LORE.map((w) => w.desc);

/** Шапка сетки недели — порядок с понедельника, а не с воскресенья. */
export const WEEKDAYS_SHORT_NORSE = [1, 2, 3, 4, 5, 6, 0].map((i) => WEEKDAYS_LORE[i].short);

export const AUK_STEMS = ["sumarauki", "aukn", "auk"];

export const MONTH_STEMS = [
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

export const EYKTIR = [
    { norse: "Miðnætti",  translit: "Midnatti", alt: null,       ru: "Миднатти", desc: "Полночь",                dir: "С",  dirText: "Солнце строго на Севере",  start: 0,  mid: 1.5 },
    { norse: "Ótta",      translit: "Otta",     alt: null,       ru: "Отта",     desc: "Ночь перед рассветом",   dir: "СВ", dirText: "Солнце на Северо-Востоке", start: 3,  mid: 4.5 },
    { norse: "Morgun",    translit: "Morgun",   alt: "Rismál",   ru: "Моргун",   desc: "Утро, подъём",           dir: "В",  dirText: "Солнце строго на Востоке", start: 6,  mid: 7.5 },
    { norse: "Dagmál",    translit: "Dagmal",   alt: null,       ru: "Дагмал",   desc: "Дневное время, завтрак", dir: "ЮВ", dirText: "Солнце на Юго-Востоке",    start: 9,  mid: 10.5 },
    { norse: "Hádegi",    translit: "Hadegi",   alt: null,       ru: "Хадеги",   desc: "Полдень",                dir: "Ю",  dirText: "Солнце строго на Юге",     start: 12, mid: 13.5 },
    { norse: "Undorn",    translit: "Undorn",   alt: "Nón",      ru: "Ундорн",   desc: "Полдник",                dir: "ЮЗ", dirText: "Солнце на Юго-Западе",     start: 15, mid: 16.5 },
    { norse: "Miðaftann", translit: "Midaftan", alt: null,       ru: "Мидафтан", desc: "Вечер",                  dir: "З",  dirText: "Солнце строго на Западе",  start: 18, mid: 19.5 },
    { norse: "Náttmál",   translit: "Nattmal",  alt: null,       ru: "Наттмал",  desc: "Ужин, ночь",             dir: "СЗ", dirText: "Солнце на Северо-Западе",  start: 21, mid: 22.5 },
];

export const EYKT_ALIASES = [
    ["miðn", "midn", "мидн", "полноч", "midnight"],
    ["ótta", "otta", "отта", "предрассвет", "рассвет"],
    ["morgun", "моргун", "rismál", "rismal", "утро", "morning"],
    ["dagmál", "dagmal", "дагмал"],
    ["hádegi", "hadegi", "хадеги", "полдень", "полдня", "midday", "noon"],
    ["undorn", "ундорн", "полдник", "afternoon"],
    ["miðaftan", "midaftan", "мидафтан", "вечер", "evening"],
    ["náttmál", "nattmal", "наттмал", "ужин", "ночь", "night"],
];

export const MOON_CYCLE = 29.53;

export const MOON_PHASES = [
    { norse: "Ný",          en: "New Moon",    ru: "Новолуние",      icon: "🌑", from: 0,    to: 1.8,
      desc: "время зарождения и планов" },
    { norse: "Vaxandi",     en: "Waxing Moon", ru: "Растущая луна",  icon: "🌒", from: 1.8,  to: 13.0,
      desc: "время дел, походов и строительства" },
    { norse: "Fullt tungl", en: "Full Moon",   ru: "Полнолуние",     icon: "🌕", from: 13.0, to: 16.5,
      desc: "пик силы, время Блотов и Тинга" },
    { norse: "Minnandi",    en: "Waning Moon", ru: "Убывающая луна", icon: "🌖", from: 16.5, to: 27.7,
      desc: "время завершать дела и возвращаться домой" },
    { norse: "Nið",         en: "Dark Moon",   ru: "Безлуние",       icon: "🌚", from: 27.7, to: 29.53,
      desc: "ночи волка Хати, время отдыха и осторожности" },
];

/** Номер месяца (1–12), "AUK" для Sumarauki, или null. */
export function monthFromName(name) {
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

export function isAuk(month) {
    return month === "AUK";
}

export function seasonOf(month) {
    return isAuk(month) || (month >= 5 && month <= 10)
        ? { norse: "Sumar", ru: "Лето" }
        : { norse: "Vetr", ru: "Зима" };
}

/** Индекс эйкты по часу (0–24). */
export function eyktForHour(hour) {
    return Math.floor((hour % 24) / 3) % 8;
}

/** Ищет название эйкты в тексте. Возвращает индекс или null. */
export function eyktFromText(text) {
    const t = String(text).toLowerCase();
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

/* ============================================================
 * 2. CALENDAR MATH
 * ============================================================ */

export function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Дополнительные дни (Sumarauki / Auknætr): 4, в високосный год — 5. */
export function aukDays(year) {
    return isLeapYear(year) ? 5 : 4;
}

export function leapsBefore(year) {
    const y = year - 1;
    return Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

/** Серийный номер дня в лорном календаре. */
export function serialOf(year, month, day) {
    let doy;
    if (isAuk(month)) {
        doy = 7 * 30 + day;
    } else {
        doy = (month - 1) * 30 + day + (month > 7 ? aukDays(year) : 0);
    }
    return (year - 1) * 364 + leapsBefore(year) + doy - 1;
}

export function serialToDate(serial) {
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
export function weekdayOf(year, month, day) {
    return (serialOf(year, month, day) + 1) % 7;
}

/** Прибавляет n дней к дате. */
export function addDays(year, month, day, n) {
    return serialToDate(serialOf(year, month, day) + n);
}

/** Возраст Луны и её фаза для заданной даты. */
export function moonPhase(year, month, day) {
    const anchor = serialOf(2000, 1, 6);
    const age = (((serialOf(year, month, day) - anchor) % MOON_CYCLE) + MOON_CYCLE) % MOON_CYCLE;
    const phase = MOON_PHASES.find((p) => age >= p.from && age < p.to) ?? MOON_PHASES[0];
    return { age, phase };
}

/* ============================================================
 * 3. PLACEHOLDERS
 *
 * Модель иногда копирует шаблон буквально: `<Current Eykt>`,
 * `<Day VikingMonth Year>`, `<{{char}}'s current mood(s)>`. Такие
 * значения нужно отбросить — но только их: обычный текст со знаком
 * «>» («ветер > 15 м/с») или в фигурных скобках («{радость}») валиден.
 * ============================================================ */

/** Значение целиком заключено в угловые скобки: <Current weather>. */
const ANGLE_TEMPLATE_RE = /^\s*<[^<>]*>\s*$/;

/** В значении осталась неподставленная макро-переменная: {{char}}. */
const UNRESOLVED_MACRO_RE = /\{\{[^{}]*\}\}/;

/** true, если значение — литеральный плейсхолдер из шаблона промпта. */
export function isPlaceholder(value) {
    if (typeof value !== "string") return true;
    return ANGLE_TEMPLATE_RE.test(value) || UNRESOLVED_MACRO_RE.test(value);
}

/* ============================================================
 * 4. DATE PARSING
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

export function isValidDate(d) {
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
export function findDateInYorni(text) {
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

/* ============================================================
 * 5. YORNI PARSER
 * ============================================================ */

/*
 * Маркер — HTML-комментарий. Комментарий браузер не рисует, поэтому прятать
 * его регексами не нужно: он невидим сам по себе.
 *
 *   <!-- [YORNI:
 *   eykt: хадеги
 *   date: 13 гормануд 1015
 *   ] -->
 *
 * Внутри значений нельзя писать `-->`: браузер закроет комментарий на нём,
 * и хвост маркера станет виден в чате до того, как мы его вырежем. Промпт это
 * запрещает; сам разбор к таким значениям устойчив (проверено тестом).
 */
export const YORNI_MARKER_RE = /<!--\s*\[YORNI:([\s\S]*?)\]\s*-->/i;

/* Оборванная генерация: маркер начался, но закрыться не успел. */
const YORNI_MARKER_OPEN_RE = /<!--\s*\[YORNI:([\s\S]{10,4000})$/i;

/* Прежний видимый формат — нужен для миграции старых чатов. */
export const YORNI_LEGACY_RE = /<yorni>([\s\S]{10,4000}?)<\/yorni>/i;

/** Все формы маркера — для вырезания из текста сообщения. */
const YORNI_STRIP_RES = [
    /<!--\s*\[YORNI:[\s\S]*?\]\s*-->/gi,
    /<!--\s*\[YORNI:[\s\S]*$/i,
    /<yorni>[\s\S]*?<\/yorni>/gi,
];

/** Внутренности маркера в любом из форматов, либо null. */
function extractMarker(text) {
    const s = String(text ?? "");
    return (s.match(YORNI_MARKER_RE)
        ?? s.match(YORNI_MARKER_OPEN_RE)
        ?? s.match(YORNI_LEGACY_RE))?.[1] ?? null;
}

/** Есть ли в тексте маркер календаря (в любом из форматов). */
export function hasYorniMarker(text) {
    return extractMarker(text) !== null;
}

/**
 * Вырезает маркер из текста сообщения.
 *
 * Убирает только дыру, оставшуюся на месте маркера: если он стоял между
 * абзацами, там повисает лишняя пустая строка. Пробелы внутри самой прозы
 * не трогаем — они не наши, и подчищать чужой текст расширение не должно.
 */
export function stripYorniMarkers(text) {
    if (!text) return text;
    let out = String(text);
    for (const re of YORNI_STRIP_RES) out = out.replace(re, "");
    return out.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n").trim();
}

/** Пустой результат разбора: все поля null. */
function emptyResult() {
    return {
        year: null, month: null, day: null, hour: null, minute: null,
        weather: null, location: null, userAttire: null,
        charMood: null, charAttire: null, thought: null,
    };
}

/** true, если в результате нет ни даты, ни времени, ни одного текстового поля. */
export function isEmptyResult(r) {
    if (!r) return true;
    return !hasDate(r) && !hasTime(r) && !hasDetails(r);
}

/** Дата распознана (день + месяц — минимум для календаря). */
export function hasDate(r) {
    return !!r && r.day !== null && r.month !== null;
}

/** Время распознано (точное или по названию эйкты). */
export function hasTime(r) {
    return !!r && r.hour !== null;
}

/** Есть хотя бы одно текстовое поле сцены. */
export function hasDetails(r) {
    if (!r) return false;
    return !!(r.weather || r.location || r.userAttire || r.charMood || r.charAttire || r.thought);
}

const FIELD_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/;

/**
 * Разбирает `key: value` построчно.
 *
 * Помимо словаря полей отдаёт `cleanInner` — тот же блок без строк с
 * литеральными плейсхолдерами. Он используется как запасная площадка для
 * поиска даты, если поле `date` отсутствует или не разобралось: искать по
 * сырому блоку нельзя, иначе `<Day VikingMonth Year>` попадёт в разбор.
 */
function parseFields(inner) {
    const fields = {};
    const cleanLines = [];
    for (const line of inner.split(/\r?\n/)) {
        const kv = line.match(FIELD_LINE_RE);
        const value = kv ? kv[2].trim() : line.trim();
        if (kv) fields[kv[1].toLowerCase()] = value;
        if (!isPlaceholder(value)) cleanLines.push(line);
    }
    return { fields, cleanInner: cleanLines.join("\n") };
}

/**
 * Разбирает маркер календаря — единственный источник метаданных.
 *
 * Понимает и невидимый `<!-- [YORNI: … ] -->`, и прежний видимый
 * `<yorni>…</yorni>`, чтобы старые чаты читались без миграции.
 *
 * Возвращает объект, даже если дата не распозналась: поля сцены (погода,
 * локация, настроение, одежда, мысль) отдаются отдельно от даты, чтобы
 * одна кривая строка `date:` не обнуляла весь инфоблок.
 *
 * @param {string} rawText Текст сообщения
 * @returns {object|null} Результат разбора или null, если маркера нет либо он пуст
 */
export function parseYorniTag(rawText) {
    const inner = extractMarker(rawText);
    if (inner === null) return null;

    const { fields, cleanInner } = parseFields(inner);
    const result = emptyResult();

    /* --- дата --- */
    const candidates = [];
    if (fields.date) candidates.push(fields.date);
    candidates.push(cleanInner);

    let dateZone = "";
    for (let cand of candidates) {
        const jm = cand.match(/"output"\s*:\s*"([^"]+)"/i);
        if (jm) cand = jm[1].trim();
        if (isPlaceholder(cand)) continue;
        const found = findDateInYorni(cand);
        if (found) {
            result.year = found.year;
            result.month = found.month;
            result.day = found.day;
            dateZone = cand;
            break;
        }
    }

    /* --- время: точное HH:MM либо середина названной эйкты --- */
    const eyktVal = fields.eykt && !isPlaceholder(fields.eykt) ? fields.eykt : null;
    if (eyktVal) {
        const tm = eyktVal.match(TIME_PATTERN);
        if (tm && +tm[1] <= 24 && +tm[2] <= 59) {
            result.hour = +tm[1];
            result.minute = +tm[2];
        } else {
            const idx = eyktFromText(eyktVal);
            if (idx !== null) {
                const mid = EYKTIR[idx].mid;
                result.hour = Math.floor(mid);
                result.minute = Math.round((mid % 1) * 60);
            }
        }
    }
    if (result.hour === null && dateZone) {
        const tm = dateZone.match(TIME_PATTERN);
        if (tm && +tm[1] <= 24 && +tm[2] <= 59) {
            result.hour = +tm[1];
            result.minute = +tm[2];
        }
    }

    /* --- текстовые поля сцены --- */
    const clean = (v) => (v && !isPlaceholder(v) ? v : null);
    result.weather = clean(fields.weather);
    result.location = clean(fields.location);
    result.userAttire = clean(fields.user_attire);
    result.charMood = clean(fields.mood);
    result.charAttire = clean(fields.char_attire);
    result.thought = clean(fields.thought);

    return isEmptyResult(result) ? null : result;
}
