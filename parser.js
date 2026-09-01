/*
 * NORNIR — календарные таблицы и парсер маркера <!-- [URD: … ] -->.
 *
 * Чистый ES-модуль без зависимостей от SillyTavern: его импортирует и
 * расширение (index.js), и автономный тест (test-parse.mjs). Единственный
 * источник правды для календарных данных и разбора инфоблока.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Calendar Data ...... Месяцы, дни недели, эйкты, фазы Луны
 * 2. Calendar Math ...... Серийные дни, дни недели, addDays, фаза Луны
 * 3. Placeholders ....... Отбраковка литеральных плейсхолдеров из шаблона
 * 4. Date Parsing ....... Распознавание даты и времени
 * 5. Urd Parser ......... Разбор маркера <!-- [URD: … ] -->
 */

/* ============================================================
 * 1. CALENDAR DATA
 *
 * Год древнеисландского счёта времени (misseri) начинается с зимы, с Gormánuðr,
 * поэтому индекс месяца здесь — порядковый номер в ДРЕВНЕИСЛАНДСКОМ году, а не в
 * григорианском: 1 = Gormánuðr, 12 = Haustmánuðr.
 *
 * Устройство года:
 *   12 месяцев × 30 дней                     = 360
 *   + 4 аукнэтр в середине лета              = 364 = ровно 52 недели
 *   + вставная неделя сумарауки раз в 5–6 лет = 371 = ровно 53 недели
 *
 * Обе вставки дают целое число недель, поэтому год всегда начинается с одного
 * и того же дня — с Laugardagr, первого дня зимы. Оттуда же само собой выходит,
 * что лето (1 Harpa) всегда приходится на Þórsdagr — тот самый sumardagrinn
 * fyrsti. Это проверяется тестом, а не задано вручную.
 *
 * Дни недели: индекс 0 = Laugardagr, с него же начинается и вика.
 * Эйкты: 8 × 3 часа.
 * ============================================================ */

/**
 * Месяцы древнеисландского года по порядку. Зима (Vetr) — 1–6, лето (Sumar) — 7–12.
 *
 * Написание древнескандинавское, а не современное исландское: `mánuðr`, а не
 * `mánuður`; `Gói`, а не `Góa`. Разница — ровно та эпоха, ради которой всё
 * и затевалось: окончание `-uður` и форма `Góa` сложились много позже X века.
 * Дни недели ниже по той же причине оставлены языческими: имена богов ушли из
 * исландской недели только с церковной реформой начала XII века, а на материке
 * держались и дольше.
 *
 * Одно сознательное отступление от академической нормы: пишем `ö`, а не `ǫ`
 * (`Mörsugr`, не `Mǫrsugr`). O-ogonek роняет половина шрифтов, его не набрать
 * с обычной раскладки, и в поиске по тексту он не совпадёт ни с чем, что
 * напишет пользователь или модель.
 *
 * `modern` — примерное соответствие григорианскому месяцу, только для справки
 * и для разбора числовых дат. `stems` — по чему месяц узнаётся в тексте;
 * они лежат здесь же, чтобы порядок и распознавание не могли разъехаться.
 * Поздние написания в основах оставлены намеренно: модель вполне может выдать
 * «Góa» или «Haustmánuður», и не узнать их было бы глупо.
 */
