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
 * Год исландского счёта времени (misseri) начинается с зимы, с Gormánaður,
 * поэтому индекс месяца здесь — порядковый номер в ЛОРНОМ году, а не в
 * григорианском: 1 = Gormánaður, 12 = Haustmánuður.
 *
 * Устройство года:
 *   12 месяцев × 30 дней                     = 360
 *   + 4 аукнэтр в середине лета              = 364 = ровно 52 недели
 *   + вставная неделя сумарауки раз в 5–6 лет = 371 = ровно 53 недели
 *
 * Обе вставки дают целое число недель, поэтому год всегда начинается с одного
 * и того же дня — с Laugardagr, первого дня зимы. Оттуда же само собой выходит,
 * что лето (1 Harpa) всегда приходится на Þórsdagr — тот самый sumardagurinn
 * fyrsti. Это проверяется тестом, а не задано вручную.
 *
 * Дни недели: индекс 0 = понедельник.
 * Эйкты: 8 × 3 часа.
 * ============================================================ */

/**
 * Месяцы лорного года по порядку. Зима (Vetr) — 1–6, лето (Sumar) — 7–12.
 *
 * `modern` — примерное соответствие григорианскому месяцу, только для справки
 * и для разбора числовых дат. `stems` — по чему месяц узнаётся в тексте;
 * они лежат здесь же, чтобы порядок и распознавание не могли разъехаться.
 */
export const MONTHS_LORE = [
    { norse: "Gormánaður",   translit: "Gormanud",   ru: "Гормануд",   modern: "Ноябрь",   modernNum: 11,
      stems: ["nov", "ноя", "ной", "gorm", "горм"],
      gloss: "«месяц забоя» — время резать скот на зиму" },
    { norse: "Ýlir",         translit: "Ylir",       ru: "Юлир",       modern: "Декабрь",  modernNum: 12,
      stems: ["dec", "дек", "ýl", "ylir", "юлир"],
      gloss: "«месяц Юля» — время середины зимы" },
    { norse: "Mörsugur",     translit: "Morsugur",   ru: "Морсугур",   modern: "Январь",   modernNum: 1,
      stems: ["jan", "янв", "mörs", "mors", "морс"],
      gloss: "«сосущий жир» — время жить запасами" },
    { norse: "Þorri",        translit: "Thorri",     ru: "Торри",      modern: "Февраль",  modernNum: 2,
      stems: ["feb", "фев", "þor", "thor", "торр"],
      gloss: "по имени зимнего духа Торри; месяц самых злых холодов" },
    { norse: "Góa",          translit: "Goa",        ru: "Гоа",        modern: "Март",     modernNum: 3,
      stems: ["mar", "мар", "góa", "goa", "гоа"],
      gloss: "по имени Гои, дочери Торри" },
    { norse: "Einmánuður",   translit: "Einmanud",   ru: "Эйнмануд",   modern: "Апрель",   modernNum: 4,
      stems: ["apr", "апр", "einm", "эйн"],
      gloss: "«одинокий месяц» — последний месяц зимы" },
    { norse: "Harpa",        translit: "Harpa",      ru: "Харпа",      modern: "Май",      modernNum: 5,
      stems: ["may", "мая", "май", "harp", "харп"],
      gloss: "по имени Харпы; первый день — начало лета" },
    { norse: "Skerpla",      translit: "Skerpla",    ru: "Скерпла",    modern: "Июнь",     modernNum: 6,
      stems: ["jun", "июн", "skerp", "скерп"],
      gloss: "происхождение названия неясно" },
    { norse: "Sólmánuður",   translit: "Solmanud",   ru: "Сольмануд",  modern: "Июль",     modernNum: 7,
      stems: ["jul", "июл", "sólm", "solm", "сольм"],
      gloss: "«солнечный месяц» — самые длинные дни" },
    { norse: "Heyannir",     translit: "Heyannir",   ru: "Хейаннир",   modern: "Август",   modernNum: 8,
      stems: ["aug", "авг", "heyan", "хейан"],
      gloss: "«сенокосные хлопоты» — время косить и сушить сено" },
    { norse: "Tvímánuður",   translit: "Tvimanud",   ru: "Твимануд",   modern: "Сентябрь", modernNum: 9,
      stems: ["sep", "сен", "tvím", "tvim", "твим"],
      gloss: "«второй месяц» — второй месяц жатвы" },
    { norse: "Haustmánuður", translit: "Haustmanud", ru: "Хаустмануд", modern: "Октябрь",  modernNum: 10,
      stems: ["oct", "окт", "haust", "хауст"],
      gloss: "«осенний месяц» — последний месяц лета" },
];

