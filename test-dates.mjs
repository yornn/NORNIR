/*
 * NORNIR — тест движка дат.
 *
 * Дату модель больше не пишет: её ставит пользователь в Tímatal, расширение
 * везёт вперёд и перелистывает по смене эйкты. Логика небольшая, но вся про
 * границы — конец месяца, аукнэтр, конец года, откат чата, — и на глаз в ней
 * ничего не видно. Отсюда отдельный файл.
 *
 * Запуск: node test-dates.mjs
 */

import { findLatestState, findSceneDate, setSceneDate, syncWholeChat } from "./chat-state.js";
import { MONTHS, aukDays, isAuk } from "./parser.js";

let ok = 0;
let bad = 0;

function check(label, got, want) {
    const pass = got === want;
    pass ? ok++ : bad++;
    console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(48)} → ${got}${pass ? "" : `   (ждали ${want})`}`);
}

/** Сообщение {{char}} с маркером: эйкта обязательна, дата — по желанию. */
let seq = 0;
function mk(eykt, dateLine = "", passed = "") {
    return {
        is_user: false,
        gen_finished: `gen-${seq++}`,
        extra: {},
        mes: [
            "проза",
            "",
            "<!-- [URD:",
            `eykt: ${eykt}`,
            dateLine,
            passed ? `passed: ${passed}` : "",
            "weather: снег",
            "location: дом",
            "mood: ок",
            "user_attire: а",
            "char_attire: б",
            "thought: в",
            "] -->",
        ].filter(Boolean).join("\n"),
    };
}

/** Дата актуального состояния чата словами. */
function dateOf(chat) {
    const s = findLatestState(chat)?.state;
    if (!s || s.year == null) return "—";
    const name = isAuk(s.month) ? "аукнэтр" : MONTHS[s.month - 1].ru.toLowerCase();
    return `${s.day} ${name} ${s.year}`;
}

/** Прогоняет чат через синхронизацию и возвращает дату последнего снимка. */
function run(...messages) {
    const chat = messages;
    syncWholeChat(chat);
    return chat;
}

console.log("=== Якорь и перенос ===");

const carried = run(mk("хадеги", "date: 5 сольмануд 1015"), mk("ундорн"));
check("дата из маркера становится якорем", dateOf(carried), "5 сольмануд 1015");
check("вперёд по эйктам — те же сутки", dateOf(carried), "5 сольмануд 1015");

carried.push(mk("моргун"));
syncWholeChat(carried);
check("эйкта откатилась — новые сутки", dateOf(carried), "6 сольмануд 1015");

carried.push(mk("наттмал"), mk("отта"));
syncWholeChat(carried);
check("наттмал → отта, ещё сутки", dateOf(carried), "7 сольмануд 1015");

console.log("\n=== Границы календаря ===");

check("хаустмануд 30 → гормануд следующего года",
    dateOf(run(mk("наттмал", "date: 30 хаустмануд 1015"), mk("отта"))), "1 гормануд 1016");
check("сольмануд 30 → аукнэтр",
    dateOf(run(mk("наттмал", "date: 30 сольмануд 1015"), mk("отта"))), "1 аукнэтр 1015");
/* Аукнэтр четыре, но в год сумарауки к ним прибавляется вставная неделя.
   Длину спрашиваем у парсера: захардкоженная четвёрка врёт каждый пятый год. */
check(`последний аукнэтр (${aukDays(1015)}-й) → хейаннир`,
    dateOf(run(mk("наттмал", `date: ${aukDays(1015)} аукнэтр 1015`), mk("отта"))), "1 хейаннир 1015");
check("аукнэтр в середине не перескакивает в хейаннир",
    dateOf(run(mk("наттмал", "date: 4 аукнэтр 1015"), mk("отта"))), "5 аукнэтр 1015");
check("конец обычного месяца",
    dateOf(run(mk("наттмал", "date: 30 торри 1015"), mk("отта"))), "1 гои 1015");

console.log("\n=== Календарик Tímatal ===");

const picked = run(mk("хадеги", "date: 5 сольмануд 1015"), mk("ундорн"), mk("наттмал"));
setSceneDate(picked, { year: 1015, month: 12, day: 28 });
check("ручная дата встаёт на последнее сообщение", dateOf(picked), "28 хаустмануд 1015");

picked.push(mk("отта"));
syncWholeChat(picked);
check("от новой даты едем дальше", dateOf(picked), "29 хаустмануд 1015");

const auk = run(mk("хадеги", "date: 5 сольмануд 1015"));
setSceneDate(auk, { year: 1015, month: "AUK", day: 2 });
check("аукнэтр ставится руками", dateOf(auk), "2 аукнэтр 1015");
syncWholeChat(auk);
check("ручная дата переживает пересборку", dateOf(auk), "2 аукнэтр 1015");

/* Новый чат: приветствие персонажа есть, снимков ещё нет. Раньше цепляться
   было не за что, и дату нельзя было выставить до первого ответа. */
const fresh = [{ is_user: false, gen_finished: "greet", extra: {}, mes: "приветствие без маркера" }];
setSceneDate(fresh, { year: 1015, month: 9, day: 5 });
fresh.push(mk("хадеги"));
syncWholeChat(fresh);
check("дата ставится до первого хода", dateOf(fresh), "5 сольмануд 1015");

/* Совсем пустого чата не бывает, но проверить дёшево. */
check("пустому чату ставить некуда", String(setSceneDate([], { year: 1015, month: 1, day: 1 })), "false");

/* Дата начала чата из метаданных — когда сообщений с якорем нет вовсе. */
const meta = run(mk("хадеги"), mk("отта"));
check("дата начала чата из метаданных",
    (() => {
        const s = findSceneDate(meta, { year: 1015, month: 4, day: 12 });
        return `${s.day} ${MONTHS[s.month - 1].ru.toLowerCase()} ${s.year}`;
    })(), "13 торри 1015");

console.log("\n=== Свайпы, откат, мусор ===");

const rolled = run(mk("хадеги", "date: 5 сольмануд 1015"), mk("наттмал"), mk("отта"), mk("наттмал"));
check("перед откатом", dateOf(rolled), "6 сольмануд 1015");
rolled.length = 2;
check("откат назад возвращает прежнюю дату", dateOf(rolled), "5 сольмануд 1015");

const noMarker = run(
    mk("хадеги", "date: 2 гормануд 1015"),
    { is_user: false, gen_finished: "plain", extra: {}, mes: "проза без маркера" },
);
check("сообщение без маркера не рвёт цепочку", dateOf(noMarker), "2 гормануд 1015");

const userTurn = run(
    mk("хадеги", "date: 2 гормануд 1015"),
    { is_user: true, mes: "реплика пользователя", extra: {} },
    mk("наттмал"),
);
check("реплика пользователя не считается за ход", dateOf(userTurn), "2 гормануд 1015");

check("без якоря даты нет", dateOf(run(mk("хадеги"), mk("отта"))), "—");
check("пустой чат", String(findLatestState([])), "null");

console.log("\n=== Таймскипы ===");

/* «Два месяца» — это шестьдесят прожитых дней, а не два названия месяца
   вперёд. Из сольмануда такой скачок попадает в хейаннир, а не в твимануд:
   между ними стоят одиннадцать аукнэтр года сумарауки. */
check("два месяца — это 60 дней, с аукнэтр по дороге",
    dateOf(run(mk("хадеги", "date: 5 сольмануд 1015"), mk("хадеги", "", "2 месяца"))), "24 хейаннир 1015");
check("неделя словами",
    dateOf(run(mk("хадеги", "date: 5 сольмануд 1015"), mk("хадеги", "", "неделя"))), "12 сольмануд 1015");
check("пара дней",
    dateOf(run(mk("хадеги", "date: 5 гормануд 1015"), mk("хадеги", "", "пара дней"))), "7 гормануд 1015");
check("скачок через границу года",
    dateOf(run(mk("хадеги", "date: 20 хаустмануд 1015"), mk("хадеги", "", "1 месяц"))), "20 гормануд 1016");

/* Скачок и перелистывание по эйкте складываться не должны: «прошло три дня»
   с точки зрения эйкт выглядит как обычное утро, и вышло бы четверо суток. */
check("скачок отменяет догадку по эйкте",
    dateOf(run(mk("наттмал", "date: 5 сольмануд 1015"), mk("отта", "", "3 дня"))), "8 сольмануд 1015");
check("полдня — это не сутки",
    dateOf(run(mk("хадеги", "date: 5 сольмануд 1015"), mk("ундорн", "", "полдня"))), "5 сольмануд 1015");
check("три с половиной месяца — это 105 дней",
    dateOf(run(mk("хадеги", "date: 1 гормануд 1015"), mk("хадеги", "", "три с половиной месяца"))), "16 торри 1015");
check("непонятная единица игнорируется",
    dateOf(run(mk("хадеги", "date: 5 сольмануд 1015"), mk("ундорн", "", "несколько часов"))), "5 сольмануд 1015");
check("скачок через аукнэтр считает вставные дни",
    dateOf(run(mk("хадеги", "date: 25 сольмануд 1015"), mk("хадеги", "", "1 месяц"))), "14 хейаннир 1015");

console.log("\n=== Перезагрузка страницы ===");

/* gen_finished живёт объектом Date, а в файле чата — строкой ISO. Пока
   отпечаток сравнивался как есть, после каждого F5 снимок считался чужим
   и стирался вместе с погодой, локацией, настроением и мыслью. */
const live = {
    is_user: false,
    gen_finished: new Date(),
    send_date: "August 9, 2026 11:54pm",
    extra: {},
    mes: [
        "проза", "", "<!-- [URD:",
        "eykt: хадеги", "date: 5 сольмануд 1015",
        "weather: мокрый снег", "location: пристань", "mood: усталый",
        "user_attire: платье", "char_attire: шкуры", "thought: хм",
        "] -->",
    ].join("\n"),
};
syncWholeChat([live]);
const reloaded = JSON.parse(JSON.stringify([live]));
syncWholeChat(reloaded);
check("снимок переживает перезагрузку", findLatestState(reloaded)?.state?.weather, "мокрый снег");
check("и дата вместе с ним", dateOf(reloaded), "5 сольмануд 1015");

console.log("\n=== Оборванная дата в маркере ===");

/* Модель сбилась посреди маркера и написала дату без года. Такая запись
   уезжала в extra якорем с year: null, и чтение чата падало целиком — вместе
   с панелью, справочником и инжектом. */
const torn = run(mk("хадеги", "date: 5 сольмануд 1015"), mk("моргун", "date: 6 сольмануд"));
check("дата без года не роняет чтение", dateOf(torn), "6 сольмануд 1015");
check("и не становится якорем", torn[1].extra.nornirDate?.anchored, false);

/* Старый чат, где битый якорь уже лежит в extra, лечится при первом чтении. */
const rotten = run(mk("хадеги", "date: 5 сольмануд 1015"), mk("моргун"));
rotten[1].extra.nornirDate = { year: null, month: 9, day: 6, anchored: true, source: "marker" };
syncWholeChat(rotten);
check("битый якорь из старого чата вычищен", dateOf(rotten), "6 сольмануд 1015");

console.log("\n" + "─".repeat(60));
console.log(`Пройдено: ${ok}   Провалено: ${bad}`);
process.exit(bad ? 1 : 0);