export const MONTHS = [
    { norse: "Gormánuðr",   translit: "Gormanudr",   ru: "Гормануд",   modern: "Ноябрь",   modernNum: 11,
      stems: ["nov", "ноя", "ной", "gorm", "горм"],
      gloss: "«месяц забоя» — время резать скот на зиму" },
    { norse: "Ýlir",        translit: "Ylir",        ru: "Юлир",       modern: "Декабрь",  modernNum: 12,
      stems: ["dec", "дек", "ýl", "ylir", "юлир"],
      gloss: "«месяц Юля» — время середины зимы" },
    { norse: "Mörsugr",     translit: "Morsugr",     ru: "Морсуг",     modern: "Январь",   modernNum: 1,
      stems: ["jan", "янв", "mörs", "mors", "морс"],
      gloss: "«сосущий жир» — время жить запасами" },
    { norse: "Þorri",       translit: "Thorri",      ru: "Торри",      modern: "Февраль",  modernNum: 2,
      stems: ["feb", "фев", "þor", "thor", "торр"],
      gloss: "по имени зимнего духа Торри; месяц самых злых холодов" },
    { norse: "Gói",         translit: "Goi",         ru: "Гои",        modern: "Март",     modernNum: 3,
      stems: ["mar", "мар", "gói", "goi", "góa", "goa", "гои", "гоа"],
      gloss: "по имени Гои, дочери Торри" },
    { norse: "Einmánuðr",   translit: "Einmanudr",   ru: "Эйнмануд",   modern: "Апрель",   modernNum: 4,
      stems: ["apr", "апр", "einm", "эйн"],
      gloss: "«одинокий месяц» — последний месяц зимы" },
    { norse: "Harpa",       translit: "Harpa",       ru: "Харпа",      modern: "Май",      modernNum: 5,
      stems: ["may", "мая", "май", "harp", "харп"],
      gloss: "по имени Харпы; первый день — начало лета" },
    { norse: "Skerpla",     translit: "Skerpla",     ru: "Скерпла",    modern: "Июнь",     modernNum: 6,
      stems: ["jun", "июн", "skerp", "скерп"],
      gloss: "происхождение названия неясно" },
    { norse: "Sólmánuðr",   translit: "Solmanudr",   ru: "Сольмануд",  modern: "Июль",     modernNum: 7,
      stems: ["jul", "июл", "sólm", "solm", "сольм"],
      gloss: "«солнечный месяц» — самые длинные дни" },
    { norse: "Heyannir",    translit: "Heyannir",    ru: "Хейаннир",   modern: "Август",   modernNum: 8,
      stems: ["aug", "авг", "heyan", "хейан"],
      gloss: "«сенокосные хлопоты» — время косить и сушить сено" },
    { norse: "Tvímánuðr",   translit: "Tvimanudr",   ru: "Твимануд",   modern: "Сентябрь", modernNum: 9,
      stems: ["sep", "сен", "tvím", "tvim", "твим"],
      gloss: "«второй месяц» — второй месяц жатвы" },
    { norse: "Haustmánuðr", translit: "Haustmanudr", ru: "Хаустмануд", modern: "Октябрь",  modernNum: 10,
      stems: ["oct", "окт", "haust", "хауст"],
      gloss: "«осенний месяц» — последний месяц лета" },
];

/** Григорианский номер месяца → номер в календарном году. */
const MONTH_BY_MODERN = new Map(MONTHS.map((m, i) => [m.modernNum, i + 1]));

/**
 * Число из числовой даты («21.10.2023») — это григорианский месяц, а не номер
 * в календарном году: модель, скатившаяся на цифры, думает привычным
 * календарём.
 */
export function monthFromModernNumber(n) {
    return MONTH_BY_MODERN.get(n) ?? null;
}

/** Зима — первая половина года, лето — вторая. Ровно по шесть месяцев. */
export const WINTER_MONTHS = 6;

/**
 * Дни недели, начиная с Laugardagr.
 * Индекс совпадает с тем, что возвращает weekdayOf().
 *
 * Порядок не декоративный. Год открывается первым днём зимы — Laugardagr, —
 * и состоит из целых недель, поэтому каждая вика идёт Laugardagr → Frjádagr.
 * Считать отсюда же означает, что недельная сетка в панели совпадает с викой
 * клетка в клетку; с понедельника она разъезжалась на два дня, и подпись
 * «vika N» врала про крайние ячейки.
 *
 * Понедельник первым — норма XX века, к эпохе отношения не имеющая. Счёт же
 * от воскресенья виден в поздних именах (þriðjudagr «третий день» — вторник),
 * но это счёт христианской недели, пришедшей позже самого misseristal.
 */
export const WEEKDAYS = [
    { norse: "Laugardagr", en: "Saturday",  ru: "Суббота",      short: "Lau", desc: "«Банный день» — день омовения" },
    { norse: "Sunnudagr",  en: "Sunday",    ru: "Воскресенье",  short: "Sun", desc: "День Солнца" },
    { norse: "Mánadagr",   en: "Monday",    ru: "Понедельник",  short: "Mán", desc: "День Луны" },
    { norse: "Týsdagr",    en: "Tuesday",   ru: "Вторник",      short: "Týs", desc: "День Тюра" },
    { norse: "Óðinsdagr",  en: "Wednesday", ru: "Среда",        short: "Óðn", desc: "День Одина" },
    { norse: "Þórsdagr",   en: "Thursday",  ru: "Четверг",      short: "Þór", desc: "День Тора" },
    { norse: "Frjádagr",   en: "Friday",    ru: "Пятница",      short: "Frj", desc: "День Фригг / Фрейи" },
];