export const MONTHS_NORSE_RU = MONTHS_LORE.map((m) => m.ru);
export const MONTHS_RU_NOM = MONTHS_LORE.map((m) => m.modern);
export const MONTH_STEMS = MONTHS_LORE.map((m) => m.stems);

/** Григорианский номер месяца → номер в лорном году. */
const MONTH_BY_MODERN = new Map(MONTHS_LORE.map((m, i) => [m.modernNum, i + 1]));

/**
 * Число из числовой даты («21.10.2023») — это григорианский месяц, а не номер
 * в лорном году: модель, скатившаяся на цифры, думает привычным календарём.
 */
export function monthFromModernNumber(n) {
    return MONTH_BY_MODERN.get(n) ?? null;
}

/** Зима — первая половина года, лето — вторая. Ровно по шесть месяцев. */
export const WINTER_MONTHS = 6;

/**
 * Дни недели, начиная с понедельника.
 * Индекс совпадает с тем, что возвращает weekdayOf().
 */
export const WEEKDAYS_LORE = [
    { norse: "Mánadagr",   en: "Monday",    ru: "Понедельник",  short: "Mán", desc: "День Луны" },
    { norse: "Týsdagr",    en: "Tuesday",   ru: "Вторник",      short: "Týs", desc: "День Тюра" },
    { norse: "Óðinsdagr",  en: "Wednesday", ru: "Среда",        short: "Óðn", desc: "День Одина" },
    { norse: "Þórsdagr",   en: "Thursday",  ru: "Четверг",      short: "Þór", desc: "День Тора" },
    { norse: "Frjádagr",   en: "Friday",    ru: "Пятница",      short: "Frj", desc: "День Фригг / Фрейи" },
    { norse: "Laugardagr", en: "Saturday",  ru: "Суббота",      short: "Lau", desc: "«Банный день» — день омовения" },
    { norse: "Sunnudagr",  en: "Sunday",    ru: "Воскресенье",  short: "Sun", desc: "День Солнца" },
];

export const WEEKDAYS_FULL_RU = WEEKDAYS_LORE.map((w) => w.ru);
export const WEEKDAY_DESC_RU = WEEKDAYS_LORE.map((w) => w.desc);
export const WEEKDAYS_SHORT_NORSE = WEEKDAYS_LORE.map((w) => w.short);

/** Первый день зимы, а значит и года, — суббота (fyrsti vetrardagur). */
export const YEAR_STARTS_ON = WEEKDAYS_LORE.findIndex((w) => w.en === "Saturday");

/*
 * Основы для распознавания вставных дней. Кириллица здесь обязательна:
 * промпт просит модель писать по-русски, и она пишет «2 аукнэтр 1015».
 */
