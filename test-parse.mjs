/*
 * Norse Calendar — автономный тест парсинга блока <yorni>
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
 * 2. Yorni Cases ........ Кейсы разбора блока <yorni>
 * 3. Calendar Cases ..... Проверки календарной математики
 * 4. Summary ............ Итог и код возврата
 */

import {
    parseYorniTag,
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
    MONTHS_LORE,
    MONTHS_NORSE_RU,
    MONTHS_RU_NOM,
    MOON_PHASES,
    WEEKDAYS_LORE,
    WEEKDAYS_SHORT_NORSE,
    WEEKDAYS_FULL_RU,
    WEEKDAY_DESC_RU,
} from "./parser.js";

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
function checkYorni(input, expected, note = "") {
    const r = parseYorniTag(input);

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
 * 2. YORNI CASES
 * ============================================================ */

console.log("=== parseYorniTag: полный блок ===");

checkYorni(
    "<yorni>\neykt: Dagmál\ndate: 4 Хаустмануд 1014\nweather: Прохладный воздух, сильный северный ветер\n" +
    "location: Деревня, Длинный дом\nmood: Весёлый, азартный, воодушевлённый\n" +
    "user_attire: Шерстяное платье, меховой плащ\nchar_attire: Волчьи шкуры, льняная рубаха\n" +
    "thought: Сегодня отличный день для доброй драки!\n</yorni>",
    {
        day: 4, month: 10, year: 1014, hour: 10, minute: 30,
        weather: "Прохладный воздух, сильный северный ветер",
        location: "Деревня, Длинный дом",
        charMood: "Весёлый, азартный, воодушевлённый",
        userAttire: "Шерстяное платье, меховой плащ",
        charAttire: "Волчьи шкуры, льняная рубаха",
        thought: "Сегодня отличный день для доброй драки!",
    },
    "полный блок, значения на русском",
);

checkYorni(
    "<yorni>\neykt: Dagmál\ndate: 4 Haustmánuður 1014\nweather: Crisp air, strong northern wind\n" +
    "location: Village, Great Hall\nmood: Cheerful, eager\nuser_attire: Woolen tunic\n" +
    "char_attire: Iron armor\nthought: A glorious day for a fight!\n</yorni>",
    { day: 4, month: 10, year: 1014, hour: 10, minute: 30, location: "Village, Great Hall" },
    "полный блок, значения на английском",
);

checkYorni(
    "<yorni>\neykt: Наттмал\ndate: 13 Гормануд 1015\nweather: Мокрый снег\nlocation: Длинный дом\n" +
    "mood: Задумчивый, усталый\n</yorni>\nТекст ответа бота...",
    { day: 13, month: 11, year: 1015, hour: 22, minute: 30, weather: "Мокрый снег" },
    "блок + проза после него",
);

console.log("\n=== parseYorniTag: форматы даты ===");

checkYorni("<yorni>date: 12 Góa 875</yorni>", { day: 12, month: 3, year: 875 }, "день + месяц словом");
checkYorni("<yorni>date: Дата: 21 октября 2023</yorni>", { day: 21, month: 10, year: 2023 }, "русский «Дата: …»");
checkYorni("<yorni>date: Date: 21 October 2023</yorni>", { day: 21, month: 10, year: 2023 }, "английский «Date: …»");
checkYorni("<yorni>date: 21.10.2023</yorni>", { day: 21, month: 10, year: 2023 }, "ДД.ММ.ГГГГ");
checkYorni("<yorni>date: 21/10/23</yorni>", { day: 21, month: 10, year: 2023 }, "ДД/ММ/ГГ → 20xx");
checkYorni("<yorni>date: 2023-10-21</yorni>", { day: 21, month: 10, year: 2023 }, "ISO");
checkYorni("<yorni>date: 📅 13/10/23</yorni>", { day: 13, month: 10, year: 2023 }, "эмодзи-префикс");
checkYorni('<yorni>date:{"output":"21.10.2023"}</yorni>', { day: 21, month: 10, year: 2023 }, "JSON-обёртка");
checkYorni("<yorni>date: 21.10.2023 18:30</yorni>", { day: 21, month: 10, year: 2023, hour: 18, minute: 30 }, "дата + время в одной строке");
checkYorni(
    "<yorni>\neykt: Hádegi\ndate: 14 Gormánaður - Gormanud - Гормануд — Ноябрь 875\n</yorni>",
    { day: 14, month: 11, year: 875, hour: 13, minute: 30 },
    "составной формат месяца",
);

console.log("\n=== parseYorniTag: Sumarauki ===");

checkYorni("<yorni>\ndate: 2 Auknætr 875\nlocation: Причал\n</yorni>",
    { day: 2, month: "AUK", year: 875, hour: null, location: "Причал" }, "Auknætr");
checkYorni("<yorni>date: 2 Sumarauki 875</yorni>", { day: 2, month: "AUK", year: 875 }, "Sumarauki");

console.log("\n=== parseYorniTag: время ===");

checkYorni("<yorni>\neykt: Miðnætti - Midnatti - Миднатти — 12:46\ndate: 4 Хаустмануд 1014\n</yorni>",
    { hour: 12, minute: 46 }, "точное HH:MM важнее названия эйкты");
checkYorni("<yorni>\neykt: Хадеги\nlocation: Причал\n</yorni>",
    { hour: 13, minute: 30, day: null, month: null, location: "Причал" }, "эйкта без даты");

console.log("\n=== parseYorniTag: отбраковка мусора ===");

checkYorni("обычный текст", null, "нет блока вообще");
checkYorni("<yorni>\neykt: <Current Eykt>\ndate: <Day VikingMonth Year>\n</yorni>", null,
    "литеральные плейсхолдеры шаблона");
checkYorni("<yorni>\nmood: <{{char}}'s current mood(s)>\nweather: <Current weather>\n</yorni>", null,
    "плейсхолдеры с неподставленными макросами");
checkYorni("<yorni>date: Gormánaður - Gormanud - Гормануд — Ноябрь</yorni>", null,
    "месяц без дня — недостаточно для даты");

console.log("\n=== parseYorniTag: регрессии ===");

// B4: блок длиннее прежнего лимита в 800 символов
const longBlock =
    "<yorni>\neykt: Хадеги\ndate: 13 Гормануд 1015\n" +
    "weather: " + "Тяжёлые низкие тучи, мокрый снег вперемешку с дождём, порывистый северный ветер. ".repeat(4) + "\n" +
    "location: " + "Побережье фьорда, старая пристань у длинного дома ярла, между эллингами. ".repeat(4) + "\n" +
    "mood: " + "настороженный, усталый, упрямый, готовый к драке, ".repeat(4) + "\n" +
    "user_attire: " + "Шерстяное платье с меховой оторочкой, тяжёлый плащ, кожаные башмаки. ".repeat(3) + "\n" +
    "char_attire: " + "Волчьи шкуры поверх льняной рубахи, широкий пояс, топор у бедра. ".repeat(3) + "\n" +
    "thought: " + "Она снова смотрит так, будто знает про меня больше, чем следовало бы. ".repeat(3) + "\n</yorni>";
console.log(`     (длина блока: ${longBlock.length} символов)`);
checkYorni(longBlock, { day: 13, month: 11, year: 1015, hour: 13, minute: 30 },
    "B4: блок >800 символов разбирается");

// B5: сцена сохраняется, даже если дата не распозналась
checkYorni(
    "<yorni>\neykt: Ундорн\ndate: где-то в середине зимы\nweather: Метель\nlocation: Горный перевал\n" +
    "mood: Тревожный\nthought: Надо было идти в обход.\n</yorni>",
    {
        day: null, month: null, year: null, hour: 16, minute: 30,
        weather: "Метель", location: "Горный перевал",
        charMood: "Тревожный", thought: "Надо было идти в обход.",
    },
    "B5: кривая дата не обнуляет сцену",
);

// B6: знаки сравнения и фигурные скобки в обычном тексте
checkYorni(
    "<yorni>\ndate: 13 Гормануд 1015\nweather: Ветер > 15 м/с, видимость < 50 шагов\nmood: {радость}\n</yorni>",
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

check("1 Морсугур года 1 — понедельник", weekdayOf(1, 1, 1), 1);
check("serialOf(1,1,1)", serialOf(1, 1, 1), 0);
check("Sumarauki идёт после 7-го месяца", serialOf(875, "AUK", 1) - serialOf(875, 7, 30), 1);
check("длина обычного года", serialOf(1002, 1, 1) - serialOf(1001, 1, 1), 364);
check("длина високосного года", serialOf(1005, 1, 1) - serialOf(1004, 1, 1), 365);
check("aukDays(1015) / aukDays(1016)", [aukDays(1015), aukDays(1016)], [4, 5]);
check("serialToDate обратим", serialToDate(serialOf(1015, 11, 13)), { year: 1015, month: 11, day: 13 });
check("serialToDate обратим для AUK", serialToDate(serialOf(1016, "AUK", 5)), { year: 1016, month: "AUK", day: 5 });
check("addDays через границу месяца", addDays(1015, 11, 30, 1), { year: 1015, month: 12, day: 1 });
check("addDays назад через границу года", addDays(1015, 1, 1, -1), { year: 1014, month: 12, day: 30 });
check("сезон Гормануда (11) — Vetr", seasonOf(11).norse, "Vetr");
check("сезон Хаустмануда (10) — Sumar", seasonOf(10).norse, "Sumar");
check("сезон Sumarauki — Sumar", seasonOf("AUK").norse, "Sumar");
check("eyktForHour(0/10/13/23)", [0, 10, 13, 23].map(eyktForHour), [0, 3, 4, 7]);

/* ============================================================
 * 4. LORE TABLES
 *
 * Таблицы Tímatal и словари распознавания должны описывать одно и то же.
 * Эти проверки ловят рассинхрон при правке лора.
 * ============================================================ */

console.log("\n=== Лорные таблицы ===");

check("месяцев ровно 12", MONTHS_LORE.length, 12);
check("дней недели ровно 7", WEEKDAYS_LORE.length, 7);
check("эйкт ровно 8", EYKTIR.length, 8);
check("фаз Луны ровно 5", MOON_PHASES.length, 5);

check("MONTHS_NORSE_RU выведен из MONTHS_LORE", MONTHS_NORSE_RU[10], "Гормануд");
check("MONTHS_RU_NOM выведен из MONTHS_LORE", MONTHS_RU_NOM[10], "Ноябрь");
check("WEEKDAYS_FULL_RU[0] — воскресенье", WEEKDAYS_FULL_RU[0], "Воскресенье");
check("WEEKDAY_DESC_RU[0] — День Солнца", WEEKDAY_DESC_RU[0], "День Солнца");
check("шапка сетки начинается с понедельника", WEEKDAYS_SHORT_NORSE, ["Mán", "Týs", "Óðn", "Þór", "Frj", "Lau", "Sun"]);

// Каждое написание месяца из справочника должно распознаваться парсером
const badMonths = [];
MONTHS_LORE.forEach((m, i) => {
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
