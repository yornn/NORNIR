/*
 * Norse Calendar — тест праздников.
 *
 * Главное, что здесь проверяется, — то, ради чего праздники вообще привязаны
 * к дню недели, а не к числу: даты не должны плыть от года к году. Прогон
 * идёт по десяти годам подряд, среди которых есть и годы сумарауки с лишней
 * неделей: если счёт где-то поедет, поедет он именно на них.
 *
 * Запуск: node test-holidays.mjs
 */

import {
    DEFAULT_TIERS,
    HOLIDAYS,
    HOLIDAY_REGIONS,
    HOLIDAY_TIERS,
    holidayById,
    holidayDays,
    holidayEnd,
    holidayStart,
    holidayView,
    holidaysOfYear,
    holidaysOn,
    markWeek,
    nextHoliday,
} from "./holidays.js";
import {
    MONTHS_LORE,
    WEEKDAYS_LORE,
    addDays,
    isAuk,
    isSumaraukiYear,
    serialOf,
    weekdayOf,
} from "./parser.js";

let ok = 0;
let bad = 0;

function check(label, got, want) {
    const pass = String(got) === String(want);
    pass ? ok++ : bad++;
    console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(52)} → ${got}${pass ? "" : `   (ждали ${want})`}`);
}

const ALL_TIERS = HOLIDAY_TIERS.map((t) => t.id);
const everything = { tiers: ALL_TIERS, region: "all" };
const wdName = (d) => WEEKDAYS_LORE[weekdayOf(d.year, d.month, d.day)].en;
const monthName = (d) => (isAuk(d.month) ? "аукнэтр" : MONTHS_LORE[d.month - 1].norse);

/* Десять лет подряд: 1015 и 1021 — годы сумарауки, с лишней неделей. */
const YEARS = Array.from({ length: 10 }, (_, i) => 1010 + i);

console.log("=== Таблица цела ===");

check("праздников в таблице", HOLIDAYS.length, 22);
check("у всех свой ключ", new Set(HOLIDAYS.map((h) => h.id)).size, HOLIDAYS.length);
check("слой у каждого известный",
    HOLIDAYS.every((h) => ALL_TIERS.includes(h.tier)), true);
check("край света тоже",
    HOLIDAYS.every((h) => HOLIDAY_REGIONS.some((r) => r.id === h.region)), true);
check("длина у всех хотя бы день",
    HOLIDAYS.every((h) => Number.isInteger(h.days) && h.days >= 1), true);
/* Правило либо по дню недели, либо по числу — третьего не заведено. */
check("правило у каждого разобрано",
    HOLIDAYS.every((h) => (h.rule.day != null)
        || (h.rule.weekday != null && h.rule.nth != null)), true);
check("месяц у всех в пределах года",
    HOLIDAYS.every((h) => h.rule.month >= 1 && h.rule.month <= 12), true);
/* Оговорка про реконструкцию — обязательна, иначе выдумка молча сойдёт
   за свидетельство. */
check("у современных сказано, что это не эпоха",
    HOLIDAYS.filter((h) => h.tier === "modern")
        .every((h) => /XX века/.test(h.source)), true);
check("у вероятных тоже честная оговорка",
    HOLIDAYS.filter((h) => h.tier === "probable")
        .every((h) => /нет|неизвестно|не называют/.test(h.source)), true);

console.log("\n=== Дни недели держатся по годам ===");

/*
 * Ради этого всё и затевалось. Правила исторические:
 *   Зимние ночи — первая суббота гормануда
 *   Йоль        — начало торри, а торри начинается в пятницу
 *   Góublót     — первое воскресенье гои
 *   Sumarmál    — первый четверг харпы
 *   Alþingi     — последний четверг сольмануда
 *
 * Проверяем не «дата равна такому-то числу», а само правило: у начала
 * праздника обязан быть ТОТ день недели, который назван в правиле. Так тест
 * останется верным, даже если устройство года когда-нибудь тронут.
 */
const WEEKDAY_RULES = [
    ["vetrnaetr", "Saturday"],
    ["alfablot", "Saturday"],
    ["disablot", "Saturday"],
    ["disathing", "Sunday"],
    ["jol", "Friday"],
    ["thorrablot", "Friday"],
    ["goublot", "Sunday"],
    ["sigrblot", "Thursday"],
    ["althingi", "Thursday"],
];

let drift = 0;
for (const [id, want] of WEEKDAY_RULES) {
    const feast = holidayById(id);
    for (const year of YEARS) {
        const at = holidayStart(feast, year);
        if (!at || wdName(at) !== want) drift++;
    }
}
check(`начало по дню недели во всех ${YEARS.length} годах`, drift, 0);

/* И то же самое числом: в этом календаре день недели у числа один и тот же
   в любом году, поэтому и число обязано стоять на месте. Если оно поехало —
   значит тронули длину аукнэтр или начало года, и правила рассыпались. */
let moved = 0;
for (const feast of HOLIDAYS) {
    const first = holidayStart(feast, YEARS[0]);
    for (const year of YEARS) {
        const at = holidayStart(feast, year);
        if (!first || !at) continue;
        if (at.month !== first.month || at.day !== first.day) moved++;
    }
}
check("число начала не плывёт по годам", moved, 0);

/* Сумарауки — год на неделю длиннее; правило обязано пережить и это. */
const sumarauki = YEARS.filter(isSumaraukiYear);
check("годы сумарауки в прогоне есть", sumarauki.length > 0, true);
check("и в них зимние ночи всё та же суббота",
    sumarauki.every((y) => wdName(holidayStart(holidayById("vetrnaetr"), y)) === "Saturday"), true);

/* Последний четверг — правило особое, считается с хвоста месяца. */
const thing = holidayStart(holidayById("althingi"), 1015);
check("Alþingi — последний четверг сольмануда", `${thing.day}.${thing.month}`, "25.9");
check("и следующего четверга в месяце уже нет",
    addDays(thing.year, thing.month, thing.day, 7).month === thing.month, false);

console.log("\n=== Многодневные ===");

const nights = holidayById("vetrnaetr");
check("зимние ночи — трое суток", nights.days, 3);
check("и все три дня подряд",
    holidayDays(nights, 1015).map((d) => d.day).join(","), "1,2,3");

const inside = holidaysOn(1015, 1, 2, everything).find((x) => x.holiday.id === "vetrnaetr");
check("второй день опознан как второй", `${inside.day}/${inside.days}`, "2/3");
check("он не первый", inside.first, false);
check("и не последний", inside.last, false);
check("а третий — последний",
    holidaysOn(1015, 1, 3, everything).find((x) => x.holiday.id === "vetrnaetr").last, true);
check("на четвёртый праздник кончился",
    holidaysOn(1015, 1, 4, everything).some((x) => x.holiday.id === "vetrnaetr"), false);

/* Йоль — тринадцать суток от первого торри. */
const jol = holidayById("jol");
check("Йоль длится тринадцать суток", jol.days, 13);
check("последний его день", holidayEnd(jol, 1015).day, 13);
check("а ночь перед ним — последнее число морсугура",
    `${holidayStart(holidayById("hokunott"), 1015).day}.${holidayStart(holidayById("hokunott"), 1015).month}`, "30.3");

/*
 * Alþingi перешагивает через аукнэтр — четверо вставных суток посреди лета.
 * Двухнедельный тинг обязан их пережить, а не оборваться на конце месяца.
 */
const thingDays = holidayDays(holidayById("althingi"), 1015);
check("тинг идёт две недели", thingDays.length, 14);
check("и захватывает аукнэтр", thingDays.some((d) => isAuk(d.month)), true);
check("панель видит его и во вставные дни",
    holidaysOn(1015, "AUK", 1, everything).some((x) => x.holiday.id === "althingi"), true);

/* В обычный год вставных дней четверо, и тинг успевает выйти из них
   в хейаннир. В год сумарауки их одиннадцать, и все две недели тинга
   укладываются в самую середину лета — так и должно быть. */
check("в обычный год тинг кончается в хейанире",
    monthName(holidayDays(holidayById("althingi"), 1014)[13]), "Heyannir");
check("а в год сумарауки — ещё в аукнэтр",
    isAuk(thingDays[13].month), true);

console.log("\n=== Слои и края света ===");

check("по умолчанию современные выключены", DEFAULT_TIERS.includes("modern"), false);
check("и в этот день пусто",
    holidaysOn(1015, 12, 30, { tiers: DEFAULT_TIERS }).length, 0);
check("а со включённым слоем — Samhain",
    holidaysOn(1015, 12, 30, { tiers: ALL_TIERS })[0].holiday.norse, "Samhain");

check("шведский тинг в Исландии не празднуют",
    holidaysOn(1015, 5, 1, { tiers: ALL_TIERS, region: "iceland" })
        .some((x) => x.holiday.id === "disathing"), false);
check("а в Швеции празднуют",
    holidaysOn(1015, 5, 1, { tiers: ALL_TIERS, region: "sweden" })
        .some((x) => x.holiday.id === "disathing"), true);
check("общескандинавский виден отовсюду",
    holidaysOn(1015, 4, 1, { tiers: ALL_TIERS, region: "iceland" })
        .some((x) => x.holiday.id === "jol"), true);
check("исландский тинг в Швеции не идёт",
    holidaysOn(1015, 9, 25, { tiers: ALL_TIERS, region: "sweden" })
        .some((x) => x.holiday.id === "althingi"), false);

/* Христианские появляются не раньше своего года — Олав тем более. */
check("Олавова дня в 1015 году нет",
    holidayStart(holidayById("olafsmessa"), 1015), null);
check("а в 1031 он уже есть",
    `${holidayStart(holidayById("olafsmessa"), 1031).day}.${holidayStart(holidayById("olafsmessa"), 1031).month}`, "29.9");
check("Иванов день есть и в 1015", holidayStart(holidayById("jonsmessa"), 1015).day, 24);
check("а в 999 году христианских нет вовсе",
    holidaysOfYear(999, { tiers: ALL_TIERS }).some((x) => x.holiday.tier === "christian"), false);

console.log("\n=== Старшинство в один день ===");

/* В зимние ночи разом идут три обряда: общий пир, альвам и дисам. Панель
   показывает главный, прочие уходят в облачко. */
const nightsOn = holidaysOn(1015, 1, 1, everything);
check("в зимние ночи совпадают трое", nightsOn.length, 3);
check("главным стоит общий пир", nightsOn[0].holiday.norse, "Vetrnætr");

/* Сага важнее реконструкции: в первый торри стоят Йоль и Þorrablót. */
const thorriOn = holidaysOn(1015, 4, 1, everything);
check("в первый торри их двое", thorriOn.length, 2);
check("и Йоль впереди возрождённого блота", thorriOn[0].holiday.norse, "Jól");

console.log("\n=== Сводка для панели ===");

const view = holidayView(1015, 1, 2, everything);
check("панель называет праздник", view.norse, "Vetrnætr");
check("и его день вслух", view.count, "день 2 из 3");
check("прочие уходят в список", view.others.length, 2);
check("у однодневного счёта дней нет",
    holidayView(1015, 9, 15, everything).count, "null");

const empty = holidayView(1015, 2, 5, { tiers: DEFAULT_TIERS });
check("в будний день праздника нет", empty.none, true);
check("но ближайший назван", empty.next.norse, "Hǫkunótt");
check("и сказано, через сколько дней", empty.next.days, 55);

const soon = nextHoliday(1015, 12, 29, everything);
check("ближайший ищется и через край года", soon.holiday.norse, "Samhain");
check("а за ним — уже следующий год",
    nextHoliday(1015, 12, 30, everything).at.year, 1016);

console.log("\n=== Полоса недели ===");

/*
 * Панель красит ВСЕ дни праздника, а края помечает отдельно.
 *
 * Полоса взята через край года: 28–30 хаустмануда 1015 и первые дни
 * гормануда 1016, то есть ровно те трое суток зимних ночей, ради которых
 * пометка краёв и заведена.
 */
const week = Array.from({ length: 7 }, (_, i) => addDays(1015, 12, 28, i));
const paint = (opts) => markWeek(week, opts)
    .map((m) => (m ? (m.first ? "П" : m.last ? "К" : "×") : "·")).join("");

check("трое суток покрашены подряд, края помечены",
    paint({ tiers: DEFAULT_TIERS }), "···П×К·");
/* Со включённым современным слоем к ним добавляется Samhain — однодневный,
   а значит разом и первый, и последний свой день. */
check("современный слой добавляет свой день", paint(everything), "··ПП×К·");

console.log("\n" + "─".repeat(60));
console.log(`Пройдено: ${ok}   Провалено: ${bad}`);
if (bad) process.exitCode = 1;

/*
 * Отдельно — то, что просили показать глазами: календарь праздников на
 * несколько лет подряд, с днём недели у каждого. Печатается всегда: по нему
 * видно и то, что даты стоят на месте, и то, что дни недели верные.
 */
console.log("\n=== Праздники по годам (глазами) ===");
for (const year of [1014, 1015, 1016]) {
    console.log(`\n${year}${isSumaraukiYear(year) ? "  (год сумарауки, на неделю длиннее)" : ""}`);
    for (const { holiday, at } of holidaysOfYear(year, everything)) {
        const end = holidayEnd(holiday, year);
        const span = holiday.days > 1
            ? ` … ${end.day} ${monthName(end)}`
            : "";
        console.log(
            `  ${String(at.day).padStart(2)} ${monthName(at).padEnd(13)}`
            + `${wdName(at).padEnd(10)} ${holiday.norse.padEnd(20)}`
            + `${String(holiday.days).padStart(2)} дн${span}`);
    }
}