export const AUK_STEMS = [
    "sumarauki", "aukn", "auk",
    "сумараук", "аукн", "аук",
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

/*
 * `icon` — эмодзи, `iconName` — имя файла в `icons/`.
 *
 * Два поля, а не одно: виджет рисует луну своим знаком через CSS-маску, а
 * Tímatal и текстовые сводки остаются на эмодзи — там знак идёт внутри
 * обычной строки, и подменять его элементом незачем.
 */
export const MOON_PHASES = [
    { norse: "Ný",          en: "New Moon",    ru: "Новолуние",      icon: "🌑", iconName: "moon-ny",       from: 0,    to: 1.8,
      desc: "время зарождения и планов" },
    { norse: "Vaxandi",     en: "Waxing Moon", ru: "Растущая луна",  icon: "🌒", iconName: "moon-vaxandi",  from: 1.8,  to: 13.0,
      desc: "время дел, походов и строительства" },
    { norse: "Fullt tungl", en: "Full Moon",   ru: "Полнолуние",     icon: "🌕", iconName: "moon-fullt",    from: 13.0, to: 16.5,
      desc: "пик силы, время Блотов и Тинга" },
    { norse: "Minnandi",    en: "Waning Moon", ru: "Убывающая луна", icon: "🌖", iconName: "moon-minnandi", from: 16.5, to: 27.7,
      desc: "время завершать дела и возвращаться домой" },
    { norse: "Nið",         en: "Dark Moon",   ru: "Безлуние",       icon: "🌚", iconName: "moon-nid",      from: 27.7, to: 29.53,
      desc: "ночи волка Хати, время отдыха и осторожности" },
];

/** Номер месяца (1–12), "AUK" для Sumarauki, или null. */
export function monthFromName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    if (AUK_STEMS.some((s) => n.startsWith(s))) return "AUK";
    // Голое число — это почти наверняка григорианский месяц из «21.10.2023»,
    // а не порядковый номер в лорном году. Переводим.
    if (/^\d{1,2}$/.test(n)) {
        return MONTH_BY_MODERN.get(parseInt(n, 10)) ?? null;
    }
    for (let i = 0; i < MONTH_STEMS.length; i++) {
        if (MONTH_STEMS[i].some((s) => n.startsWith(s))) return i + 1;
    }
    return null;
}

export function isAuk(month) {
    return month === "AUK";
}

/**
 * Полугодие. Аукнэтр приходятся на середину лета, поэтому тоже Sumar.
 */
