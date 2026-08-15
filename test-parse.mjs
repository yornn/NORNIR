/*
 * NORNIR — автономный тест парсера и состояния в сообщениях
 *
 * Запуск: node test-parse.mjs
 * Код возврата 0 — все кейсы сошлись, 1 — есть расхождения.
 *
 * Логика НЕ дублируется: всё импортируется из parser.js — того же модуля,
 * который использует расширение.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Harness ............ Мини-раннер с подсчётом расхождений
 * 2. Urd Cases .......... Кейсы разбора маркера
 * 3. Calendar Cases ..... Проверки календарной математики
 * 3b. Marker & State .... Невидимый маркер, свайпы, удаление сообщений
 * 4. Calendar Tables .... Согласованность календарных таблиц
 * 5. Summary ............ Итог и код возврата
 */

import {
    parseUrd,
    hasUrd,
    stripUrd,
    isPlaceholder,
    serialOf,
    serialToDate,
    weekdayOf,
    addDays,
    aukDays,
    seasonOf,
    eyktForHour,
    eyktFromText,
    monthFromName,
    EYKTIR,
    MONTHS,
    MOON_PHASES,
    WEEKDAYS,
    YEAR_START_WEEKDAY,
    COMMON_YEAR_DAYS,
    AUKNAETR_DAYS,
    SUMARAUKI_DAYS,
    dayOfYear,
    vikaOf,
    vikaFirstDay,
    weeksInMisseri,
    dayOfMisseri,
    misseriLength,
    weeksInYear,
    yearLength,
    isSumaraukiYear,
} from "./parser.js";

import { syncMessage, findLatestState, syncWholeChat } from "./chat-state.js";

/* ============================================================
 * 1. HARNESS
 * ============================================================ */

let failed = 0;
let passed = 0;

function label(text, width = 52) {
    const s = String(text).replace(/\n/g, "\\n");
    return s.length > width ? s.slice(0, width - 1) + "…" : s.padEnd(width);
}

