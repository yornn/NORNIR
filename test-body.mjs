/*
 * NORNIR — тест женского цикла и срока ношения.
 *
 * Считается всё вычитанием дат, поэтому проверяем границы фаз, оборот цикла
 * через конец месяца и аукнэтр, стадии срока, строку для модели и ручные
 * записи из Tímatal. Отдельно — что старые маркеры тела в чате больше ничего
 * не двигают: счёт ведёт рука автора и календарь.
 *
 * Запуск: node test-body.mjs
 */

import {
    CYCLE_DEFAULT,
    CYCLE_PHASES,
    OBVIOUS_DAY,
    TERM_DAYS,
    bodyView,
    cycleDay,
    cycleSummary,
    dueWords,
    normalizeCycleLength,
    phaseOf,
    pregnancySummary,
    pregnancyTerm,
} from "./body.js";
import { cycleAnchor, findBodyState, pregnancyAnchor, readChat, syncWholeChat } from "./chat-state.js";
import { addDays, serialOf } from "./parser.js";
import { readFileSync } from "node:fs";

let ok = 0;
let bad = 0;

function check(label, got, want) {
    const pass = String(got) === String(want);
    pass ? ok++ : bad++;
    console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(46)} → ${got}${pass ? "" : `   (ждали ${want})`}`);
}

/** Ответ модели в нынешнем формате: эйкта, при надобности дата и лишние строки. */
let seq = 0;
function mk(eykt, extra = []) {
    return {
        is_user: false,
        gen_finished: `gen-${seq++}`,
        extra: {},
        mes: [
            "проза", "",
            `<!-- NRN TIME | eykt: ${eykt} -->`,
            "<!-- NRN PLACE | weather: снег | location: дом -->",
            ...extra,
        ].join("\n"),
    };
}

/** Тот же ответ старым общим блоком — у него дата прямо в маркере. */
function mkDated(eykt, dateLine, body = "") {
    return {
        is_user: false,
        gen_finished: `gen-${seq++}`,
        extra: {},
        mes: [
            "проза", "", "<!-- [URD:",
            `eykt: ${eykt}`,
            dateLine,
            body ? `body: ${body}` : "",
            "weather: снег", "location: дом",
            "] -->",
        ].filter(Boolean).join("\n"),
    };
}

const day = (d, month = 9, year = 1015) => ({ year, month, day: d });

/* ============================================================
 * 1. ЦИКЛ
 * ============================================================ */

console.log("=== Цикл ===");

const bleed = day(1);
check("первый день — день крови", cycleDay(bleed, day(1)), 1);
check("пятый — ещё кровь", phaseOf(cycleDay(bleed, day(5))).id, "tidir");
check("шестой — очищение", phaseOf(cycleDay(bleed, day(6))).id, "hreinsun");
check("одиннадцатый — ещё очищение", phaseOf(11).id, "hreinsun");
check("двенадцатый — открытые дни", phaseOf(12).id, "opit");
check("шестнадцатый — ещё открытые", phaseOf(16).id, "opit");
check("семнадцатый — тяжелеющее лоно", phaseOf(17).id, "thverrandi");
check("двадцать восьмой — оно же", phaseOf(28).id, "thverrandi");

/* Месяц тридцатидневный, цикл двадцативосьмидневный: на тридцатый день
   счёт уже на третьем дне нового круга. */
check("круг замыкается через конец месяца", cycleDay(bleed, day(30)), 2);
check("и через десять кругов", cycleDay(bleed, addDays(1015, 9, 1, 280)), 1);
/* Аукнэтр стоят между сольманудом и хейанниром — те же дни в счёте. */
check("аукнэтр считаются днями цикла",
    cycleDay(bleed, addDays(1015, 9, 1, 31)), (31 % CYCLE_DEFAULT) + 1);
check("до первой крови счёта нет", String(cycleDay(day(10), day(5))), "null");

check("длина по умолчанию — 28", normalizeCycleLength(undefined), 28);
check("короче двадцати не бывает", normalizeCycleLength(10), 20);
check("длиннее сорока не бывает", normalizeCycleLength(99), 40);
check("фаз четыре", CYCLE_PHASES.length, 4);

/* ============================================================
 * 2. ВИД ЦИКЛА И СТРОКА ДЛЯ МОДЕЛИ
 * ============================================================ */

console.log("\n=== Вид цикла ===");

const onDay = (n) => bodyView({ lastBleed: bleed }, addDays(1015, 9, 1, n - 1));

check("счёт дней в заголовке", onDay(3).count, "3/28");
check("имя фазы — заголовок", onDay(3).title, "Tíðir");
check("статус — слова фазы", onDay(3).status, "Кровь идёт.");
check("значок по фазе", onDay(13).icon, "phase-opit");
check("у цикла нет второй строки", String(onDay(13).extra), "null");

/* Модели о теле говорится только то, о чём сцена может вспомнить к слову:
   идёт кровь. В прочие дни круга строки нет вовсе. */
check("в дни крови модель знает о крови", onDay(1).phrase, "У {{user}} сейчас тидир — идёт месячная кровь.");
check("и на пятый день тоже", !!onDay(5).phrase, true);
check("на шестой — молчание", String(onDay(6).phrase), "null");
check("в открытые дни — молчание", String(onDay(14).phrase), "null");
check("перед кровью — молчание", String(onDay(27).phrase), "null");

/* ============================================================
 * 3. НОШЕНИЕ
 * ============================================================ */

console.log("\n=== Ношение ===");

const conceived = day(1);
const atTerm = (n) => addDays(conceived.year, conceived.month, conceived.day, n);
const carrying = { lastBleed: day(18, 8), pregnancy: { conceived } };
const viewAt = (n) => bodyView(carrying, atTerm(n));

check("в день зачатия — первая часть", pregnancyTerm(conceived, atTerm(0)).part, 1);
check("на тридцатый — вторая", pregnancyTerm(conceived, atTerm(30)).part, 2);
check("до зачатия срока нет", String(pregnancyTerm(conceived, day(1, 8))), "null");

check("до шевеления — сокрытое", pregnancySummary({ conceived }, atTerm(129)).stage.id, "dulid");
check("со ста тридцатого — ожившее", pregnancySummary({ conceived }, atTerm(130)).stage.id, "kviknat");
check("последняя часть — подошедшая к падению", pregnancySummary({ conceived }, atTerm(240)).stage.id, "falli");
check("срок вышел на двести семидесятый", pregnancySummary({ conceived }, atTerm(TERM_DAYS)).overdue, true);
check("а накануне ещё нет", pregnancySummary({ conceived }, atTerm(TERM_DAYS - 1)).overdue, false);

/* 1 сольмануда + 270 дней: через аукнэтр и смену года — 20 гои 1016. */
check("когда ждать — вехой года", dueWords(conceived), "к середине гои");
check("аукнэтр называются своим словом",
    dueWords(addDays(1015, 9, 26, -TERM_DAYS + 5)), "к самой середине лета, на аукнэтр");

check("счёт ношения в заголовке", viewAt(130).count, "Ношение: 5/9");
check("и не дальше девяти, когда переносила", viewAt(TERM_DAYS + 10).count, "Ношение: 9/9");
check("когда ждать — второй строкой", viewAt(130).extra.startsWith("Ждать "), true);
check("со своим значком", viewAt(130).extraIcon, "body-due");
check("цикл молчит, пока носит", viewAt(5).state, "pregnant");

/* Срок модели отдаётся словом: «5/9» она принимается пересчитывать вслух. */
check("месяц словом", viewAt(130).phrase,
    "{{user}} носит дитя: идёт пятый месяц из девяти. Живот уже виден.");
check("на малом сроке не видно", viewAt(20).phrase,
    "{{user}} носит дитя: идёт первый месяц из девяти. По ней этого пока не видно.");
check("живот виден с четвёртой части", viewAt(OBVIOUS_DAY).phrase.endsWith("Живот уже виден."), true);
check("переносила — так и сказано", viewAt(TERM_DAYS).phrase,
    "{{user}} носит дитя, и срок уже вышел: роды могут начаться со дня на день.");

/* Числа счёта модели не уходят никогда: ни день цикла, ни часть срока. */
const phrases = [];
for (let n = 1; n <= 28; n++) phrases.push(onDay(n).phrase);
for (let n = 0; n <= TERM_DAYS + 5; n += 7) phrases.push(viewAt(n).phrase);
check("в строках для модели нет ни одной цифры",
    phrases.filter((p) => p && /\d/.test(p)).length, 0);

/* ============================================================
 * 4. РУЧНАЯ УСТАНОВКА
 * ============================================================ */

console.log("\n=== Ручная установка ===");

const today = day(10);
const setDay = cycleAnchor(today, 14);
check("день выставлен руками", cycleSummary(setDay.body, today).day, 14);
check("и запись стоит на сегодня", serialOf(setDay.at.year, setDay.at.month, setDay.at.day),
    serialOf(today.year, today.month, today.day));

const byPart = pregnancyAnchor(today, { part: 3 });
check("беременность по части срока", pregnancySummary(byPart.body.pregnancy, today).part, 3);
check("дата зачатия помечена вычисленной", byPart.body.pregnancy.guessedDate, true);
check("кровь — за две недели до зачатия",
    serialOf(...Object.values(byPart.body.pregnancy.conceived)) - serialOf(...Object.values(byPart.body.lastBleed)), 13);

const byDate = pregnancyAnchor(today, { conceived: day(1, 7), part: 1 });
check("по дате зачатия — дата главнее части",
    pregnancySummary(byDate.body.pregnancy, today).part, 3);
check("и она не вычисленная", byDate.body.pregnancy.guessedDate, false);

const cleared = pregnancyAnchor(today, null);
check("сняли — беременности нет", String(cleared.body.pregnancy), "undefined");
check("и цикл с первого дня", cycleSummary(cleared.body, today).day, 1);
check("без даты сцены записи нет", String(cycleAnchor(null, 3)), "null");

/* ============================================================
 * 5. ЧАТ
 * ============================================================ */

console.log("\n=== Счёт по чату ===");

/* Ручная запись переживает то, что уносило её на сообщении: свайп заменяет
   extra последнего сообщения, но метаданные чата этого не касаются. */
const chat = [mkDated("хадеги", "date: 1 хейаннир 1015"), mk("ундорн")];
syncWholeChat(chat);
const kept = pregnancyAnchor(day(1, 10), { part: 4 });
chat[chat.length - 1] = mk("наттмал");
syncWholeChat(chat);
check("свайп ручную запись не уносит",
    !!findBodyState(chat, null, { manualBody: kept })?.pregnancy, true);

/* С начала чата счёт идёт с первого дня — пока автор не скажет иначе. */
const fresh = [mk("моргун"), mk("хадеги")];
syncWholeChat(fresh);
const freshRead = readChat(fresh, day(5), {});
check("от даты начала — первый день", cycleSummary(freshRead.body, freshRead.date).day, 1);

/*
 * Старые маркеры тела больше ничего не двигают.
 *
 * Прежде «кровь пришла» ставила якорь цикла на свой день, «понесла» и BED
 * кидали кубик на зачатие. Теперь счёт ведёт только рука автора: такие
 * маркеры в старом чате вырезаются из текста и молчат.
 */
const old = [
    mkDated("хадеги", "date: 1 сольмануд 1015"),
    mkDated("хадеги", "date: 10 сольмануд 1015", "кровь пришла; понесла"),
    mk("наттмал", ["<!-- NRN BED | sex: yes | internal: yes -->", "<!-- NRN BODY | body: conceived -->"]),
];
syncWholeChat(old);
const oldBody = findBodyState(old, null, {});
check("«кровь пришла» якоря не двигает", cycleDay(oldBody.lastBleed, day(10)), 10);
check("и зачатия не бывает", String(oldBody.pregnancy), "undefined");
check("а маркеры из текста вырезаны", old.every((m) => !m.mes.includes("<!--")), true);

/* Старая запись тела может нести поля прежнего движка — детей, отвар,
   угрозу. Вид их не читает и не падает на них. */
const legacy = bodyView({
    lastBleed: day(1),
    children: [{ born: day(1, 3), name: "Хельга" }],
    herb: { id: "einir", at: day(2) },
    pregnancy: { conceived: day(1, 6), threat: { at: day(3) }, labour: null },
}, day(1));
check("старая запись читается как ношение", legacy.state, "pregnant");

/* ============================================================
 * 6. ЭТАЛОН СБРОСА
 *
 * `EMPTY_STATE` — это то, чем refresh() затирает кэш отрисовки перед тем, как
 * положить сверху свежий снимок. Поля, которого в эталоне нет, затирать нечем:
 * в чате без единого снимка оно так и останется на экране от прошлой истории.
 *
 * Читаем исходник, а не импортируем: index.js — расширение SillyTavern,
 * из-под node оно не поднимется.
 * ============================================================ */

console.log("\n=== Эталон сброса ===");

const panelSrc = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const standard = new Set(
    [...(panelSrc.match(/const EMPTY_STATE = \{([\s\S]*?)\n\};/)?.[1] ?? "")
        .matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
/* `state.js` ловится из имени файла «chat-state.js» — это не поле. */
const readFromCache = [...new Set(
    [...panelSrc.matchAll(/(?<![\w.])state\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))]
    .filter((key) => key !== "js" && !standard.has(key));
check("панель не читает поля мимо эталона сброса", readFromCache.join(", ") || "нет", "нет");

/* Промпт не должен звать модель к темам, которых больше нет. */
const prompt = panelSrc.slice(panelSrc.indexOf("const BLOCK_HEADER"), panelSrc.indexOf("function sceneContext"));
check("в промпте нет снятых тем",
    ["NRN BODY", "NRN BED", "NRN FREYJA", "NRN SIGNS", "NRN WOMB", "NRN KIN", "NRN BIRTH", "NRN CHILD",
        "<norse_child>"].filter((w) => prompt.includes(w)).join(", ") || "нет", "нет");

console.log(`\n${"─".repeat(60)}`);
console.log(`Пройдено: ${ok}   Провалено: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