export function seasonOf(month) {
    return isAuk(month) || month > WINTER_MONTHS
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

/** Обычный год — ровно 52 недели. */
export const COMMON_YEAR_DAYS = 364;
/** Аукнэтр: четыре дня в середине лета, каждый год. */
export const AUKNAETR_DAYS = 4;
/** Сумарауки: вставная неделя, туда же, раз в 5–6 лет. */
export const SUMARAUKI_DAYS = 7;
/** После какого месяца стоит вставка. Sólmánuður — девятый месяц лорного года. */
export const AUK_AFTER_MONTH = 9;

/* Год из 364 дней короче солнечного примерно на 1.2425 суток. Как только
   накопленное отставание дотягивает до недели, её вставляют — отсюда и
   выходит шаг «раз в пять-шесть лет», без таблицы исключений. */
const YEAR_DRIFT = 365.2425 - COMMON_YEAR_DAYS;
const weeksInsertedBefore = (year) => Math.floor(((year - 1) * YEAR_DRIFT) / SUMARAUKI_DAYS);

/** Год со вставной неделей сумарауки. */
export function isSumaraukiYear(year) {
    return weeksInsertedBefore(year + 1) > weeksInsertedBefore(year);
}

/** Длина вставки в середине лета: аукнэтр, а в год сумарауки — вместе с неделей. */
export function aukDays(year) {
    return AUKNAETR_DAYS + (isSumaraukiYear(year) ? SUMARAUKI_DAYS : 0);
}

/** Длина года в днях — всегда кратна семи. */
export function yearLength(year) {
    return COMMON_YEAR_DAYS + (isSumaraukiYear(year) ? SUMARAUKI_DAYS : 0);
}

/** Сколько недель в году: 52 или 53. */
export function weeksInYear(year) {
    return yearLength(year) / 7;
}

/** Порядковый номер дня в году, 1 … yearLength(). */
export function dayOfYear(year, month, day) {
    if (isAuk(month)) return AUK_AFTER_MONTH * 30 + day;
    const auk = month > AUK_AFTER_MONTH ? aukDays(year) : 0;
    return (month - 1) * 30 + day + auk;
}

/** Номер недели (vika) в году, 1 … weeksInYear(). */
export function vikaOf(year, month, day) {
    return Math.ceil(dayOfYear(year, month, day) / 7);
}

/** Серийный номер дня, сквозной через все годы. */
export function serialOf(year, month, day) {
    let daysBefore = (year - 1) * COMMON_YEAR_DAYS + weeksInsertedBefore(year) * SUMARAUKI_DAYS;
    return daysBefore + dayOfYear(year, month, day) - 1;
}

export function serialToDate(serial) {
    let y = Math.max(1, Math.floor(serial / 365.2425) + 1);
    while (serial < serialOf(y, 1, 1)) y--;
    while (serial >= serialOf(y + 1, 1, 1)) y++;

    const rem = serial - serialOf(y, 1, 1);          // 0-based день года
    const beforeAuk = AUK_AFTER_MONTH * 30;
    const auk = aukDays(y);

    if (rem < beforeAuk) {
        return { year: y, month: Math.floor(rem / 30) + 1, day: (rem % 30) + 1 };
    }
    if (rem < beforeAuk + auk) {
        return { year: y, month: "AUK", day: rem - beforeAuk + 1 };
    }
    const rest = rem - auk;
    return { year: y, month: Math.floor(rest / 30) + 1, day: (rest % 30) + 1 };
}

/**
 * День недели, 0 = понедельник.
 *
 * Все годы состоят из целых недель, поэтому достаточно отсчитать от первого
 * дня года — а он всегда Laugardagr, первый день зимы.
 */
export function weekdayOf(year, month, day) {
    return (dayOfYear(year, month, day) - 1 + YEAR_STARTS_ON) % 7;
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
        map: (m) => ({ year: +m[1], month: monthFromModernNumber(+m[2]), day: +m[3], monthWord: false }),
    },
    {
        re: /(\d{1,2})[./](\d{1,2})[./](\d{3,4})/g,
        map: (m) => ({ day: +m[1], month: monthFromModernNumber(+m[2]), year: +m[3], monthWord: false }),
    },
];

/** Точность даты: 2 = полная с годом, 1 = месяц словом без года, 0 = мусор. */
function dateScore(d) {
    if (typeof d.month === "string") return d.year !== null ? 2 : 1;
    if (d.year !== null) return 2;
    if (d.monthWord) return 1;
    return 0;
}

/** Самая длинная возможная вставка: аукнэтр плюс неделя сумарауки. */
const MAX_AUK_DAY = AUKNAETR_DAYS + SUMARAUKI_DAYS;

export function isValidDate(d) {
    if (!d) return false;
    if (d.month === "AUK") {
        // Верхняя граница — по самой длинной вставке: год может быть ещё неизвестен,
        // а в год сумарауки вставных дней одиннадцать, а не четыре.
        if (!d.day || d.day < 1 || d.day > MAX_AUK_DAY) return false;
    } else {
        if (!d.month || d.month < 1 || d.month > 12) return false;
        if (!d.day || d.day < 1 || d.day > 31) return false;
    }
    if (d.year !== null && (isNaN(d.year) || d.year < 1 || d.year > 9999)) return false;
    return true;
}

/** Приводит дату к лорному календарю: в месяце ровно 30 дней, вставка короче. */
function finalizeDate(d) {
    if (d.month === "AUK") {
        // Год известен — можно поджать до настоящей длины вставки этого года.
        if (d.year !== null && d.year !== undefined) {
            const limit = aukDays(d.year);
            if (d.day > limit) d.day = limit;
        }
    } else if (d.day > 30) {
        d.day = 30;
    }
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
            const c = finalizeDate({ day: +m[1], month: monthFromModernNumber(+m[2]), year: 2000 + +m[3] });
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
        charMood: null, charAttire: null, thought: null, passed: null, body: null,
        charState: null, userState: null, advice: null,
        midwife: null, women: null, charms: null, gear: null,
        faderni: null, childRank: null, childName: null,
        sex: null, internal: null,
    };
}