/** Первый день зимы, а значит и года, — суббота (fyrsti vetrardagr). */
export const YEAR_START_WEEKDAY = WEEKDAYS.findIndex((w) => w.en === "Saturday");

/*
 * Основы для распознавания вставных дней. Кириллица здесь обязательна:
 * промпт просит модель писать по-русски, и она пишет «2 аукнэтр 1015».
 */
export const AUK_STEMS = [
    "sumarauki", "aukn", "auk",
    "сумараук", "аукн", "аук",
];

export const EYKTIR = [
    { norse: "Miðnætti",  translit: "Midnatti", alt: null,       ru: "Миднэтти", desc: "Полночь",                dir: "С",  dirText: "Солнце строго на Севере",  start: 0,  mid: 1.5 },
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
    // а не порядковый номер в календарном году. Переводим.
    if (/^\d{1,2}$/.test(n)) {
        return MONTH_BY_MODERN.get(parseInt(n, 10)) ?? null;
    }
    for (let i = 0; i < MONTHS.length; i++) {
        if (MONTHS[i].stems.some((s) => n.startsWith(s))) return i + 1;
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
/** После какого месяца стоит вставка. Sólmánuðr — девятый месяц древнеисландского года. */
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

/*
 * Вики считаются внутри своего полугодия, а не сквозным номером по году.
 *
 * Так говорили: «в девятую неделю лета», а не «в тридцать пятую неделю года».
 * Отсчёт идёт от первого дня мисcери — зима открывается Laugardagr, лето
 * Þórsdagr (sumardagrinn fyrsti), — поэтому летние вики идут от четверга,
 * а зимние от субботы.
 *
 * Ни одно полугодие не состоит из целых недель, и иначе быть не может: зима
 * начинается субботой, лето четвергом, два разных дня. Зима — 180 дней, это
 * 25 недель и ещё 5 дней; лето — 184 (или 191 в год сумарауки), это 26 недель
 * и 2 дня. Значит последняя вика каждой половины короткая. Это не огрех
 * модели, а прямое следствие того, где стоят границы полугодий.
 */

/** Длина зимнего полугодия в днях. Аукнэтр стоят в лете, зима всегда ровна. */
const WINTER_DAYS = WINTER_MONTHS * 30;

/** Сколько дней в полугодии, которому принадлежит месяц. */
export function misseriLength(year, month) {
    return seasonOf(month).norse === "Vetr" ? WINTER_DAYS : yearLength(year) - WINTER_DAYS;
}

/** Порядковый день внутри своего полугодия, 1 … misseriLength(). */
export function dayOfMisseri(year, month, day) {
    const doy = dayOfYear(year, month, day);
    return doy <= WINTER_DAYS ? doy : doy - WINTER_DAYS;
}

/** Номер недели (vika) внутри полугодия, 1 … weeksInMisseri(). */
export function vikaOf(year, month, day) {
    return Math.ceil(dayOfMisseri(year, month, day) / 7);
}

/** Сколько вик в полугодии. Последняя из них короче семи дней. */
export function weeksInMisseri(year, month) {
    return Math.ceil(misseriLength(year, month) / 7);
}

/**
 * Первый день той вики, в которую попала дата.
 *
 * Нужен недельной сетке: полоса обязана совпадать с викой, а вика начинается
 * с первого дня полугодия, а не с фиксированного дня недели.
 */
export function vikaFirstDay(year, month, day) {
    const into = (dayOfMisseri(year, month, day) - 1) % 7;
    return addDays(year, month, day, -into);
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
 * День недели, 0 = Laugardagr.
 *
 * Все годы состоят из целых недель, поэтому достаточно отсчитать от первого
 * дня года — а он всегда Laugardagr, первый день зимы. Отсчёт с него же и
 * ведётся, так что YEAR_START_WEEKDAY здесь равен нулю; слагаемое оставлено
 * явным, чтобы порядок в таблице можно было тронуть, ничего тут не правя.
 */
export function weekdayOf(year, month, day) {
    return (dayOfYear(year, month, day) - 1 + YEAR_START_WEEKDAY) % 7;
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

/** Приводит дату к древнеисландскому календарю: в месяце ровно 30 дней, вставка короче. */
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
    for (let i = 0; i < MONTHS.length; i++) {
        for (const s of MONTHS[i].stems) {
            const p = t.indexOf(s);
            if (p !== -1 && p < bestPos) { bestPos = p; best = i + 1; }
        }
    }
    return best;
}

/** Ищет дату внутри поля date маркера. */
export function findDateInUrd(text) {
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
 * 5. URD PARSER
 * ============================================================ */

/*
 * Маркер — HTML-комментарий. Комментарий браузер не рисует, поэтому прятать
 * его регексами не нужно: он невидим сам по себе.
 *
 *   <!-- [URD:
 *   eykt: хадеги
 *   date: 13 гормануд 1015
 *   ] -->
 *
 * Внутри значений нельзя писать `-->`: браузер закроет комментарий на нём,
 * и хвост маркера станет виден в чате до того, как мы его вырежем. Промпт это
 * запрещает; сам разбор к таким значениям устойчив (проверено тестом).
 */
export const URD_MARKER_RE = /<!--\s*\[URD:([\s\S]*?)\]\s*-->/i;

/* Оборванная генерация: маркер начался, но закрыться не успел. */
const URD_MARKER_OPEN_RE = /<!--\s*\[URD:([\s\S]{10,4000})$/i;

/*
 * ── Нынешний формат: по маркеру на тему ─────────────────────────────────────
 *
 *   <!-- NRN PLACE | weather: Мокрый снег | location: старая пристань -->
 *
 * Одна строка на тему, поля через «|», внутри поля обычное «имя: значение».
 * Форма одна на все темы: выучил раз — применил везде.
 *
 * Почему не один общий блок, как было. В общем списке из двадцати строк
 * условное поле выглядит ровно так же, как обязательное, и это стоило нам
 * двух классов ошибок разом: редкие обязательные (advice, char_state)
 * выпадали, а условные (midwife, faderni) заполнялись в обычный ход. Теперь
 * у условной темы нет строки — нет и маркера, и само его отсутствие
 * и есть ответ. Это сигнал куда сильнее пропущенной строки в списке.
 *
 * Второе: у каждой темы своя мера и свой тон, и сказать их можно только рядом
 * с самой темой. В общем блоке правило «три-пять слов» читалось особенностью
 * одного поля, а не мерой, которую держат все.
 *
 * Цена признаётся честно: синтаксиса в ответе стало больше, а чем чаще он
 * мелькает, тем охотнее думающая модель выписывает его в рассуждениях. Если
 * маркеры начнут появляться в думалке — смотреть сюда первым делом.
 *
 * Наследие. Старые чаты полны блоков `<!-- [URD: … ] -->`, и разбор их
 * по-прежнему понимает: снимок состояния лежит в сообщении, но пересобрать
 * его при правке текста надо из чего-то. Новый формат читается первым,
 * старый — если нового нет.
 */
const NRN_TOPIC_RE = /<!--\s*NRN\s+([A-Z][A-Z0-9_]*)\s*\|([\s\S]*?)-->/gi;

/* Оборванный маркер темы: генерацию срезало до `-->`. Берём до конца текста. */
const NRN_TOPIC_OPEN_RE = /<!--\s*NRN\s+([A-Z][A-Z0-9_]*)\s*\|([\s\S]{0,2000})$/i;

/*
 * Темы и их поля.
 *
 * Внутри темы имена короткие — `user` вместо `user_attire`: тема уже сказала,
 * о чём речь, и повторять её в имени поля значит платить за это в каждом
 * ответе. Наружу поля уезжают под своими прежними именами, поэтому ни панель,
 * ни движок тела о темах не знают вовсе.
 */
const NRN_TOPICS = {
    TIME:   { eykt: "eykt" },
    SKIP:   { passed: "passed" },
    PLACE:  { weather: "weather", location: "location" },
    DRESS:  { user: "user_attire", char: "char_attire" },
    MIND:   { mood: "mood", thought: "thought" },
    FLESH:  { char: "char_state", user: "user_state" },
    /* COUNSEL — нынешнее имя темы; ADVICE держим как псевдоним: тема
       переименовывалась, а чаты с прежним именем остались. */
    COUNSEL: { advice: "advice" },
    ADVICE: { advice: "advice" },
    FREYJA: { desire: "desire" },
    /* Приметы: имя поля — вид приметы, и он же ключ к знаку в панели. */
    SIGNS:  { breast: "sign_breast", sleep: "sign_sleep", nausea: "sign_nausea",
              smell: "sign_smell", hunger: "sign_hunger",
              /* Внутри своей темы «нрав» зовётся так же, как её вид, — mood.
                 С настроением {{char}} он не спорит: разбор идёт по темам,
                 и одно и то же имя в MIND и в SIGNS ведёт в разные поля.
                 temper — псевдоним на случай, если модель возьмёт его сама. */
              mood: "sign_mood", temper: "sign_mood",
              ache: "sign_ache", swelling: "sign_swelling", heat: "sign_heat",
              blood: "sign_blood", belly: "sign_belly", lettari: "sign_lettari" },
    BODY:   { body: "body" },
    BED:    { sex: "sex", internal: "internal" },
    BIRTH:  { midwife: "midwife", women: "women", charms: "charms", gear: "gear" },
    KIN:    { faderni: "faderni", rank: "child_rank" },
    CHILD:  { name: "child_name" },
};

/** Поле внутри маркера темы: «имя: значение», разделитель между полями — «|». */
const NRN_FIELD_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+?)\s*$/;

/**
 * Собирает поля из всех маркеров тем в один плоский словарь.
 *
 * Плоский — намеренно: дальше он попадает в ту же раскладку полей, что и
 * старый общий блок, и вся разница между форматами кончается здесь.
 *
 * Тема, которой нет в таблице, пропускается молча. Соседние трекеры пишут
 * в чат свои комментарии, и падать на чужом маркере расширение не должно.
 */
function collectNrnFields(text) {
    const s = String(text ?? "");
    const fields = {};
    let found = false;

    const takeTopic = (topic, body) => {
        const map = NRN_TOPICS[topic.toUpperCase()];
        if (!map) return;
        found = true;
        for (const chunk of body.split("|")) {
            const kv = chunk.match(NRN_FIELD_RE);
            if (!kv) continue;
            const name = map[kv[1].toLowerCase()];
            if (name) fields[name] = kv[2].trim();
        }
    };

    NRN_TOPIC_RE.lastIndex = 0;
    let m;
    while ((m = NRN_TOPIC_RE.exec(s)) !== null) takeTopic(m[1], m[2]);

    /* Оборванный хвост разбираем только если закрытых маркеров не нашлось
       вовсе: иначе последний закрытый маркер разобрался бы дважды. */
    if (!found) {
        const open = s.match(NRN_TOPIC_OPEN_RE);
        if (open) takeTopic(open[1], open[2]);
    }

    return found ? fields : null;
}

/** Все формы маркера — для вырезания из текста сообщения. */
const URD_STRIP_RES = [
    /<!--\s*NRN\s+[A-Z][A-Z0-9_]*\s*\|[\s\S]*?-->/gi,
    /<!--\s*NRN\s+[A-Z][A-Z0-9_]*\s*\|[\s\S]*$/i,
    /<!--\s*\[URD:[\s\S]*?\]\s*-->/gi,
    /<!--\s*\[URD:[\s\S]*$/i,
];

/** Внутренности старого общего маркера, либо null. */
function extractMarker(text) {
    const s = String(text ?? "");
    return (s.match(URD_MARKER_RE) ?? s.match(URD_MARKER_OPEN_RE))?.[1] ?? null;
}

/** Есть ли в тексте наш маркер — в любой из двух форм. */
export function hasUrd(text) {
    return collectNrnFields(text) !== null || extractMarker(text) !== null;
}

/**
 * Вырезает маркер из текста сообщения.
 *
 * Убирает только дыру, оставшуюся на месте маркера: если он стоял между
 * абзацами, там повисает лишняя пустая строка. Пробелы внутри самой прозы
 * не трогаем — они не наши, и подчищать чужой текст расширение не должно.
 */
export function stripUrd(text) {
    if (!text) return text;
    let out = String(text);
    for (const re of URD_STRIP_RES) out = out.replace(re, "");
    return out.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n").trim();
}

/** Пустой результат разбора: все поля null. */
function emptyResult() {
    return {
        year: null, month: null, day: null, hour: null, minute: null,
        weather: null, location: null, userAttire: null,
        charMood: null, charAttire: null, thought: null, passed: null, body: null,
        charState: null, userState: null, advice: null, desire: null,
        midwife: null, women: null, charms: null, gear: null,
        faderni: null, childRank: null, childName: null,
        sex: null, internal: null,
        /* Приметы от сцены: вид → слова. Панель решает, какие виды сегодня
           звучат, сцена подбирает к ним слова. Пустой объект, а не null:
           отсутствие примет — обычный ход, а не отказ разбора. */
        signs: {},
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

/**
 * Дата распознана.
 *
 * Год здесь так же обязателен, как день и месяц. Раньше он в проверку не
 * входил — «день + месяц, минимум для календаря», — но минимум оказался
 * ложным: всё, что стоит за этой проверкой, тут же берёт state.year и считает
 * от него. weekdayOf(null, …) даёт NaN и валит панель на WEEKDAYS[NaN], а
 * дата без года, записанная якорем, роняла чтение чата целиком.
 *
 * Модель пишет такое, когда сбивается посреди маркера: «date: 6 сольмануд»
 * без года. Считаем, что даты в нём нет, — год у расширения и так свой,
 * перенесённый.
 */
export function hasDate(r) {
    return !!r && r.day != null && r.month != null && r.year != null;
}

/** Время распознано (точное или по названию эйкты). */
export function hasTime(r) {
    return !!r && r.hour !== null;
}

/** Есть хотя бы одно текстовое поле сцены. */
export function hasDetails(r) {
    if (!r) return false;
    return !!(r.weather || r.location || r.userAttire || r.charMood || r.charAttire || r.thought
        || r.charState || r.userState || r.advice || r.desire
        /* Одни приметы — тоже сцена: ответ, где уцелел только маркер SIGNS,
           терять незачем. */
        || Object.keys(r.signs ?? {}).length > 0);
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
 * Читает `<!-- [URD: … ] -->`, в том числе оборванный на полуслове: генерацию
 * могло срезать до закрывающих скобок, и терять из-за этого всю сцену незачем.
 *
 * Возвращает объект, даже если дата не распозналась: поля сцены (погода,
 * локация, настроение, одежда, мысль) отдаются отдельно от даты, чтобы
 * одна кривая строка `date:` не обнуляла весь инфоблок.
 *
 * @param {string} rawText Текст сообщения
 * @returns {object|null} Результат разбора или null, если маркера нет либо он пуст
 */
export function parseUrd(rawText) {
    /*
     * Новый формат читается первым, старый — если нового нет.
     *
     * Смешивать их в одном сообщении нельзя, и это не ограничение, а решение:
     * при правке текста руками в чате легко остаться с обоими, и тогда
     * непонятно, какой из них главнее. Побеждает нынешний.
     */
    const nrn = collectNrnFields(rawText);
    if (nrn) return fieldsToResult(nrn, "");

    const inner = extractMarker(rawText);
    if (inner === null) return null;

    const { fields, cleanInner } = parseFields(inner);
    return fieldsToResult(fields, cleanInner);
}

/**
 * Раскладка полей по результату — одна на оба формата.
 *
 * Здесь кончается вся разница между «маркер на тему» и старым общим блоком:
 * выше они превращаются в один плоский словарь, ниже начинается движок,
 * который о маркерах не знает ничего.
 *
 * @param {object} fields Плоский словарь `имя поля → строка`
 * @param {string} cleanInner Тело старого блока без плейсхолдеров — запасная
 *   площадка для поиска даты. У нового формата даты нет вовсе, и сюда
 *   приезжает пустая строка.
 */
function fieldsToResult(fields, cleanInner) {
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
        const found = findDateInUrd(cand);
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
    /* Тяга (fýsn) — своё желание героини, а не состояние лона. Лоно считает
       панель по дню цикла, тягу решает сцена: беременная, хворая, в горе или
       в ссоре женщина хочет иначе, чем велит счёт дней. */
    result.desire = clean(fields.desire);
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

    /*
     * Приметы от сцены. Ключ — вид приметы, тот же, которым панель зовёт знак.
     *
     * Какие виды сегодня звучат, по-прежнему решает счёт: сцена не вправе
     * завести примету, которой не время, и лишние ключи движок тела просто
     * не найдёт, куда приложить. За сценой остаются слова.
     */
    for (const [name, value] of Object.entries(fields)) {
        if (!name.startsWith("sign_")) continue;
        const text = clean(value);
        if (text) result.signs[name.slice(5).replace(/_/g, "-")] = text;
    }

    return isEmptyResult(result) ? null : result;
}
