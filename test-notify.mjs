/*
 * NORNIR — тест уведомлений.
 *
 * Проверяется не то, красиво ли написана строка, а два правила, на которых
 * всё держится:
 *
 *  - без прошлого слепка уведомлений нет вовсе (первый такт молчит);
 *  - об одном и том же дважды не говорится. Панель перерисовывается по
 *    десятку событий за ход, и если бы уведомление шло от самой перерисовки,
 *    а не от изменения, каждый ход приносил бы пачку одинаковых всплывашек.
 *
 * Запуск: node test-notify.mjs
 */

import {
    DEFAULT_NOTICES,
    FEAST_WARNING_DAYS,
    NOTICE_IDS,
    dateLine,
    dayLine,
    noticesBetween,
    watchSnapshot,
    weekdayName,
} from "./notify.js";

import { CYCLE_PHASES } from "./body.js";
import { MONTHS, WEEKDAYS, addDays, weekdayOf } from "./parser.js";

let passed = 0;
let failed = 0;

function ok(name, condition, extra = "") {
    if (condition) { passed++; return; }
    failed++;
    console.error(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`);
}

function eq(name, got, want) {
    ok(name, got === want, `получено: ${JSON.stringify(got)}\n      ожидалось: ${JSON.stringify(want)}`);
}

function group(name) {
    console.log(`\n— ${name}`);
}

/** Слепок дня без тела и без праздников — основа большинства проверок. */
function snap(scene, opts = {}) {
    return watchSnapshot({ scene, ...opts });
}

const ALL = NOTICE_IDS;

/* ============================================================
 * Слова
 * ============================================================ */

group("Слова");

eq("день недели одним словом", weekdayName(WEEKDAYS.findIndex((w) => w.en === "Thursday")), "День Тора");
eq("лаугардаг без длинного хвоста", weekdayName(WEEKDAYS.findIndex((w) => w.en === "Saturday")), "Банный день");
eq("дата обычного месяца", dateLine({ year: 998, month: 2, day: 7 }), "7 Юлир 998");
ok("дата вставных дней", dateLine({ year: 1000, month: "AUK", day: 2 }).startsWith("Сумарауки, 2-й из "));

{
    /* Та самая строка, ради которой всё затевалось: эйкта, дата, день, праздник. */
    const thursday = (() => {
        for (let d = 1; d <= 30; d++) {
            if (WEEKDAYS[weekdayOf(998, 2, d)].en === "Thursday") return d;
        }
        return null;
    })();
    const line = dayLine(snap({ year: 998, month: 2, day: thursday, hour: 13 }));
    eq("строка дня", line, `Хадеги · ${thursday} Юлир 998 · День Тора`);
}

eq("без часа эйкты в строке нет",
    dayLine(snap({ year: 998, month: 2, day: 7 })),
    dateLine({ year: 998, month: 2, day: 7 }) + ` · ${weekdayName(weekdayOf(998, 2, 7))}`);

/* ============================================================
 * Молчание
 * ============================================================ */

group("Молчание");

{
    const now = snap({ year: 998, month: 2, day: 7, hour: 13 });
    eq("первый такт молчит", noticesBetween(null, now, ALL).length, 0);
    eq("такт без изменений молчит", noticesBetween(now, now, ALL).length, 0);
}

{
    /* Перерисовка панели без смены суток: час тот же, эйкта та же. */
    const a = snap({ year: 998, month: 2, day: 7, hour: 13 });
    const b = snap({ year: 998, month: 2, day: 7, hour: 14 });
    eq("час внутри эйкты — не новость", noticesBetween(a, b, ALL).length, 0);
}

{
    const a = snap({ year: 998, month: 2, day: 7, hour: 13 });
    const b = snap({ year: 998, month: 2, day: 8, hour: 13 });
    eq("выключенный вид молчит", noticesBetween(a, b, []).length, 0);
}

/* ============================================================
 * День и эйкта
 * ============================================================ */

group("День и эйкта");

{
    const a = snap({ year: 998, month: 2, day: 7, hour: 13 });
    const b = snap({ year: 998, month: 2, day: 8, hour: 7 });
    const out = noticesBetween(a, b, ["day"]);
    eq("новый день — одно уведомление", out.length, 1);
    eq("в нём строка дня", out[0].text, dayLine(b));
    eq("вид тот", out[0].kind, "day");
}

{
    const a = snap({ year: 998, month: 2, day: 7, hour: 13 });
    const b = snap({ year: 998, month: 2, day: 7, hour: 19 });
    const out = noticesBetween(a, b, ["eykt"]);
    eq("смена эйкты внутри дня", out.length, 1);
    ok("названа новая эйкта", out[0].text.startsWith("Мидафтан"), out[0].text);
}

{
    /* День уже назван строкой, где эйкта стоит первым словом, — повторять
       её отдельным уведомлением незачем. */
    const a = snap({ year: 998, month: 2, day: 7, hour: 13 });
    const b = snap({ year: 998, month: 2, day: 8, hour: 19 });
    const out = noticesBetween(a, b, ["day", "eykt"]);
    eq("день и эйкта разом — только день", out.length, 1);
    eq("это день", out[0].kind, "day");
}

{
    /* Откат чата: слепок стал прежним, и это тоже «смена дня» — панель
       и правда показывает другой день. Уведомление здесь уместно. */
    const a = snap({ year: 998, month: 2, day: 8, hour: 7 });
    const b = snap({ year: 998, month: 2, day: 7, hour: 13 });
    eq("откат назад тоже виден", noticesBetween(a, b, ["day"]).length, 1);
}

/* ============================================================
 * Луна и поворот года
 * ============================================================ */

group("Луна и поворот года");

{
    /* Идём по году день за днём и считаем, сколько раз сменилась фаза.
       Пять фаз в лунном месяце, месяцев в году около двенадцати. */
    let prev = snap({ year: 1015, month: 1, day: 1, hour: 12 });
    let moons = 0;
    let seasons = 0;
    let months = 0;
    for (let i = 1; i < 360; i++) {
        const d = addDays(1015, 1, 1, i);
        const next = snap({ year: d.year, month: d.month, day: d.day, hour: 12 });
        for (const note of noticesBetween(prev, next, ["moon", "season"])) {
            if (note.kind === "moon") moons++;
            else if (note.title === "Vetr" || note.title === "Sumar") seasons++;
            else months++;
        }
        prev = next;
    }
    ok("фаз Луны за год около шестидесяти", moons >= 55 && moons <= 65, `получено ${moons}`);
    eq("полугодие поворачивает один раз за 360 дней", seasons, 1);
    ok("месяцев названо десять или одиннадцать", months >= 10 && months <= 11, `получено ${months}`);
}

{
    /* Первый день года — первый день зимы. */
    const a = snap({ year: 1014, month: 12, day: 30, hour: 12 });
    const b = snap({ year: 1015, month: 1, day: 1, hour: 12 });
    const out = noticesBetween(a, b, ["season"]);
    eq("первый день зимы назван один раз", out.length, 1);
    eq("и назван полугодием, а не месяцем", out[0].title, "Vetr");
}

{
    /* Вставные дни: у них нет ни дня недели, ни месяца из таблицы. */
    const a = snap({ year: 1015, month: 9, day: 30, hour: 12 });
    const b = snap({ year: 1015, month: "AUK", day: 1, hour: 12 });
    const out = noticesBetween(a, b, ["season"]);
    eq("вставные дни названы", out.length, 1);
    eq("своим именем", out[0].title, "Auknætr");
    eq("дня недели у них нет", b.weekday, null);
}

/* ============================================================
 * Праздники
 * ============================================================ */

group("Праздники");

const feastOpts = { holidays: true, holidayOpts: { tiers: ["attested", "probable"], region: "all" } };

{
    /* Ищем в году день, когда праздник начинается, и проверяем, что
       уведомление приходит один раз — в первый его день, а не во все три. */
    let prev = watchSnapshot({ scene: { year: 1015, month: 1, day: 1, hour: 12 }, ...feastOpts });
    const started = [];
    for (let i = 1; i < 360; i++) {
        const d = addDays(1015, 1, 1, i);
        const next = watchSnapshot({ scene: { year: d.year, month: d.month, day: d.day, hour: 12 }, ...feastOpts });
        for (const note of noticesBetween(prev, next, ["feast"])) {
            if (note.level === "success") started.push(note.title);
        }
        prev = next;
    }
    ok("праздники за год начинались", started.length > 0, `получено ${started.length}`);
    eq("и каждый по одному разу", new Set(started).size, started.length);
}

{
    /* Предупреждение — ровно один раз на праздник, при переходе порога. */
    let prev = watchSnapshot({ scene: { year: 1015, month: 1, day: 1, hour: 12 }, ...feastOpts });
    const warned = [];
    for (let i = 1; i < 360; i++) {
        const d = addDays(1015, 1, 1, i);
        const next = watchSnapshot({ scene: { year: d.year, month: d.month, day: d.day, hour: 12 }, ...feastOpts });
        for (const note of noticesBetween(prev, next, ["feast"])) {
            if (note.level !== "success") warned.push(note.title);
        }
        prev = next;
    }
    eq("о каждом празднике предупреждают один раз", new Set(warned).size, warned.length);
    ok("порог соблюдён", FEAST_WARNING_DAYS === 3);
}

{
    /* Праздники выключены в настройках — молчим о них, даже если вид включён. */
    const a = watchSnapshot({ scene: { year: 1015, month: 1, day: 1, hour: 12 } });
    const b = watchSnapshot({ scene: { year: 1015, month: 1, day: 2, hour: 12 } });
    eq("без праздников в настройках список пуст", b.feasts.length, 0);
    eq("и уведомлений нет", noticesBetween(a, b, ["feast"]).length, 0);
}

/* ============================================================
 * Утроба
 * ============================================================ */

group("Утроба");

/** Сводка тела в том виде, в каком её отдаёт bodyView. */
function view(state, title, extra = {}) {
    return { state, title, titleHint: `${title} по-русски`, status: "…", count: "12/28", ...extra };
}

{
    const tidir = CYCLE_PHASES[0];
    const opit = CYCLE_PHASES[2];
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: view("cycling", tidir.norse) });
    const b = snap({ year: 998, month: 2, day: 8, hour: 12 }, { view: view("cycling", opit.norse) });

    const out = noticesBetween(a, b, ["cycle"]);
    eq("смена фазы — одно уведомление", out.length, 1);
    eq("в заголовке имя фазы", out[0].title, opit.norse);
    ok("счёт дней в текст не идёт", !out[0].text.includes("12/28"), out[0].text);
}

{
    /* Тот же день цикла, следующие сутки: фаза не сменилась — молчим. */
    const tidir = CYCLE_PHASES[0];
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: view("cycling", tidir.norse, { count: "2/28" }) });
    const b = snap({ year: 998, month: 2, day: 8, hour: 12 }, { view: view("cycling", tidir.norse, { count: "3/28" }) });
    eq("день цикла — не новость", noticesBetween(a, b, ["cycle"]).length, 0);
}

{
    /* Ношение ведёт другой вид: «cycle» о нём молчать обязан. */
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: view("pregnant_known", "Kviðr") });
    const b = snap({ year: 998, month: 2, day: 8, hour: 12 }, { view: view("pregnant_known", "Falli", { count: "Ношение: 9/9" }) });

    eq("цикл о ношении молчит", noticesBetween(a, b, ["cycle"]).length, 0);
    const out = noticesBetween(a, b, ["body"]);
    eq("ношение — своё уведомление", out.length, 1);
    ok("со счётом срока", out[0].text.includes("Ношение: 9/9"), out[0].text);
}

{
    /* Схватки при той же стадии — новость, и метка обязана её заметить. */
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: view("pregnant_known", "Falli") });
    const b = snap({ year: 998, month: 2, day: 7, hour: 15 },
        { view: view("pregnant_known", "Falli", { labour: { days: 0, summoned: false } }) });
    eq("начало схваток замечено", noticesBetween(a, b, ["body"]).length, 1);
}

{
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: view("pregnant_known", "Kviðr") });
    const b = snap({ year: 998, month: 2, day: 8, hour: 12 }, { view: view("threat", "Hætta") });
    const out = noticesBetween(a, b, ["body"]);
    eq("угроза замечена", out.length, 1);
    eq("и подана тревогой", out[0].level, "warning");
}

{
    /* Шевеление: важна перемена, а не ежедневная строка. «Тихо два дня» и
       «тихо три дня» — одна и та же новость, сказанная дважды. */
    const carrying = (kicks) => view("pregnant_known", "Kviðr", { kicks });
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: carrying(null) });
    const b = snap({ year: 998, month: 2, day: 8, hour: 12 },
        { view: carrying({ days: 0, text: "Дитя бьётся крепко", alarm: false }) });
    const c = snap({ year: 998, month: 2, day: 10, hour: 12 },
        { view: carrying({ days: 2, text: "Дитя тихо 2 дня", alarm: true }) });
    const d = snap({ year: 998, month: 2, day: 11, hour: 12 },
        { view: carrying({ days: 3, text: "Дитя тихо 3 дня", alarm: true }) });

    eq("первое шевеление названо", noticesBetween(a, b, ["body"]).length, 1);
    const quiet = noticesBetween(b, c, ["body"]);
    eq("затишье названо", quiet.length, 1);
    eq("и подано тревогой", quiet[0].level, "warning");
    eq("но не повторяется каждый день", noticesBetween(c, d, ["body"]).length, 0);
}

{
    /* Отвар пьют и не нося дитя — новость идёт при любой главной метке. */
    const draught = { id: "bjollujurt", title: "Bjöllujurt", status: "Кровь идёт, тело ломает.", lingering: false };
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { view: view("cycling", "Tíðir") });
    const b = snap({ year: 998, month: 2, day: 7, hour: 15 }, { view: view("cycling", "Tíðir", { draught }) });
    const out = noticesBetween(a, b, ["body"]);
    eq("отвар замечен и при счёте цикла", out.length, 1);
    eq("под своим именем", out[0].title, "Bjöllujurt");
    eq("и только один раз", noticesBetween(b, b, ["body"]).length, 0);

    const after = snap({ year: 998, month: 2, day: 20, hour: 12 },
        { view: view("cycling", "Tíðir", { draught: { ...draught, lingering: true, status: "Утроба не примет семени." } }) });
    eq("перемена отката тоже названа", noticesBetween(b, after, ["body"]).length, 1);
}

/* ============================================================
 * Пропавший маркер
 * ============================================================ */

group("Пропавший маркер");

{
    const a = snap({ year: 998, month: 2, day: 7, hour: 12 }, { stale: false });
    const b = snap({ year: 998, month: 2, day: 7, hour: 12 }, { stale: true });
    const out = noticesBetween(a, b, ["marker"]);
    eq("о пропаже сказано", out.length, 1);
    eq("тревогой", out[0].level, "warning");
    eq("и только один раз", noticesBetween(b, b, ["marker"]).length, 0);
}

{
    /* Даты в чате ещё нет, а маркера в ответе не было: сказать об этом
       по-прежнему нужно — панель молчит именно поэтому. */
    const a = watchSnapshot({ scene: null, stale: false });
    const b = watchSnapshot({ scene: null, stale: true });
    eq("без даты о маркере говорим", noticesBetween(a, b, ALL).length, 1);
}

/* ============================================================
 * Настройки
 * ============================================================ */

group("Настройки");

eq("набор по умолчанию — день и цикл", DEFAULT_NOTICES.join(","), "day,cycle");
ok("все виды по умолчанию известны", DEFAULT_NOTICES.every((id) => NOTICE_IDS.includes(id)));
eq("ключи видов не повторяются", new Set(NOTICE_IDS).size, NOTICE_IDS.length);

/* ============================================================ */

console.log(`\n${failed === 0 ? "OK" : "ПРОВАЛ"}: ${passed} прошло, ${failed} провалено`);
process.exit(failed === 0 ? 0 : 1);