/**
 * «да» / «нет» / молчание.
 *
 * Третье значение — не лень, а часть смысла: `internal: неизвестно` говорит,
 * что близость была, а куда пролилось семя, сцена не уточнила. Движок тогда
 * считает по меньшему шансу, а не выдумывает за неё.
 */
export function parseYesNo(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).toLowerCase().replace(/ё/g, "е").trim();
    /* Границу слова ищем отрицательным просмотром вперёд, а не \b: в JS \b
       считает словом только латиницу, и на кириллице просто не срабатывает.
       Заодно «неизвестно» не принимается за «нет». */
    if (/^(да|был|была|было|есть|yes|true|1)(?![а-яa-z])/i.test(text)) return true;
    if (/^(нет|no|false|0)(?![а-яa-z])/i.test(text)) return false;
    return null;
}

/*
 * События тела — закрытый список.
 *
 * Модель называет только то, что случилось в сцене; день цикла, срок и прочую
 * арифметику считает расширение. Список закрыт нарочно: свободную формулировку
 * пришлось бы разбирать догадками, а ошибка тут сдвигает не строчку в панели,
 * а весь дальнейший счёт.
 */
const BODY_EVENTS = [
    ["seedWithheld", /семя\s+не\s+пролилось/i],
    ["seedSpilled", /семя\s+пролилось/i],
    ["bleedStart", /кровь\s+(?:пришла|началась|пошла)|нача(?:лись|лась)\s+(?:месячные|кровь)/i],
    ["bleedEnd", /кровь\s+(?:кончилась|прекратилась|ушла)|месячные\s+кончились/i],
    ["oddBleeding", /кровь\s+не\s+в\s+срок/i],
    ["quickened", /дитя\s+шевельнулось|шевеление/i],
    ["labour", /схватки\s+начались/i],
    ["birth", /родила|дитя\s+родилось/i],
    ["lost", /выкидыш|дитя\s+не\s+выжило/i],
    /* Прямое объявление из сцены. Нужно потому, что бросок может промахнуться,
       а ролевая — уже поехать дальше: «а если я понесу от тебя?» и OOC
       «пометь, что беременность случилась». Без такого события движок и проза
       расходятся навсегда, и починить это изнутри игры нечем. */
    /* Сбои цикла: тидир задерживаются не только от дитяти. */
    ["hungr", /голодала|голодали/i],
    ["sott", /хворала|занемогла|слегла/i],
    ["ferd", /была\s+в\s+дороге|дорога\s+измотала/i],
    ["ugg", /извелась|истерзалась/i],
    /* Шевеления — единственное, чем в этом веке узнавали, жив ли ребёнок.
       Отсюда и тревога, когда их нет второй день. */
    ["kick", /дитя\s+(?:бьется|бьётся|толкается|шевелится)/i],
    ["quiet", /дитя\s+(?:затихло|притихло)|дитя\s+не\s+слыхать/i],
    ["conceived", /понесла|дитя\s+зачалось|зачатие/i],
    ["realized", /поняла,?\s+что\s+тяжела|поняла,?\s+что\s+беременна/i],
    ["nursingStart", /дитя\s+у\s+груди/i],
    ["nursingEnd", /отняли\s+от\s+груди/i],
    /* Вехи первых двух лет. Возраст и нужды панель считает сама, а вот эти
       четыре вещи она увидеть не может — они случаются в сцене и больше
       нигде. Зубок стоит отдельной строкой не для красоты: за первый зуб
       дитяти полагался таннфе, подарок, и это событие рода, а не медицина. */
    ["childTooth", /зубок\s+прорезался|первый\s+зуб/i],
    ["childWalks", /дитя\s+пошло|первые\s+шаги/i],
    ["childSpeaks", /дитя\s+заговорило|первое\s+слово/i],
    ["childSick", /дитя\s+занемогло|дитя\s+захворало/i],
    ["childWell", /дитя\s+поправилось/i],
    ["childDied", /дитя\s+померло|дитя\s+умерло/i],
    /*
     * Тяготы. Названы отдельными словами, а не выведены из вольного описания
     * состояния: догадка тут стоит не строчки в панели, а ребёнка. Голод,
     * хворь и дорога уже есть выше — они и сбивают цикл, и давят на утробу.
     */
    ["heavy", /подняла\s+тяж[её]лое|таскала\s+тяж[её]лое|надсаживалась\s+над/i],
    ["strained", /надорвалась|надсадилась/i],
    ["fell", /упала|оступилась/i],
    ["beaten", /побили|избили|ударили\s+её/i],
    /* Единственный способ ответить на угрозу. «Слегла» тут не годится — оно
       уже занято хворью, и одно слово на два смысла не годится вовсе. */
    ["rest", /легла\s+пластом|не\s+вста[её]т\s+с\s+постели|лежит\s+пластом/i],
    ["stillborn", /дитя\s+родилось\s+м[её]ртвым|мертворожд[её]нн/i],
];

