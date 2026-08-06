/*
 * Norse Calendar — автономный тест парсинга блока <yorni>
 *
 * Запуск: node test-parse.mjs
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Lore Data .......... Константы месяцев и эйкт (копия из index.js)
 * 2. Parsing Core ....... Распознавание даты и времени (копия из index.js)
 * 3. Yorni Parser ....... Парсер блока <yorni> (копия из index.js)
 * 4. Tests .............. Тестовые кейсы и вывод результатов
 */

/* ============================================================
 * 1. LORE DATA
 * ============================================================ */

const AUK_STEMS = ["sumarauki", "aukn", "auk"];
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

function monthFromName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase().trim();
    if (AUK_STEMS.some((s) => n.startsWith(s))) return "AUK";
    if (/^\d{1,2}$/.test(n)) { const v = +n; return v >= 1 && v <= 12 ? v : null; }
    for (let i = 0; i < MONTH_STEMS.length; i++) {
        if (MONTH_STEMS[i].some((s) => n.startsWith(s))) return i + 1;
    }
    return null;
}

const EYKT_MIDS = [1.5, 4.5, 7.5, 10.5, 13.5, 16.5, 19.5, 22.5];
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

function eyktFromText(text) {
    const t = text.toLowerCase();
    let best = null, bestPos = Infinity;
    for (let i = 0; i < EYKT_ALIASES.length; i++) {
        for (const a of EYKT_ALIASES[i]) {
            const p = t.indexOf(a);
            if (p !== -1 && p < bestPos) { bestPos = p; best = i; }
        }
    }
    return best;
}

/* ============================================================
 * 2. PARSING CORE
 * ============================================================ */

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;
const MWORD = "A-Za-zÀ-ÿÞðþÁ-ž\\u0400-\\u04FF";