/** Сверяет только перечисленные в expected ключи результата. */
function checkUrd(input, expected, note = "") {
    const r = parseUrd(input);

    if (expected === null) {
        if (r === null) {
            passed++;
            console.log(`ok   ${label(note || input)}  → null`);
        } else {
            failed++;
            console.log(`FAIL ${label(note || input)}  → ожидался null, получено ${JSON.stringify(r)}`);
        }
        return;
    }

    if (r === null) {
        failed++;
        console.log(`FAIL ${label(note || input)}  → получен null, ожидалось ${JSON.stringify(expected)}`);
        return;
    }

    const diffs = [];
    for (const [key, want] of Object.entries(expected)) {
        if (r[key] !== want) diffs.push(`${key}: ожидалось ${JSON.stringify(want)}, получено ${JSON.stringify(r[key])}`);
    }
    if (diffs.length) {
        failed++;
        console.log(`FAIL ${label(note || input)}  → ${diffs.join("; ")}`);
    } else {
        passed++;
        console.log(`ok   ${label(note || input)}  → ${JSON.stringify(expected)}`);
    }
}

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log(`ok   ${label(name)}  → ${JSON.stringify(actual)}`);
    } else {
        failed++;
        console.log(`FAIL ${label(name)}  → ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
    }
}

/* ============================================================
 * 2. URD CASES
 * ============================================================ */

console.log("=== parseUrd: полный блок ===");

checkUrd(
    "<!-- [URD:\neykt: Dagmál\ndate: 4 Хаустмануд 1014\nweather: Прохладный воздух, сильный северный ветер\n" +
    "location: Деревня, Длинный дом\nmood: Весёлый, азартный, воодушевлённый\n" +
    "user_attire: Шерстяное платье, меховой плащ\nchar_attire: Волчьи шкуры, льняная рубаха\n" +
    "thought: Сегодня отличный день для доброй драки!\n] -->",
    {
        day: 4, month: 12, year: 1014, hour: 10, minute: 30,
        weather: "Прохладный воздух, сильный северный ветер",
        location: "Деревня, Длинный дом",
        charMood: "Весёлый, азартный, воодушевлённый",
        userAttire: "Шерстяное платье, меховой плащ",
        charAttire: "Волчьи шкуры, льняная рубаха",
        thought: "Сегодня отличный день для доброй драки!",
    },
    "полный блок, значения на русском",
);

checkUrd(
    "<!-- [URD:\neykt: Dagmál\ndate: 4 Haustmánuðr 1014\nweather: Crisp air, strong northern wind\n" +
    "location: Village, Great Hall\nmood: Cheerful, eager\nuser_attire: Woolen tunic\n" +
    "char_attire: Iron armor\nthought: A glorious day for a fight!\n] -->",
    { day: 4, month: 12, year: 1014, hour: 10, minute: 30, location: "Village, Great Hall" },
    "полный блок, значения на английском",
);

checkUrd(
    "<!-- [URD:\neykt: Наттмал\ndate: 13 Гормануд 1015\nweather: Мокрый снег\nlocation: Длинный дом\n" +
    "mood: Задумчивый, усталый\n] -->\nТекст ответа бота...",
    { day: 13, month: 1, year: 1015, hour: 22, minute: 30, weather: "Мокрый снег" },
    "блок + проза после него",
);

console.log("\n=== parseUrd: форматы даты ===");

checkUrd("<!-- [URD:\ndate: 12 Gói 875\n] -->", { day: 12, month: 5, year: 875 }, "день + месяц словом");
checkUrd("<!-- [URD:\ndate: Дата: 21 октября 2023\n] -->", { day: 21, month: 12, year: 2023 }, "русский «Дата: …»");
checkUrd("<!-- [URD:\ndate: Date: 21 October 2023\n] -->", { day: 21, month: 12, year: 2023 }, "английский «Date: …»");
checkUrd("<!-- [URD:\ndate: 21.10.2023\n] -->", { day: 21, month: 12, year: 2023 }, "ДД.ММ.ГГГГ");
checkUrd("<!-- [URD:\ndate: 21/10/23\n] -->", { day: 21, month: 12, year: 2023 }, "ДД/ММ/ГГ → 20xx");
checkUrd("<!-- [URD:\ndate: 2023-10-21\n] -->", { day: 21, month: 12, year: 2023 }, "ISO");
checkUrd("<!-- [URD:\ndate: 📅 13/10/23\n] -->", { day: 13, month: 12, year: 2023 }, "эмодзи-префикс");
checkUrd('<!-- [URD:\ndate:{"output":"21.10.2023"}\n] -->', { day: 21, month: 12, year: 2023 }, "JSON-обёртка");
checkUrd("<!-- [URD:\ndate: 21.10.2023 18:30\n] -->", { day: 21, month: 12, year: 2023, hour: 18, minute: 30 }, "дата + время в одной строке");
checkUrd(
    "<!-- [URD:\neykt: Hádegi\ndate: 14 Gormánuðr - Gormanudr - Гормануд — Ноябрь 875\n] -->",
    { day: 14, month: 1, year: 875, hour: 13, minute: 30 },
    "составной формат месяца",
);

console.log("\n=== parseUrd: Sumarauki ===");

checkUrd("<!-- [URD:\ndate: 2 Auknætr 875\nlocation: Причал\n] -->",
    { day: 2, month: "AUK", year: 875, hour: null, location: "Причал" }, "Auknætr");
checkUrd("<!-- [URD:\ndate: 2 Sumarauki 875\n] -->", { day: 2, month: "AUK", year: 875 }, "Sumarauki");
checkUrd("<!-- [URD:\ndate: 2 аукнэтр 1015\n] -->", { day: 2, month: "AUK", year: 1015 },
    "аукнэтр по-русски — так их пишет модель");
checkUrd("<!-- [URD:\ndate: 2 сумарауки 998\n] -->", { day: 2, month: "AUK", year: 998 },
    "сумарауки по-русски");
checkUrd("<!-- [URD:\ndate: 9 аукнэтр 998\n] -->", { day: 9, month: "AUK", year: 998 },
    "9-й вставной день бывает — в год сумарауки их 11");
checkUrd("<!-- [URD:\ndate: 9 аукнэтр 999\n] -->", { day: 4, month: "AUK", year: 999 },
    "в обычный год 9-й день поджимается до 4-го");
checkUrd("<!-- [URD:\ndate: 99 аукнэтр 998\n] -->", { day: 11, month: "AUK", year: 998 },
    "перебор поджимается к длине вставки — как 31-е число к 30-му");

console.log("\n=== parseUrd: время ===");

checkUrd("<!-- [URD:\neykt: Miðnætti - Midnatti - Миднэтти — 12:46\ndate: 4 Хаустмануд 1014\n] -->",
    { hour: 12, minute: 46 }, "точное HH:MM важнее названия эйкты");
checkUrd("<!-- [URD:\neykt: Хадеги\nlocation: Причал\n] -->",
    { hour: 13, minute: 30, day: null, month: null, location: "Причал" }, "эйкта без даты");

console.log("\n=== parseUrd: отбраковка мусора ===");

checkUrd("обычный текст", null, "нет блока вообще");
checkUrd("<!-- [URD:\neykt: <Current Eykt>\ndate: <Day VikingMonth Year>\n] -->", null,
    "литеральные плейсхолдеры шаблона");
checkUrd("<!-- [URD:\nmood: <{{char}}'s current mood(s)>\nweather: <Current weather>\n] -->", null,
    "плейсхолдеры с неподставленными макросами");
checkUrd("<!-- [URD:\ndate: Gormánuðr - Gormanudr - Гормануд — Ноябрь\n] -->", null,
    "месяц без дня — недостаточно для даты");

console.log("\n=== parseUrd: регрессии ===");

// B4: блок длиннее прежнего лимита в 800 символов
const longBlock =
    "<!-- [URD:\neykt: Хадеги\ndate: 13 Гормануд 1015\n" +
    "weather: " + "Тяжёлые низкие тучи, мокрый снег вперемешку с дождём, порывистый северный ветер. ".repeat(4) + "\n" +
    "location: " + "Побережье фьорда, старая пристань у длинного дома ярла, между эллингами. ".repeat(4) + "\n" +
    "mood: " + "настороженный, усталый, упрямый, готовый к драке, ".repeat(4) + "\n" +
    "user_attire: " + "Шерстяное платье с меховой оторочкой, тяжёлый плащ, кожаные башмаки. ".repeat(3) + "\n" +
    "char_attire: " + "Волчьи шкуры поверх льняной рубахи, широкий пояс, топор у бедра. ".repeat(3) + "\n" +
    "thought: " + "Она снова смотрит так, будто знает про меня больше, чем следовало бы. ".repeat(3) + "\n] -->";
console.log(`     (длина блока: ${longBlock.length} символов)`);
checkUrd(longBlock, { day: 13, month: 1, year: 1015, hour: 13, minute: 30 },
    "B4: блок >800 символов разбирается");

// B5: сцена сохраняется, даже если дата не распозналась
checkUrd(
    "<!-- [URD:\neykt: Ундорн\ndate: где-то в середине зимы\nweather: Метель\nlocation: Горный перевал\n" +
    "mood: Тревожный\nthought: Надо было идти в обход.\n] -->",
    {
        day: null, month: null, year: null, hour: 16, minute: 30,
        weather: "Метель", location: "Горный перевал",
        charMood: "Тревожный", thought: "Надо было идти в обход.",
    },
    "B5: кривая дата не обнуляет сцену",
);

// B6: знаки сравнения и фигурные скобки в обычном тексте
checkUrd(
    "<!-- [URD:\ndate: 13 Гормануд 1015\nweather: Ветер > 15 м/с, видимость < 50 шагов\nmood: {радость}\n] -->",
    { weather: "Ветер > 15 м/с, видимость < 50 шагов", charMood: "{радость}" },
    "B6: > < и {} в значениях не режутся",
);

console.log("\n=== isPlaceholder ===");

check("isPlaceholder('<Current Eykt>')", isPlaceholder("<Current Eykt>"), true);
check("isPlaceholder('<Day VikingMonth Year>')", isPlaceholder("<Day VikingMonth Year>"), true);
check("isPlaceholder(\"<{{char}}'s mood>\")", isPlaceholder("<{{char}}'s current mood(s)>"), true);
check("isPlaceholder('{{user}}')", isPlaceholder("{{user}}"), true);
check("isPlaceholder('Ветер > 15 м/с')", isPlaceholder("Ветер > 15 м/с"), false);
check("isPlaceholder('{радость}')", isPlaceholder("{радость}"), false);
check("isPlaceholder('Деревня, Длинный дом')", isPlaceholder("Деревня, Длинный дом"), false);

/* ============================================================
 * 3. CALENDAR CASES
 * ============================================================ */

console.log("\n=== Календарная математика ===");

check("serialOf(1,1,1) — начало отсчёта", serialOf(1, 1, 1), 0);
check("год начинается с Laugardagr", weekdayOf(1, 1, 1), YEAR_START_WEEKDAY);
check("Laugardagr — это суббота", WEEKDAYS[YEAR_START_WEEKDAY].en, "Saturday");

// Целые недели — то, ради чего вся конструкция
const YEARS = Array.from({ length: 40 }, (_, i) => 990 + i);
check("длина любого года делится на 7",
    YEARS.filter((y) => yearLength(y) % 7 !== 0), []);
check("обычный год — 364 дня, 52 недели",
    [yearLength(999), weeksInYear(999)], [COMMON_YEAR_DAYS, 52]);
check("год сумарауки — 371 день, 53 недели",
    [yearLength(998), weeksInYear(998)], [COMMON_YEAR_DAYS + SUMARAUKI_DAYS, 53]);
check("длина года = расстояние между началами",
    YEARS.filter((y) => serialOf(y + 1, 1, 1) - serialOf(y, 1, 1) !== yearLength(y)), []);

// Раз все годы из целых недель — все начинаются с одного дня
check("все годы начинаются с одного дня недели",
    [...new Set(YEARS.map((y) => weekdayOf(y, 1, 1)))], [YEAR_START_WEEKDAY]);

// Вставная неделя приходит раз в пять-шесть лет
const sumarauki = YEARS.filter(isSumaraukiYear);
check("шаг между годами сумарауки — 5 или 6",
    [...new Set(sumarauki.slice(1).map((y, i) => y - sumarauki[i]))].sort(), [5, 6]);
check("аукнэтр без сумарауки / с сумарауки",
    [aukDays(999), aukDays(998)], [AUKNAETR_DAYS, AUKNAETR_DAYS + SUMARAUKI_DAYS]);

/* Главная проверка достоверности: если модель верна, лето обязано начинаться
   с четверга (sumardagrinn fyrsti). Нигде не задано — должно вывестись само. */
check("лето всегда начинается с Þórsdagr",
    [...new Set(YEARS.map((y) => WEEKDAYS[weekdayOf(y, 7, 1)].en))], ["Thursday"]);
check("зима — первые шесть месяцев",
    [seasonOf(1).norse, seasonOf(6).norse, seasonOf(7).norse, seasonOf(12).norse],
    ["Vetr", "Vetr", "Sumar", "Sumar"]);
check("аукнэтр относятся к лету", seasonOf("AUK").norse, "Sumar");

// День года и номер недели
check("1 Гормануд — первый день года", dayOfYear(1015, 1, 1), 1);
check("1 Харпа — 181-й день (после шести зимних месяцев)", dayOfYear(1015, 7, 1), 181);
check("vika первого дня года", vikaOf(1015, 1, 1), 1);
check("vika седьмого дня года", vikaOf(1015, 1, 7), 1);
check("vika восьмого дня года", vikaOf(1015, 1, 8), 2);
check("последний день года — последняя вика лета",
    vikaOf(999, 12, 30), weeksInMisseri(999, 12));

/* Вики считаются внутри полугодия: лето открывает свою первую вику, а не
   продолжает зимнюю нумерацию. Это и есть «девятая неделя лета». */
check("зима кончается своей последней викой",
    vikaOf(1015, 6, 30), weeksInMisseri(1015, 6));
check("1 Харпа — первая вика лета", vikaOf(1015, 7, 1), 1);
check("лето начинается с Þórsdagr", WEEKDAYS[weekdayOf(1015, 7, 1)].norse, "Þórsdagr");
check("седьмой день лета — ещё первая вика", vikaOf(1015, 7, 7), 1);
check("восьмой день лета — уже вторая", vikaOf(1015, 7, 8), 2);
check("зима — 180 дней", misseriLength(1015, 1), 180);
check("день внутри полугодия считается от его начала",
    [dayOfMisseri(1015, 6, 30), dayOfMisseri(1015, 7, 1)], [180, 1]);

/* Ни одно полугодие не кратно семи, и не может быть: зима открывается
   субботой, лето четвергом. Значит последняя вика каждой половины короче. */
for (const [y, m] of [[1015, 1], [1015, 7], [999, 1], [999, 7]]) {
    const half = seasonOf(m).norse;
    check(`${half} ${y}: последняя вика короче семи дней`,
        misseriLength(y, m) % 7 !== 0, true);
}

// Аукнэтр вставлены после Sólmánuðr и попадают в счёт дней
check("аукнэтр идут сразу за 9-м месяцем",
    dayOfYear(1015, "AUK", 1) - dayOfYear(1015, 9, 30), 1);
check("10-й месяц начинается после аукнэтр",
    dayOfYear(1015, 10, 1) - dayOfYear(1015, "AUK", aukDays(1015)), 1);

// Обратимость по всем дням нескольких лет
const roundTripErrors = [];
for (const y of [997, 998, 999, 1000, 1001]) {
    for (let doy = 1; doy <= yearLength(y); doy++) {
        const d = serialToDate(serialOf(y, 1, 1) + doy - 1);
        if (d.year !== y || dayOfYear(d.year, d.month, d.day) !== doy) roundTripErrors.push(`${y}:${doy}`);
    }
}
check("все дни 997-1001 сходятся туда-обратно", roundTripErrors, []);

check("addDays через границу месяца", addDays(1015, 1, 30, 1), { year: 1015, month: 2, day: 1 });
check("addDays назад через границу года", addDays(1015, 1, 1, -1), { year: 1014, month: 12, day: 30 });
check("eyktForHour(0/10/13/23)", [0, 10, 13, 23].map(eyktForHour), [0, 3, 4, 7]);

/* ============================================================
 * 3b. MARKER & CHAT STATE
 * ============================================================ */

console.log("\n=== Невидимый маркер ===");

const MARKER = [
    "<!-- [URD:",
    "eykt: хадеги",
    "date: 13 гормануд 1015",
    "weather: Мокрый снег",
    "location: Старая пристань",
    "] -->",
].join("\n");

const REPLY = `Хальвдан опустил точильный камень.\n\n${MARKER}`;

checkUrd(REPLY, { day: 13, month: 1, year: 1015, hour: 13, minute: 30, weather: "Мокрый снег" },
    "маркер-комментарий в конце ответа");
check("hasUrd находит маркер", hasUrd(REPLY), true);
check("stripUrd оставляет прозу", stripUrd(REPLY), "Хальвдан опустил точильный камень.");
check("stripUrd идемпотентен",
    stripUrd(stripUrd(REPLY)), "Хальвдан опустил точильный камень.");
check("в чистом тексте маркера нет", hasUrd("Просто проза."), false);

// Оборванная генерация: маркер начался, но не закрылся
const CUT = "Проза.\n<!-- [URD:\neykt: моргун\ndate: 2 харпа 1016";
checkUrd(CUT, { day: 2, month: 7, year: 1016, hour: 7, minute: 30 }, "обрыв без закрывающего -->");
check("обрыв тоже вырезается", stripUrd(CUT), "Проза.");

// Прежний видимый блок больше не формат: маркер только комментарием.
const OLD_VISIBLE = "<urd>\neykt: отта\ndate: 4 хаустмануд 1014\n</urd>\nТекст ответа.";
checkUrd(OLD_VISIBLE, null, "видимый блок маркером не считается");
check("видимый блок не вырезается", stripUrd(OLD_VISIBLE), OLD_VISIBLE);

// Дефисы внутри значения: HTML5-парсеры терпят одиночное `--`, а `-->` закрывает
// комментарий досрочно — в чате виден хвост. Наш разбор устойчив к обоим.
const DASHES = [
    "Проза.",
    "<!-- [URD:",
    "weather: ветер -- шквалистый",
    "date: 13 гормануд 1015",
    "] -->",
].join("\n");
const CLOSER = [
    "Проза.",
    "<!-- [URD:",
    "weather: ветер --> шквалистый",
    "date: 13 гормануд 1015",
    "] -->",
].join("\n");
check("`--` внутри значения не мешает разбору", parseUrd(DASHES)?.day, 13);
check("`-->` внутри значения не мешает разбору", parseUrd(CLOSER)?.day, 13);
check("`-->` внутри значения не мешает вырезанию", stripUrd(CLOSER), "Проза.");

console.log("\n=== Состояние в сообщениях: свайпы и удаление ===");

/* Мини-модель SillyTavern: extra живёт на свайп, gen_finished метит генерацию. */
function makeMsg(text, stamp) {
    return {
        is_user: false, mes: text, gen_finished: stamp, extra: {},
        swipes: [text], swipe_id: 0, swipe_info: [{ extra: {}, gen_finished: stamp }],
    };
}

function markerWith(weather, stamp) {
    return `Проза ${stamp}.\n\n<!-- [URD:\neykt: хадеги\ndate: 13 гормануд 1015\nweather: ${weather}\n] -->`;
}

/** Уход с текущего свайпа: ST сохраняет его extra (syncMesToSwipe). */
function saveSwipe(msg) {
    msg.swipe_info[msg.swipe_id] = {
        extra: structuredClone(msg.extra),
        gen_finished: msg.gen_finished,
    };
    msg.swipes[msg.swipe_id] = msg.mes;
}

/** Новая генерация: ST клонирует extra в новый свайп — здесь и рождается залипание. */
function addSwipe(msg, text, stamp) {
    saveSwipe(msg);
    msg.swipes.push(text);
    msg.swipe_id = msg.swipes.length - 1;
    msg.swipe_info[msg.swipe_id] = { extra: structuredClone(msg.extra), gen_finished: stamp };
    msg.mes = text;
    msg.gen_finished = stamp;
}

/** Переключение на существующий свайп (syncSwipeToMes). */
function selectSwipe(msg, id) {
    saveSwipe(msg);
    msg.swipe_id = id;
    msg.mes = msg.swipes[id];
    msg.extra = structuredClone(msg.swipe_info[id].extra) ?? {};
    msg.gen_finished = msg.swipe_info[id].gen_finished;
}

const m = makeMsg(markerWith("Метель", "t1"), "t1");
syncMessage(m);
check("снимок попал в extra", m.extra.nornirState?.weather, "Метель");
check("маркер вырезан из текста", m.mes, "Проза t1.");
check("маркер вырезан и из копии свайпа", m.swipes[0], "Проза t1.");

addSwipe(m, markerWith("Ясно, морозно", "t2"), "t2");
syncMessage(m);
check("второй свайп — своя погода", m.extra.nornirState?.weather, "Ясно, морозно");

// Модель забыла маркер: чужой снимок висеть не должен
addSwipe(m, "Проза t3 без маркера.", "t3");
syncMessage(m);
check("свайп без маркера не наследует чужой снимок", m.extra.nornirState ?? null, null);

selectSwipe(m, 0);
syncMessage(m);
check("возврат на первый свайп возвращает его погоду", m.extra.nornirState?.weather, "Метель");

selectSwipe(m, 1);
syncMessage(m);
check("возврат на второй свайп возвращает его погоду", m.extra.nornirState?.weather, "Ясно, морозно");

// Правка прозы руками не должна уносить календарь: gen_finished не меняется
m.mes = "Отредактированная проза.";
syncMessage(m);
check("правка прозы сохраняет снимок", m.extra.nornirState?.weather, "Ясно, морозно");

const chat = [
    { is_user: true, mes: "Реплика." },
    makeMsg(markerWith("Метель", "a"), "a"),
    { is_user: true, mes: "Реплика." },
    makeMsg(markerWith("Знойное марево", "b"), "b"),
];
syncWholeChat(chat);
check("findLatestState берёт последнее сообщение", findLatestState(chat)?.state.weather, "Знойное марево");
chat.pop();
check("после удаления берётся предыдущее", findLatestState(chat)?.state.weather, "Метель");
check("пустой чат — null", findLatestState([]), null);

/* ============================================================
 * 4. CALENDAR TABLES
 *
 * Таблицы Tímatal и словари распознавания должны описывать одно и то же.
 * Эти проверки ловят рассинхрон при правке таблиц.
 * ============================================================ */

console.log("\n=== Календарные таблицы ===");

check("месяцев ровно 12", MONTHS.length, 12);
check("дней недели ровно 7", WEEKDAYS.length, 7);
check("эйкт ровно 8", EYKTIR.length, 8);
check("фаз Луны ровно 5", MOON_PHASES.length, 5);

check("год открывает Гормануд", MONTHS[0].ru, "Гормануд");
check("Гормануд — это ноябрь", MONTHS[0].modern, "Ноябрь");
check("неделю открывает Laugardagr", WEEKDAYS[0].norse, "Laugardagr");
check("Laugardagr — это суббота", WEEKDAYS[0].ru, "Суббота");
check("дни недели идут с Laugardagr", WEEKDAYS.map((w) => w.short),
    ["Lau", "Sun", "Mán", "Týs", "Óðn", "Þór", "Frj"]);

/* Полоса недельной сетки обязана начинаться с первого дня вики, иначе подпись
   «vika N» врёт про крайние клетки. Сетка строится как
   addDays(vikaFirstDay(сегодня), i), i = 0…6 — повторяем здесь. */
for (const [y, m, d] of [[1015, 1, 13], [1015, 7, 1], [998, 12, 30], [1016, 1, 1],
                         [1015, 6, 30], [1015, 7, 3]]) {
    const first = vikaFirstDay(y, m, d);
    const strip = Array.from({ length: 7 },
        (_, i) => addDays(first.year, first.month, first.day, i));
    const vika = vikaOf(y, m, d);

    check(`${d}.${m}.${y}: полоса открывается первым днём вики`,
        [vikaOf(first.year, first.month, first.day), dayOfMisseri(first.year, first.month, first.day) % 7],
        [vika, 1 % 7]);

    /* Дни своей вики идут подряд от начала полосы, а хвост уже за краем
       полугодия — его виджет гасит. */
    const own = strip.filter((s) => seasonOf(s.month).norse === seasonOf(m).norse
        && vikaOf(s.year, s.month, s.day) === vika);
    const expected = Math.min(7, misseriLength(y, m) - (vika - 1) * 7);
    check(`${d}.${m}.${y}: в вике ${expected} дн.`, own.length, expected);
    check(`${d}.${m}.${y}: они стоят подряд с начала`,
        strip.slice(0, own.length).every((s) => own.includes(s)), true);
}
check("зимняя вика начинается с Laugardagr",
    WEEKDAYS[weekdayOf(1, 1, 1)].norse, "Laugardagr");

// Каждое написание месяца из справочника должно распознаваться парсером
const badMonths = [];
MONTHS.forEach((m, i) => {
    for (const [field, value] of Object.entries({ norse: m.norse, translit: m.translit, ru: m.ru, modern: m.modern })) {
        if (monthFromName(value) !== i + 1) badMonths.push(`${value} (${field}) → ${monthFromName(value)}, ожидалось ${i + 1}`);
    }
});
check("все 48 написаний месяцев распознаются", badMonths, []);

// То же для эйкт
const badEyktir = [];
EYKTIR.forEach((e, i) => {
    for (const [field, value] of Object.entries({ norse: e.norse, translit: e.translit, ru: e.ru })) {
        if (eyktFromText(value) !== i) badEyktir.push(`${value} (${field}) → ${eyktFromText(value)}, ожидалось ${i}`);
    }
});
check("все 24 написания эйкт распознаются", badEyktir, []);

check("эйкты покрывают сутки без дыр", EYKTIR.map((e) => e.start), [0, 3, 6, 9, 12, 15, 18, 21]);
check("середина эйкты внутри её интервала",
    EYKTIR.every((e) => e.mid > e.start && e.mid < e.start + 3), true);
check("фазы Луны покрывают цикл без дыр",
    MOON_PHASES.every((p, i) => i === 0 ? p.from === 0 : p.from === MOON_PHASES[i - 1].to), true);
check("последняя фаза Луны замыкает цикл", MOON_PHASES.at(-1).to, 29.53);

/* ============================================================
 * 5. SUMMARY
 * ============================================================ */

console.log(`\n${"─".repeat(60)}`);
console.log(`Пройдено: ${passed}   Провалено: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