/**
 * Список опознанных событий тела в том порядке, в каком они стоят в тексте.
 *
 * Порядок не косметика: «родила; кровь пришла» и «кровь пришла; родила» —
 * разные истории, а разбор по порядку правил дал бы одну и ту же. Сортируем
 * по месту совпадения, то есть по тому, как это случилось в сцене.
 */
export function parseBodyEvents(value) {
    if (!value) return null;
    const raw = String(value).toLowerCase();
    /* Регулярки писаны с «ё», в тексте её может не быть — сверяем обе формы. */
    const flat = raw.replace(/ё/g, "е");
    const found = [];
    for (const [id, re] of BODY_EVENTS) {
        const at = Math.max(raw.search(re), flat.search(re));
        if (at >= 0) found.push({ id, at });
    }
    if (!found.length) return null;
    return found.sort((a, b) => a.at - b.at).map((e) => e.id);
}

/**
 * Сколько времени прошло со сцены — в днях.
 *
 * Обычный ход даты не двигает вовсе, а смену суток ловит перелистывание по
 * эйкте. Но таймскип так не поймать: «прошло два месяца» с точки зрения эйкт
 * выглядит как обычное утро. Поэтому у скачков есть своё поле, и заполняется
 * оно только в тот ход, когда скачок случился.
 *
 * Модель пишет наблюдение — «2 месяца», — а не вычисленную дату. Считать мы
 * умеем сами, и считаем одинаково от свайпа к свайпу; модель же на одну и ту
 * же арифметику каждый раз отвечает по-своему, это уже проверено.
 */
/*
 * Числительные словами. Порядок важен: длинные стемы идут первыми, иначе
 * «полторы» съест правило для «пол». Границу слова ищем вручную — \b в JS
 * считает словом только латиницу, и на кириллице просто не срабатывает.
 */
const PASSED_WORDS = [
    ["полторы", 1.5], ["полтора", 1.5],
    /* «сутки» и «суток» тут не числительные, а единица — они ниже. */
    ["один", 1], ["одна", 1], ["одну", 1],
    ["двое", 2], ["два", 2], ["две", 2], ["пара", 2], ["пару", 2], ["парой", 2],
    ["трое", 3], ["три", 3], ["четверо", 4], ["четыре", 4],
    ["пять", 5], ["шесть", 6], ["семь", 7], ["восемь", 8], ["девять", 9],
    ["десять", 10], ["одиннадцать", 11], ["двенадцать", 12],
];

/** Единица → сколько в ней дней. Длинные проверяем первыми. */
const PASSED_UNITS = [
    /* Год берём обычный, 364 дня: год сумарауки на неделю длиннее, но какой
       именно год пересечёт скачок, здесь ещё неизвестно. Неделя погрешности
       на скачке в годы роли не играет, а точную дату правят в Tímatal. */
    [/(?:^|[^а-я])(?:год|года|году|лет)(?:$|[^а-я])/i, COMMON_YEAR_DAYS],
    [/(?:^|[^а-я])(?:месяц|месяца|месяцев|луна|луны|лун)(?:$|[^а-я])/i, 30],
    [/недел/i, 7],
    [/(?:^|[^а-я])(?:день|дня|дней|сутки|суток)(?:$|[^а-я])/i, 1],
];