const DATE_PATTERNS = [
    { re: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?([${MWORD}]{2,})\\s*,?\\s*(\\d{3,4})?`, "giu"),
      map: (m) => ({ day: +m[1], month: monthFromName(m[2]), year: m[3] ? +m[3] : null, monthWord: true }) },
    { re: new RegExp(`([${MWORD}]{2,})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{3,4})?`, "giu"),
      map: (m) => ({ day: +m[2], month: monthFromName(m[1]), year: m[3] ? +m[3] : null, monthWord: true }) },
    { re: /(\d{3,4})-(\d{1,2})-(\d{1,2})/g,
      map: (m) => ({ year: +m[1], month: +m[2], day: +m[3], monthWord: false }) },
    { re: /(\d{1,2})[./](\d{1,2})[./](\d{3,4})/g,
      map: (m) => ({ day: +m[1], month: +m[2], year: +m[3], monthWord: false }) },
];

function dateScore(d) {
    if (typeof d.month === "string") return d.year !== null ? 2 : 1;
    if (d.year !== null) return 2;
    if (d.monthWord) return 1;
    return 0;
}

function isValidDate(d) {
    if (!d) return false;
    if (d.month === "AUK") { if (!d.day || d.day < 1 || d.day > 5) return false; }
    else {
        if (!d.month || d.month < 1 || d.month > 12) return false;
        if (!d.day || d.day < 1 || d.day > 31) return false;
    }
    if (d.year !== null && (isNaN(d.year) || d.year < 1 || d.year > 9999)) return false;
    return true;
}

function finalizeDate(d) { if (d.month !== "AUK" && d.day > 30) d.day = 30; return d; }

function findDateIn(text) {
    let best = null, bestScore = -1;
    for (const { re, map } of DATE_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const c = map(m);
            if (!isValidDate(c)) continue;
            const s = dateScore(c);
            if (s === 0) continue;
            if (s > bestScore) { best = c; bestScore = s; }
        }
    }
    return best ? finalizeDate(best) : null;
}

function monthFromTextLoose(text) {
    const t = text.toLowerCase();
    let best = null, bestPos = Infinity;
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
            const c = finalizeDate({ day: dayM ? +dayM[1] : null, month, year: yearM ? +yearM[1] : null });
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
 * 3. YORNI PARSER
 * ============================================================ */

const YORNI_TAG_RE = /<yorni>([\s\S]{10,800}?)<\/yorni>/i;

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
    let d = null, dateZone = "";
    for (let cand of candidates) {
        const jm = cand.match(/"output"\s*:\s*"([^"]+)"/i);
        if (jm) cand = jm[1].trim();
        if (/[<>{}]/.test(cand)) continue;
        const found = findDateInYorni(cand);
        if (found) { d = found; dateZone = cand; break; }
    }
    if (!d) return null;
    d.hour = null; d.minute = null;
    const eyktVal = fields.eykt && !/[<>{}]/.test(fields.eykt) ? fields.eykt : null;
    if (eyktVal) {
        const tm = eyktVal.match(TIME_PATTERN);
        if (tm && +tm[1] <= 24 && +tm[2] <= 59) {
            d.hour = +tm[1]; d.minute = +tm[2];
        } else {
            const idx = eyktFromText(eyktVal);
            if (idx !== null) { const mid = EYKT_MIDS[idx]; d.hour = Math.floor(mid); d.minute = Math.round((mid % 1) * 60); }
        }
    }
    if (d.hour === null) {
        const tm = dateZone.match(TIME_PATTERN);
        if (tm && +tm[1] <= 24 && +tm[2] <= 59) { d.hour = +tm[1]; d.minute = +tm[2]; }
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

/* ============================================================
 * 4. TESTS
 * ============================================================ */

console.log("=== parseYorniTag (<yorni>) ===");
const yorniCases = [
    // Полный блок из промпта (значения на русском)
    `<yorni>\neykt: Dagmál\ndate: 4 Хаустмануд 1014\nweather: Прохладный воздух, сильный северный ветер\nlocation: Деревня, Длинный дом\nmood: Весёлый, азартный, воодушевлённый\nuser_attire: Шерстяное платье, меховой плащ\nchar_attire: Волчьи шкуры, льняная рубаха\nthought: Сегодня отличный день для доброй драки!\n</yorni>`,
    // Полный блок с английскими значениями
    `<yorni>\neykt: Dagmál\ndate: 4 Haustmánuður 1014\nweather: Crisp air, strong northern wind\nlocation: Village, Great Hall\nmood: Cheerful, eager, bloodthirsty\nuser_attire: Woolen tunic, fur cloak\nchar_attire: Iron armor, battle axe\nthought: Today is a glorious day for a grand fight!\n</yorni>`,
    // Русский вариант значений + текст вокруг блока
    `<yorni>\neykt: Наттмал\ndate: 13 Гормануд 1015\nweather: Мокрый снег\nlocation: Длинный дом\nmood: Задумчивый, усталый\nuser_attire: Платье\nchar_attire: Туника\nthought: «Какой странный человек...»\n</yorni>\nТекст ответа бота...`,
    // Блок без eykt (время не обязательно)
    `<yorni>\ndate: 2 Auknætr 875\nlocation: Причал\n</yorni>`,
    // Литеральные плейсхолдеры — должен отказать
    `<yorni>\neykt: <Current Eykt>\ndate: <Day VikingMonth Year>\n</yorni>`,
    // Урезанный блок — только дата
    `<yorni>date: 12 Góa 875</yorni>`,
    // Без блока вообще
    `обычный текст`,
    // Время: [norse] - [en] - [ru] — HH:MM
    `<yorni>\neykt: Miðnætti - Midnatti - Миднатти — 12:46\ndate: 4 Хаустмануд 1014\n</yorni>`,
    // Дата: составной формат месяца через дефис
    `<yorni>\neykt: Hádegi\ndate: 14 Gormánaður - Gormanud - Гормануд — Ноябрь 875\n</yorni>`,
    // Составной формат без дня/года (только перечисление месяца)
    `<yorni>date: Gormánaður - Gormanud - Гормануд — Ноябрь</yorni>`,
    // Особые дни: Sumarauki
    `<yorni>date: 2 Sumarauki 875</yorni>`,
    // Русский формат "Дата: 21 октября 2023"
    `<yorni>date: Дата: 21 октября 2023</yorni>`,
    // Английский формат "Date: 21 October 2023"
    `<yorni>date: Date: 21 October 2023</yorni>`,
    // Числовые: ДД.ММ.ГГГГ / ДД/ММ/ГГ
    `<yorni>date: 21.10.2023</yorni>`,
    `<yorni>date: 21/10/23</yorni>`,
    // ISO
    `<yorni>date: 2023-10-21</yorni>`,
    // Эмодзи-префикс
    `<yorni>date: 📅 13/10/23</yorni>`,
    // JSON-обёртка
    `<yorni>date:{"output":"21.10.2023"}</yorni>`,
    // Дата с временем внутри строки
    `<yorni>date: 21.10.2023 18:30</yorni>`,
];
for (const c of yorniCases) {
    const r = parseYorniTag(c);
    console.log(r ? `OK  ${JSON.stringify({d:r.day,m:r.month,y:r.year,h:r.hour,mi:r.minute,loc:r.location,mo:r.charMood,th:r.thought})}  <= ${c.slice(0,50).replace(/\n/g,"\\n")}` : `-- (нет даты)  <= ${c.slice(0,50).replace(/\n/g,"\\n")}`);
}
