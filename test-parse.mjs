// Автономный тест логики парсинга Norse Calendar.
// Копирует функции из index.js и прогоняет реальные сообщения.

// --- Корни месяцев ---
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

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;
const DATE_KEYWORD_RE = /(date|дата|day|year|год|calendar|календар|tungl|эйкт|eykt|time|время)/iu;
const TIME_KEYWORD_RE = /(time|время|эйкт|eykt|час)/iu;

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

function dateZones(cleanText) {
    const kw = [], bracket = [];
    let m;
    const bracketRe = /[{\[<(][^\]>)}]{0,160}[\])>}]/g;
    while ((m = bracketRe.exec(cleanText)) !== null) {
        if (DATE_KEYWORD_RE.test(m[0])) kw.push(m[0]); else bracket.push(m[0]);
    }
    for (const line of cleanText.split(/\r?\n/)) {
        if (DATE_KEYWORD_RE.test(line)) kw.push(line);
    }
    return { kw, bracket };
}

function findDateIn(text, { allowNoYear }) {
    let best = null, bestScore = -1;
    for (const { re, map } of DATE_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const c = map(m);
            if (!isValidDate(c)) continue;
            const s = dateScore(c);
            if (s === 0) continue;
            if (!allowNoYear && s < 2) continue;
            if (s > bestScore) { best = c; bestScore = s; }
        }
    }
    return best ? finalizeDate(best) : null;
}

function attachTime(date, zone, allowEyktAliases) {
    date.hour = null; date.minute = null;
    const tm = zone.match(TIME_PATTERN);
    if (tm) { const h = +tm[1], min = +tm[2]; if (h <= 24 && min <= 59) { date.hour = h; date.minute = min; return date; } }
    if (allowEyktAliases) {
        const idx = eyktFromText(zone);
        if (idx !== null) { const mid = EYKT_MIDS[idx]; date.hour = Math.floor(mid); date.minute = Math.round((mid % 1) * 60); }
    }
    return date;
}

function parseMessage(rawText) {
    const clean = rawText.replace(/<[^>]*>/g, " ");
    const { kw, bracket } = dateZones(clean);
    for (const zone of kw) { const d = findDateIn(zone, { allowNoYear: true }); if (d) return attachTime(d, zone, true); }
    for (const zone of bracket) { const d = findDateIn(zone, { allowNoYear: true }); if (d) return attachTime(d, zone, true); }
    const d = findDateIn(clean, { allowNoYear: false });
    if (d) return attachTime(d, clean, TIME_KEYWORD_RE.test(clean));
    return null;
}

// --- Парсер блока <yorni> (копия из index.js) ---
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
    const dateStr = fields.date;
    if (!dateStr) return null;
    if (/[<>{}]/.test(dateStr)) return null;
    const d = findDateIn(dateStr, { allowNoYear: true });
    if (!d) return null;
    if (fields.eykt && !/[<>{}]/.test(fields.eykt)) {
        const idx = eyktFromText(fields.eykt);
        if (idx !== null) { const mid = EYKT_MIDS[idx]; d.hour = Math.floor(mid); d.minute = Math.round((mid % 1) * 60); }
    }
    const clean = (v) => (v && !/[<>{}]/.test(v) ? v : null);
    return {
        ...d,
        timeRaw: clean(fields.eykt),
        weather: clean(fields.weather),
        location: clean(fields.location),
        userAttire: clean(fields.user_attire),
        charMood: clean(fields.mood),
        charAttire: clean(fields.char_attire),
        thought: clean(fields.thought),
    };
}

// ============ ТЕСТЫ ============
const cases = [
    "{Наттмал | 4 Хаустмануд 1015 | За окном сыпет мокрый снег, в квартире зябко | Выборг, Хрущёвка · Гостиная | Блузка | Любопытный | Оливковая туника | Неожиданное сожительство, 1 день | \"текст\"}",
    "[Date: 12 Góa 875 | Time: Hádegi]",
    "12 марта 875",
    "875-03-12",
    "12.03.875",
    "2 Auknætr 875",
    "March 12, 875",
    "{Хадеги | 13 Гормануд 1015}",
    "просто текст без даты вообще",
    "числа 12 45 67 без месяца",
];
console.log("=== parseMessage (свободные даты) ===");
for (const c of cases) {
    const r = parseMessage(c);
    console.log(r ? `OK  ${JSON.stringify({d:r.day,m:r.month,y:r.year,h:r.hour,mi:r.minute})}  <= ${c.slice(0,40)}` : `-- (нет даты)  <= ${c.slice(0,40)}`);
}

console.log("\n=== parseYorniTag (<yorni>) ===");
const yorniCases = [
    // Полный блок, как в примере промпта
    `<yorni>\neykt: Dagmál\ndate: 4 Haustmánuður 1014\nweather: Crisp air, strong northern wind\nlocation: Village, Great Hall\nmood: Cheerful, eager, bloodthirsty\nuser_attire: Woolen tunic, fur cloak\nchar_attire: Iron armor, battle axe\nthought: Today is a glorious day for a grand fight!\n</yorni>`,
    // Русский вариант значений + текст вокруг блока
    `<yorni>\neykt: Наттмал\ndate: 13 Гормануд 1015\nweather: Мокрый снег\nlocation: Длинный дом\nmood: Задумчивый, усталый\nuser_attire: Платье\nchar_attire: Туника\nthought: «Какой странный человек...»\n</yorni>\nТекст ответа бота...`,
    // Блок без eykt (время не обязательно)
    `<yorni>\ndate: 2 Auknætr 875\nlocation: Причал\n</yorni>`,
    // Литеральные плейсхолдеры — должен отказать (это не догенерировано?)
    `<yorni>\neykt: <Current Eykt>\ndate: <Day VikingMonth Year>\n</yorni>`,
    // Урезанный блок — только дата
    `<yorni>date: 12 Góa 875</yorni>`,
    // Без блока вообще
    `обычный текст`,
];
for (const c of yorniCases) {
    const r = parseYorniTag(c);
    console.log(r ? `OK  ${JSON.stringify({d:r.day,m:r.month,y:r.year,h:r.hour,mi:r.minute,loc:r.location,mo:r.charMood,th:r.thought})}  <= ${c.slice(0,50).replace(/\n/g,"\\n")}` : `-- (нет даты)  <= ${c.slice(0,50).replace(/\n/g,"\\n")}`);
}