export function parsePassed(value) {
    if (!value) return null;
    const text = ` ${String(value).toLowerCase().replace(/ё/g, "е").trim()} `;

    /* Слитные «полдня», «полгода» — отдельно: иначе пришлось бы вписывать
       приставку в каждый стем единицы. */
    if (/полдня|пол дня/.test(text)) return 0;
    if (/полгода|пол года/.test(text)) return 180;
    if (/полмесяца|пол месяца|поллуны/.test(text)) return 15;
    if (/полнедели|пол недели/.test(text)) return 3;

    let count = null;
    const digits = text.match(/(\d+(?:[.,]\d+)?)/);
    if (digits) {
        count = Number(digits[1].replace(",", "."));
    } else {
        for (const [word, n] of PASSED_WORDS) {
            if (text.includes(word)) { count = n; break; }
        }
    }
    if (count === null) count = 1;

    /* «Три с половиной месяца» — счёт и добавка стоят порознь, и без этой
       строки половина просто терялась: скачок выходил ровно на три месяца. */
    if (/ с половиной | и половиной /.test(text)) count += 0.5;

    for (const [re, days] of PASSED_UNITS) {
        if (re.test(text)) return Math.max(0, Math.round(count * days));
    }

    /* Единицу не узнали — молчим. Догадка тут дороже пропуска: ошибочный
       скачок уводит календарь на месяцы, а пропущенный правится в Tímatal. */
    return null;
}

/**
 * true, если в маркере не оказалось вообще ничего полезного.
 *
 * Проверять одни лишь поля сцены нельзя: маркер, где стоит только
 * `body: кровь пришла`, полями сцены пуст — и раньше отбрасывался целиком
 * вместе с событием. Обрыв генерации и скупой ответ выглядят именно так.
 */
export function isEmptyResult(r) {
    if (!r) return true;
    return !hasDate(r) && !hasTime(r) && !hasDetails(r) && !hasEvents(r) && !hasTold(r);
}

/** Есть ли в маркере событие тела, близость или скачок времени. */
export function hasEvents(r) {
    if (!r) return false;
    return !!(r.body?.length) || r.sex !== null || r.internal !== null || r.passed !== null;
}

/**
 * Поля, которые модель сообщает один раз, а действуют они дальше:
 * имя дитяти, признание отцовства, готовность к родам.
 */
export const TOLD_FIELDS = ["midwife", "women", "charms", "gear", "faderni", "childRank", "childName"];

/** Есть ли в маркере хоть одно такое поле. */
export function hasTold(r) {
    return !!r && TOLD_FIELDS.some((key) => r[key]);
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
    return !!(r.weather || r.location || r.userAttire || r.charMood || r.charAttire || r.thought
        || r.charState || r.userState || r.advice);
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
    result.charState = clean(fields.char_state);
    result.userState = clean(fields.user_state);
    result.advice = clean(fields.advice);
    /* Готовность к родам и правовой слой. Спрашиваются не всегда, а только
       когда к месту, — поля просто отсутствуют в остальное время. */
    result.midwife = clean(fields.midwife);
    result.women = clean(fields.women);
    result.charms = clean(fields.charms);
    result.gear = clean(fields.gear);
    result.faderni = clean(fields.faderni);
    result.childRank = clean(fields.child_rank);
    result.childName = clean(fields.child_name);
    result.passed = parsePassed(clean(fields.passed));
    result.body = parseBodyEvents(clean(fields.body));
    result.sex = parseYesNo(clean(fields.sex));
    result.internal = parseYesNo(clean(fields.internal));

    return isEmptyResult(result) ? null : result;
}
