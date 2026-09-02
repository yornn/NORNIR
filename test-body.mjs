/*
 * NORNIR — тест женского цикла.
 *
 * Считается всё вычитанием дат, поэтому проверяем границы фаз, оборот цикла
 * через конец месяца и аукнэтр, а заодно разбор событий из маркера.
 *
 * Запуск: node test-body.mjs
 */

import {
    CYCLE_DEFAULT,
    MULTIPLE_CHANCE,
    TERM_DAYS,
    TERM_PARTS,
    bodyView,
    childNeed,
    childSummary,
    conceptionChance,
    cycleDay,
    cyclePhrase,
    cycleSigns,
    disruptionShift,
    termSigns,
    weatherToll,
    postpartumStage,
    cycleSummary,
    normalizeCycleLength,
    phaseOf,
    pregnancySummary,
    pregnancyTerm,
    HERBS,
    HERB_TOLLS,
    herbBarren,
    herbView,
    herbsInSeason,
    pickHerb,
    rollBirths,
    rollHerb,
    rollSex,
    rollSexes,
    rollStillbirth,
    rollThreat,
    strainLoad,
    termVulnerability,
    trueSexOf,
    STILLBIRTH,
    VIABLE_DAY,
} from "./body.js";
import { cycleAnchor, findBodyState, findLatestState, herbAnchor, labourAnchor, pregnancyAnchor, readChat, setSceneDate, syncWholeChat } from "./chat-state.js";
import { WEEKDAYS, addDays, parseBodyEvents, parseYesNo, parseUrd, serialOf, serialToDate } from "./parser.js";
import { daysSinceBleeding } from "./body.js";
import { readFileSync } from "node:fs";

let ok = 0;
let bad = 0;

function check(label, got, want) {
    const pass = String(got) === String(want);
    pass ? ok++ : bad++;
    console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(46)} → ${got}${pass ? "" : `   (ждали ${want})`}`);
}

let seq = 0;
function mk(eykt, dateLine = "", body = "", passed = "") {
    return {
        is_user: false,
        gen_finished: `gen-${seq++}`,
        extra: {},
        mes: [
            "проза", "", "<!-- [URD:",
            `eykt: ${eykt}`,
            dateLine,
            body ? `body: ${body}` : "",
            passed ? `passed: ${passed}` : "",
            "weather: снег", "location: дом", "mood: ок",
            "user_attire: а", "char_attire: б", "thought: в",
            "] -->",
        ].filter(Boolean).join("\n"),
    };
}

console.log("=== Разбор событий ===");

check("кровь пришла", parseBodyEvents("кровь пришла"), "bleedStart");
check("началась кровь", parseBodyEvents("началась кровь"), "bleedStart");
check("кровь кончилась", parseBodyEvents("кровь кончилась"), "bleedEnd");
check("семя пролилось", parseBodyEvents("семя пролилось"), "seedSpilled");
check("семя не пролилось", parseBodyEvents("семя не пролилось"), "seedWithheld");
check("два события через точку с запятой",
    parseBodyEvents("кровь кончилась; семя пролилось"), "bleedEnd,seedSpilled");
check("постороннее слово", String(parseBodyEvents("он ушёл за дровами")), "null");
check("пустое поле", String(parseBodyEvents("")), "null");

console.log("\n=== Счёт дней ===");

const bleed = { year: 1015, month: 9, day: 5 };
check("день крови — первый", cycleDay(bleed, { year: 1015, month: 9, day: 5 }), 1);
check("через пять дней — шестой", cycleDay(bleed, { year: 1015, month: 9, day: 10 }), 6);
/* Цикл 28 дней, месяц 30 — они нарочно не совпадают, как и в жизни. */
check("через тридцать дней — уже третий", cycleDay(bleed, { year: 1015, month: "AUK", day: 5 }), 3);
check("через тридцать шесть — девятый", cycleDay(bleed, { year: 1015, month: "AUK", day: 11 }), 9);

/* Оборот через границу месяца: 28 гормануда + 7 дней = 5 юлира. */
const late = { year: 1015, month: 1, day: 28 };
check("оборот через границу месяца", cycleDay(late, { year: 1015, month: 2, day: 5 }), 8);

check("длина цикла — всегда 28", CYCLE_DEFAULT, 28);
check("защита от мусора всё же есть", normalizeCycleLength("ага"), 28);

console.log("\n=== Фазы ===");

check("день 1 — тидир", phaseOf(1).id, "tidir");
check("день 5 — тидир", phaseOf(5).id, "tidir");
check("день 6 — хрейнсун", phaseOf(6).id, "hreinsun");
check("день 12 — открытое лоно", phaseOf(12).id, "opit");
check("день 16 — ещё открытое", phaseOf(16).id, "opit");
check("последний день короткого цикла", phaseOf(24, 24).id, "thverrandi");
check("день 17 — тверранди", phaseOf(17).id, "thverrandi");

const peak = cycleSummary({ lastBleed: bleed }, { year: 1015, month: 9, day: 18 }, 28);
check("день зачатия — четырнадцатый", peak.day, 14);
check("в эти дни лоно плодовито", peak.fertile, true);
check("в статусе — Фрейя", peak.status.includes("Фрейя"), true);
check("до открытия лоно закрыто",
    cycleSummary({ lastBleed: bleed }, { year: 1015, month: 9, day: 14 }, 28).fertile, false);

console.log("\n=== Слова ===");

/*
 * Числа счёта в строку для модели не идут.
 *
 * Стояло «день 3 из 28»: женщине XI века такое число взять неоткуда, а модель,
 * увидев его, принимается считать вслух. Фазу называет статус, и этого хватает.
 * Панель числа по-прежнему знает — они в `count`, и он проверен выше.
 */
check("в дни крови",
    cyclePhrase(cycleSummary({ lastBleed: bleed }, { year: 1015, month: 9, day: 7 }, 28)),
    "Тело {{user}}: Кровь идёт. Тело холодеет и очищается. Дитя сейчас не возьмётся. Силы покидают утробу.");
check("после крови",
    cyclePhrase(cycleSummary({ lastBleed: bleed }, { year: 1015, month: 9, day: 12 }, 28)).startsWith("Тело {{user}}: Тело сохнет."), true);
check("и ни одного числа счёта",
    /день \d+ из \d+/.test(cyclePhrase(cycleSummary({ lastBleed: bleed }, { year: 1015, month: 9, day: 12 }, 28))), false);
check("без крови в истории", String(cyclePhrase(cycleSummary({}, bleed, 28))), "null");

console.log("\n=== Перенос по чату ===");

const chat = [
    mk("хадеги", "date: 1 сольмануд 1015"),
    mk("хадеги", "", "кровь пришла"),
    mk("наттмал"),
    mk("отта"),
];
syncWholeChat(chat);
const state = findBodyState(chat);
check("событие запомнило свой день",
    `${state.lastBleed.day} / ${state.lastBleed.month}`, "1 / 9");

/*
 * Пересборка не должна съедать снимок.
 *
 * Отпечаток генерации кладётся в extra приведённым к секундам, и при
 * следующей сверке приведение делается снова — уже над своим же выводом.
 * Значит оно обязано быть идемпотентным: пока Date.parse разбирал голые
 * числа как год, отпечаток переставал совпадать сам с собой, и снимок со
 * всем сказанным стирался как чужой.
 */
const restamped = [
    { is_user: false, gen_finished: "told-70", extra: {},
      mes: ["проза", "<!-- [URD:", "eykt: хадеги", "date: 5 сольмануд 1015",
          "child_name: Хельга", "weather: снег", "location: дом", "mood: ок", "] -->"].join("\n") },
];
syncWholeChat(restamped);
check("снимок прочитан", readChat(restamped, null, {}).told?.childName, "Хельга");
syncWholeChat(restamped);
check("и пересборку пережил", readChat(restamped, null, {}).told?.childName, "Хельга");

/* Второе событие сдвигает якорь: цикл считается от свежей крови. */
chat.push(mk("хадеги", "", "кровь пришла"));
syncWholeChat(chat);
check("новая кровь сдвинула якорь", findBodyState(chat).lastBleed.day, 2);

/* Откат чата уносит и тело — по тому же принципу, что и дату. */
chat.length = 2;
syncWholeChat(chat);
check("откат вернул прежний якорь", findBodyState(chat).lastBleed.day, 1);

/* Без единого события цикл всё равно идёт: по умолчанию он начинается
   с первого дня в день начала истории. */
const noEvents = [mk("хадеги", "date: 1 сольмануд 1015"), mk("отта")];
syncWholeChat(noEvents);
check("без событий цикл стартует с первого дня",
    cycleSummary(findBodyState(noEvents), { year: 1015, month: 9, day: 1 }, 28).day, 1);
check("и сдвигается вместе с датой",
    cycleSummary(findBodyState(noEvents), { year: 1015, month: 9, day: 9 }, 28).day, 9);

/* Таймскип двигает дату — цикл обязан уехать вместе с ней. */
const skip = [mk("хадеги", "date: 1 сольмануд 1015"), mk("хадеги", "", "", "10 дней")];
syncWholeChat(skip);
check("таймскип сдвинул цикл",
    cycleSummary(findBodyState(skip), findLatestState(skip).state, 28).day, 11);

console.log("\n=== Зачатие ===");

/* Шансы подменяем на крайние значения: проверяем механику, а не везение.
   Форма та же, что у CONCEPTION: базовый шанс, надбавка за фазу, множитель
   за пролившееся мимо. */
const ALWAYS = { base: 1, phase: {}, withheld: 1 };
const NEVER = { base: 0, phase: {}, withheld: 0 };

/* Близость приходит полями sex/internal, а не событием в body. */
const lie = (dayOfMonth, internal = "да") => {
    const chat = [
        mk("хадеги", "date: 1 сольмануд 1015"),
        {
            is_user: false, gen_finished: "s-" + (seq++), extra: {},
            mes: ["проза", "", "<!-- [URD:", "eykt: хадеги",
                "date: " + dayOfMonth + " сольмануд 1015",
                "sex: да", "internal: " + internal,
                "weather: снег", "location: дом", "mood: ок",
                "user_attire: а", "char_attire: б", "thought: в", "] -->"].join("\n"),
        },
    ];
    syncWholeChat(chat);
    return chat;
};

check("при шансе 1 дитя берётся",
    !!findBodyState(lie(14), null, { chances: ALWAYS, chatId: "t" })?.pregnancy, true);
check("при шансе 0 не берётся",
    String(findBodyState(lie(14), null, { chances: NEVER, chatId: "t" })?.pregnancy), "undefined");
check("бросок записан в скрытый слой",
    typeof findBodyState(lie(14), null, { chances: NEVER, chatId: "t" })?.lastRoll?.value, "number");
check("шанс взят по фазе",
    findBodyState(lie(14), null, { chatId: "t" })?.lastRoll?.chance, 0.25);
check("вне окна шанс ниже",
    findBodyState(lie(20), null, { chatId: "t" })?.lastRoll?.chance, 0.02);
/* (0.02 базовый + 0.23 за открытое лоно) × 0.2 = 0.05. */
check("наружу шанс ещё ниже",
    Number(findBodyState(lie(14, "нет"), null, { chatId: "t" })?.lastRoll?.chance.toFixed(4)), 0.05);

/* Бросок обязан быть одинаковым при каждом пересчёте — иначе беременность
   появлялась бы и исчезала на каждой перерисовке панели. */
const rollA = findBodyState(lie(14), null, { chatId: "t" })?.lastRoll?.value;
const rollB = findBodyState(lie(14), null, { chatId: "t" })?.lastRoll?.value;
check("бросок детерминирован", rollA === rollB, true);
check("в другом чате бросок другой",
    findBodyState(lie(14), null, { chatId: "u" })?.lastRoll?.value !== rollA, true);

console.log("\n=== Ношение ===");

const conceived = { year: 1015, month: 9, day: 14 };
const at = (days) => pregnancySummary({ conceived, quickened: null },
    addDays(conceived.year, conceived.month, conceived.day, days));

check("на первой части ничего не знают", at(10).known, false);
check("к четвёртой части отрицать нечего", at(95).known, true);
check("но шевеления ещё нет", at(95).quickened, false);
check("ранние дни не показывают ничего", at(3).sign, "По виду и по чувству ничего");
check("и стадия — сокрытое", at(10).stage.id, "dulid");
check("после пятой части дитя ожило", at(140).stage.id, "kviknat");
check("часть срока считается от зачатия", at(140).part, 5);
/* Мера — рука, а не живность: ноготь, палец, ладонь, пядь, локоть.
   Прежде мерили куропаточьими яйцами и кошками — это не средневековье,
   а нынешние приложения для беременных с животными вместо фруктов. */
check("размер меряется рукой", at(140).size, "с ладонь");
check("и растёт до локтя", at(265).size, "в локоть");
check("последняя часть — подошедшая к падению", at(250).stage.id, "falli");
check("девять частей — это 270 дней", TERM_DAYS, 270);
check("частей ровно девять", TERM_PARTS, 9);
check("гадание не пляшет между вызовами", at(140).guess.text, at(140).guess.text);
check("у дитяти есть настоящий пол", ["m", "f"].includes(trueSexOf(conceived)), true);

console.log("\n=== Роды и кормление ===");

/* Ручная запись живёт в метаданных чата и передаётся в options — так же,
   как это делает панель. На сообщении она не держится: свайп и перегенерация
   подменяют extra, и якорь исчезал молча. */
const bornAnchor = pregnancyAnchor({ year: 1015, month: 9, day: 14 }, { part: 1, known: true });
const bornOpts = { manualBody: bornAnchor };
const born = [
    mk("хадеги", "date: 1 сольмануд 1015"),
    mk("хадеги", "date: 14 сольмануд 1015"),
    mk("хадеги", "date: 14 хейаннир 1016", "родила"),
];
syncWholeChat(born);
const afterBirth = findBodyState(born, null, bornOpts);
check("роды закрыли беременность", String(afterBirth.pregnancy), "undefined");
check("и открыли кормление", !!afterBirth.nursing, true);

born.push(mk("хадеги", "date: 20 хейаннир 1016", "отняли от груди"));
syncWholeChat(born);
const weaned = findBodyState(born, null, bornOpts);
check("отняли от груди — кормление кончилось", String(weaned.nursing), "undefined");
check("и цикл пошёл заново с первого дня",
    cycleSummary(weaned, { year: 1016, month: 10, day: 20 }, 28).day, 1);

console.log("\n=== Объявление из сцены ===");

/* Бросок может промахнуться, а ролевая уехать вперёд. Тогда сцена говорит
   прямо, и движок обязан поверить — иначе проза и панель расходятся навсегда. */
const missed = [
    mk("хадеги", "date: 1 сольмануд 1015"),
    {
        is_user: false, gen_finished: "miss-1", extra: {},
        mes: ["проза", "", "<!-- [URD:", "eykt: хадеги", "date: 7 сольмануд 1015",
            "sex: да", "internal: да", "weather: снег", "location: дом", "mood: ок",
            "user_attire: а", "char_attire: б", "thought: в", "] -->"].join("\n"),
    },
];
syncWholeChat(missed);
check("при малом шансе бросок мимо",
    String(findBodyState(missed, null, { chances: NEVER, chatId: "z" })?.pregnancy), "undefined");

missed.push(mk("хадеги", "date: 8 сольмануд 1015", "поняла, что тяжела"));
syncWholeChat(missed);
const declared = findBodyState(missed, null, { chances: NEVER, chatId: "z" });
check("сцена объявила — дитя есть", !!declared.pregnancy, true);
check("отсчитано от дня близости, а не объявления", declared.pregnancy.conceived.day, 7);
check("и героиня сразу знает", !!declared.pregnancy.knownSince, true);

const straight = [mk("хадеги", "date: 1 сольмануд 1015"), mk("хадеги", "date: 5 сольмануд 1015", "понесла")];
syncWholeChat(straight);
check("«понесла» заводит дитя без броска", !!findBodyState(straight)?.pregnancy, true);

console.log("\n=== Задержка ===");

/* Молчание сцены — не отсутствие крови. За таймскип в три месяца тидир
   приходили трижды, и «кровь не приходила 90 дней» здесь было бы ложью. */
const skipped = [mk("хадеги", "date: 1 сольмануд 1015"), mk("хадеги", "", "", "три месяца")];
syncWholeChat(skipped);
const afterSkip = bodyView(findBodyState(skipped), findLatestState(skipped).state);
check("после таймскипа задержки нет", afterSkip.state, "cycling");
check("а цикл просто идёт дальше", afterSkip.count, "7/28");

const carrying = {
    lastBleed: { year: 1015, month: 9, day: 1 },
    pregnancy: { conceived: { year: 1015, month: 9, day: 14 }, quickened: null, knownSince: null },
};
const carryView = bodyView(carrying, { year: 1015, month: 10, day: 20 });
check("у беременной задержка считается", carryView.state, "pregnant_unknown");
check("и показана днями", carryView.title.startsWith("Кровь не приходила:"), true);

console.log("\n=== Потерянная смена года ===");

/*
 * Год начинается первым гормануда, то есть перещёлкивает посреди осени.
 * Модель старых чатов писала даты привычным календарём и смены года не
 * замечала: после «4 хейаннир 1015» у неё шёл «1 гормануд 1015» вместо
 * 1016 — и якорь тащил всю историю на 284 дня назад.
 */
const turned = [
    mk("хадеги", "date: 4 хейаннир 1015"),
    mk("хадеги"),
    mk("хадеги", "date: 1 гормануд 1015"),
];
syncWholeChat(turned);
const turnedDate = readChat(turned, null, {}).date;
check("потерянный год восстановлен", `${turnedDate.day}.${turnedDate.month}.${turnedDate.year}`, "1.1.1016");

/* Малый откат так не лечим: это уже не потерянный год, а путаница, и
   подменять её скачком на год вперёд было бы хуже болезни. */
const stumble = [
    mk("хадеги", "date: 10 гормануд 1015"),
    mk("хадеги", "date: 4 гормануд 1015"),
];
syncWholeChat(stumble);
const stumbleDate = readChat(stumble, null, {}).date;
check("малый откат оставлен как есть", `${stumbleDate.day}.${stumbleDate.month}.${stumbleDate.year}`, "4.1.1015");

/* Рука пользователя — авторский акт: назад её двигают намеренно. */
const handMoved = [mk("хадеги", "date: 4 хейаннир 1015"), mk("хадеги")];
syncWholeChat(handMoved);
setSceneDate(handMoved, { year: 1015, month: 1, day: 1 });
const handDate = readChat(handMoved, null, {}).date;
check("поставленную руками не поправляем",
    `${handDate.day}.${handDate.month}.${handDate.year}`, "1.1.1015");

/* И то, ради чего всё затевалось: срок ношения перестал съезжать. */
const carriedOver = [
    mk("хадеги", "date: 4 хейаннир 1015", "понесла"),
    mk("хадеги"),
    mk("хадеги", "date: 4 гормануд 1015"),
];
syncWholeChat(carriedOver);
const over = readChat(carriedOver, null, {});
check("и ношение считается верно",
    bodyView(over.body, over.date, {}).count, "Ношение: 4/9");

console.log("\n=== Приметы по сроку ===");

/* Считаются от части срока и погоды: модели их не спрашивают, потому что
   она их не наблюдает, а сочиняет. В промпте они стоят ноль токенов. */
check("на первой части примет нет", termSigns(1).length, 0);
check("к шестой части их пятеро", termSigns(6).length, 5);
check("к девятой — все восемь", termSigns(9).length, 8);
/* Ищем по виду, а не по тексту: слово «Léttari» из самих строк убрано —
   в «Доме и нитях» ярлык строки рисует CSS по виду приметы, и приставка
   выходила вторым ярлыком подряд. Вид и есть имя приметы. */
check("léttari появляется на девятой",
    termSigns(9).some((x) => x.kind === "lettari"), true);
check("и не раньше", termSigns(8).some((x) => x.kind === "lettari"), false);
/* Вид приметы — ключ к знаку в icons/sign-*.svg, без него панель рисует
   заглушку и все приметы выглядят одинаково. */
check("у léttari своя строка",
    termSigns(9).filter((x) => x.kind === "lettari").length, 1);
/* И ни одна строка больше не называет свой вид сама. */
check("приставки в тексте не осталось",
    termSigns(9).some((x) => /^Léttari/i.test(x.text)), false);

console.log("\n=== Дитя: слова сцены поверх таблицы ===");

/*
 * Нужду считала таблица — от возраста, эйкты и дня недели — и тасовала
 * одни и те же слова по кругу, ровно как это было с приметами тела. Сцена
 * видит больше: дитя может кричать не от голода, а оттого, что в доме чужие.
 */
const kidBody = {
    lastBleed: { year: 1015, month: 1, day: 1 },
    children: [{ born: { year: 1015, month: 2, day: 1 } }],
};
const kidDay = { year: 1015, month: 4, day: 1 };

const kidPlain = bodyView(kidBody, kidDay, {})?.children?.[0];
const kidScene = bodyView(kidBody, kidDay, {
    sceneChild: { arms: "у матери на руках", look: "отцовы брови", need: "кричит на чужих" },
})?.children?.[0];

check("нужда берётся из сцены", kidScene.need, "кричит на чужих");
check("а без сцены — из таблицы", typeof kidPlain.need, "string");
check("на руках и обличье — только из сцены",
    [kidScene.arms, kidScene.look, kidPlain.arms, kidPlain.look],
    ["у матери на руках", "отцовы брови", null, null]);
/* Возраст и стадию по-прежнему считает панель: сцена их не назначает. */
check("возраст и стадию сцена не трогает",
    [kidScene.age, kidScene.stage.id], [kidPlain.age, kidPlain.stage.id]);
/* Сцена смолчала — таблица на месте, пустой плашки не бывает. */
check("пустые слова сцены ничего не ломают",
    bodyView(kidBody, kidDay, { sceneChild: { arms: null, look: null, need: null } })
        ?.children?.[0].need, kidPlain.need);

console.log("\n=== Слова примет от сцены ===");

/*
 * Панель решает, о чём сегодня говорит тело; сцена подбирает к этому слова.
 *
 * Прежде слова брались из пула по шесть штук на вид: через две недели игры пул
 * был весь виден, и панель твердила одно и то же — причём мимо сцены. Героиня
 * всю ночь мёрзла в лодке, а панель писала «спит крепко, встаёт до света»,
 * потому что по дню цикла положено.
 */
const signBody = { lastBleed: { year: 1015, month: 9, day: 5 } };
const signDay = { year: 1015, month: 9, day: 7 };

const fromTable = bodyView(signBody, signDay, {});
const fromScene = bodyView(signBody, signDay, {
    sceneSigns: {
        breast: "соски саднит от рубахи",
        sleep: "не спала, слушала ветер",
        /* Вида нет в сегодняшнем наборе — слова должны отвалиться. */
        nausea: "мутило с утра",
    },
});

const textOf = (view, kind) => view.signs.find((x) => x.kind === kind)?.text;

check("слова сцены встают вместо табличных",
    textOf(fromScene, "breast"), "соски саднит от рубахи");
check("и помечены как пришедшие из сцены",
    fromScene.signs.find((x) => x.kind === "breast").fromScene, true);
check("вид, о котором сцена смолчала, держит слово таблицы",
    textOf(fromScene, "blood"), textOf(fromTable, "blood"));
/* Счёт решает, каким приметам быть. Иначе героиня жаловалась бы на дурноту
   в те дни, когда дурноты нет, и весь счёт стал бы украшением. */
check("примета не своего дня выбрасывается",
    fromScene.signs.some((x) => x.kind === "nausea"), false);
check("состав примет от слов сцены не меняется",
    fromScene.signs.map((x) => x.kind), fromTable.signs.map((x) => x.kind));
check("без слов сцены вид остаётся прежним",
    fromTable.signs.every((x) => !x.fromScene), true);
/* Пустой панели не бывает: пул остаётся запасным на все виды сразу. */
check("пустой словарь ничего не ломает",
    bodyView(signBody, signDay, { sceneSigns: {} }).signs.map((x) => x.text),
    fromTable.signs.map((x) => x.text));

/*
 * Слова меняются, состав — нет.
 *
 * Прежде список был плоским: часть срока держится тридцать суток, и всё это
 * время панель повторяла те же строки в том же порядке. Теперь на каждый вид
 * стоит пул, а слово из него берётся по сиду — сутки держат, свайп не
 * перекидывает, у разных носящих в один день разное.
 */
const termAt = (seed) => termSigns(6, seed).map((s) => s.text).join("|");
check("при том же сиде приметы те же", termAt("a|100") === termAt("a|100"), true);
check("назавтра слова другие", termAt("a|100") !== termAt("a|101"), true);
check("а состав тот же", termSigns(6, "a|100").map((s) => s.kind).join("|"),
    termSigns(6, "a|101").map((s) => s.kind).join("|"));
check("у разных носящих в один день разное", termAt("a|100") !== termAt("b|100"), true);

/* Пулы не должны протекать за своё окно: молозиво на шестой части — ложь. */
const milkTexts = ["Молозиво пришло", "Молозиво выступило — рубаха мокра поутру",
    "Из сосков сочится жёлтое и липкое"];
check("молозиво не приходит раньше девятой",
    Array.from({ length: 40 }, (_, i) => termSigns(8, `s|${i}`))
        .some((row) => row.some((s) => milkTexts.includes(s.text))), false);
/* Каждый пул должен отдавать больше одного слова, иначе разнообразия нет. */
const seen = new Map();
for (let i = 0; i < 200; i++) {
    for (const s of termSigns(9, `v|${i}`)) {
        if (!seen.has(s.kind)) seen.set(s.kind, new Set());
        seen.get(s.kind).add(s.text);
    }
}
check("каждый вид говорит по-разному",
    Array.from(seen.values()).every((texts) => texts.size > 1), true);

/* Неосознанная беременность видит приметы тела, но не живот: поясок и
   округлившийся стан начинаются с четвёртой части, когда скрывать нечего. */
const unaware = bodyView(
    { lastBleed: { year: 1014, month: 12, day: 18 },
      pregnancy: { conceived: { year: 1015, month: 1, day: 1 } } },
    addDays(1015, 1, 1, 80), {});
check("не знающая о дитяти видит приметы", unaware.state, "pregnant_unknown");
check("грудь и дурноту среди них",
    ["breast", "nausea"].every((k) => unaware.signs.some((s) => s.kind === k)), true);
check("а живот себя не выдаёт", unaware.signs.some((s) => s.kind === "belly"), false);

console.log("\n=== Приметы цикла ===");

/* Небеременной панель показывала одну фазу и ничего больше, хотя грудь, сон
   и запахи ходят по кругу ровно так же, как под дитятей. */
const kindsAt = (day, seed = "c|1") => cycleSigns(day, 28, seed).map((s) => s.kind);
check("в дни крови есть кровь, грудь и сон",
    ["blood", "breast", "sleep"].every((k) => kindsAt(2).includes(k)), true);
check("и запахи тоже", kindsAt(2).includes("smell"), true);
check("на очищении крови уже нет", kindsAt(8).includes("blood"), false);
check("зато прибывает сила", kindsAt(8).includes("hunger"), true);
check("на открытом лоне своё", kindsAt(14).includes("heat"), true);
check("перед кровью отекает", kindsAt(26).includes("swelling"), true);
check("а на семнадцатый день ещё нет", kindsAt(17).includes("swelling"), false);
/* Хвост цикла принадлежит предкровью: иначе грудь встала бы двумя строками —
   и «потяжелела», и «каменная». */
check("грудь не двоится в предкровье",
    kindsAt(26).filter((k) => k === "breast").length, 1);
check("и в тяжелеющем лоне тоже",
    kindsAt(20).filter((k) => k === "breast").length, 1);
check("предкровье считается с хвоста, а не с головы",
    cycleSigns(36, 40, "c|1").map((s) => s.kind).includes("swelling"), false);
check("при длинном цикле оно всё равно наступит",
    cycleSigns(38, 40, "c|1").map((s) => s.kind).includes("swelling"), true);
check("без дня цикла примет нет", cycleSigns(null, 28, "c|1").length, 0);

const cycleAt = (seed) => cycleSigns(3, 28, seed).map((s) => s.text).join("|");
check("сид держит приметы цикла сутки", cycleAt("c|5") === cycleAt("c|5"), true);
check("а назавтра слова другие", cycleAt("c|5") !== cycleAt("c|6"), true);

/* Панель обязана верить сцене: сказано, что кровь кончилась, — примет о
   крови быть не должно, хоть по таблице тидир ещё идут. */
const bleedDay = (d) => ({ year: 1015, month: 9, day: d });
const flowing = bodyView({ lastBleed: bleedDay(1) }, bleedDay(2), {});
check("в дни крови панель показывает приметы", flowing.signs.length > 0, true);
check("и кровь среди них", flowing.signs.some((s) => s.kind === "blood"), true);
const stopped = bodyView({ lastBleed: bleedDay(1), bleedEnded: bleedDay(2) }, bleedDay(2), {});
check("а сказанное «кровь кончилась» её убирает",
    stopped.signs.some((s) => s.kind === "blood"), false);
check("прочие приметы остаются", stopped.signs.length > 0, true);

console.log("\n=== Приметы по сроку ===");

check("жара бьёт по телу", weatherToll("Сильная жара", 6).includes("отекают"), true);
check("мороз тоже", weatherToll("Мокрый снег и мороз", 9).includes("Холод"), true);
check("на малом сроке погода ещё нипочём", String(weatherToll("Сильная жара", 2)), "null");

/* Приметы о поле были перепутаны: у сына стоял «высокий и острый» живот —
   по одному признаку из каждого набора сразу. Низкий и острый сулит сына,
   высокий и круглый — дочь, и смешивать их нельзя. */
const omen = pregnancySummary(
    { conceived: { year: 1015, month: 9, day: 14 }, quickened: true },
    { year: 1016, month: 1, day: 1 }, 1).guess;
check("приметы о поле не противоречат друг другу",
    omen.told === "m" ? !omen.text.includes("высокий") : !omen.text.includes("низкий"), true);

console.log("\n=== Сбой цикла ===");

/* Задержка бывает и без дитяти. Раньше её у нас не бывало вовсе — это была
   вторая половина той же ошибки, что и ложные девяносто дней. */
const starved = [mk("хадеги", "date: 1 сольмануд 1015"), mk("хадеги", "date: 5 сольмануд 1015", "голодала")];
syncWholeChat(starved);
const upsetState = findBodyState(starved);
check("сбой записан", upsetState.disruption?.id, "hungr");
check("сдвиг детерминирован",
    disruptionShift("hungr", { year: 1015, month: 9, day: 5 })
        === disruptionShift("hungr", { year: 1015, month: 9, day: 5 }), true);
check("и лежит в своих пределах",
    disruptionShift("hungr", { year: 1015, month: 9, day: 5 }) >= 5
    && disruptionShift("hungr", { year: 1015, month: 9, day: 5 }) <= 14, true);

/* Через 30 дней от крови цикл уже перевалил за 28-й день, а сбой голода
   (5–14 дней) ещё действует. */
const upsetView = bodyView(upsetState, addDays(1015, 9, 1, 30));
check("задержка без дитяти показывается", upsetView.state, "late");
check("и названа причиной", upsetView.title, "Hungr");

/* Сбой не вечен: он откладывает кровь на свои дни и выдыхается. */
const longAfter = bodyView(upsetState, { year: 1015, month: 12, day: 1 });
check("через месяцы сбой выдохся", longAfter.state, "cycling");

console.log("\n=== Послеродовое ===");

check("первые дни — лежание", postpartumStage(3).id, "saeng");
check("потом очищение", postpartumStage(20).id, "hreinsan");
check("потом долгое кормление", postpartumStage(100).id, "brjost");
check("а к полугоду — поворот", postpartumStage(200).id, "vending");

const nursed = bodyView(
    { lastBleed: { year: 1015, month: 9, day: 1 }, nursing: { since: { year: 1015, month: 9, day: 1 } } },
    { year: 1015, month: 9, day: 4 },
);
check("панель показывает стадию", nursed.title, "Liggja á sæng");
check("и сколько дней от родов", nursed.count, "3 дня от родов");

console.log("\n=== Ручная установка ===");

const day1 = { year: 1015, month: 10, day: 1 };
const manual = [mk("хадеги", "date: 1 хейаннир 1015")];
syncWholeChat(manual);
const readWith = (anchor) => findBodyState(manual, null, { manualBody: anchor });

let anchor = pregnancyAnchor(day1, { part: 3, known: true });
const m = readWith(anchor);
check("беременность выставлена руками", !!m.pregnancy, true);
check("дата зачатия отсчитана назад", pregnancySummary(m.pregnancy, day1).part, 3);
check("и помечена вычисленной", m.pregnancy.guessedDate, true);
check("героиня уже знает", !!m.pregnancy.knownSince, true);

/* Отец — единственное поле, которое движок не выводит и не выдумывает.
   Не назвали — так и останется неназванным. */
anchor = pregnancyAnchor(day1, { part: 3, known: true, father: "Змей" });
check("отец записан", readWith(anchor).pregnancy.father, "Змей");

/* Правим часть срока, отца не трогаем — прежний должен уцелеть. */
anchor = pregnancyAnchor(day1, { part: 5, known: true, father: null }, readWith(anchor).pregnancy);
check("правка части не стирает отца", readWith(anchor).pregnancy.father, "Змей");
check("а часть срока поменялась",
    pregnancySummary(readWith(anchor).pregnancy, day1).part, 5);

const blank = pregnancyAnchor(day1, { part: 2, known: false });
check("не назвали — остаётся неназванным",
    String(readWith(blank).pregnancy.father), "null");

check("выключили — беременности нет",
    String(readWith(pregnancyAnchor(day1, null)).pregnancy), "undefined");

/* Ручная запись переживает то, что уносило её на сообщении: свайп заменяет
   extra последнего сообщения, но метаданные чата этого не касаются. */
const swiped = [mk("хадеги", "date: 1 хейаннир 1015"), mk("ундорн")];
syncWholeChat(swiped);
const kept = pregnancyAnchor(day1, { part: 4, known: true });
swiped[swiped.length - 1] = mk("наттмал");
syncWholeChat(swiped);
check("свайп последнего сообщения ручную запись не уносит",
    !!findBodyState(swiped, null, { manualBody: kept })?.pregnancy, true);

check("поля да/нет разбираются",
    String([parseYesNo("да"), parseYesNo("нет"), parseYesNo("неизвестно")]), "true,false,");


console.log("\n=== Цикл руками из Tímatal ===");

/* Ролевая не обязана начинаться с крови: можно начать с овуляции. */
const byHand = [
    { is_user: false, gen_finished: "greet", extra: {}, mes: "приветствие без маркера" },
    mk("хадеги", "date: 10 сольмануд 1015"),
];
syncWholeChat(byHand);
const startAnchor = cycleAnchor({ year: 1015, month: 9, day: 10 }, 14);
const started = cycleSummary(
    findBodyState(byHand, null, { manualBody: startAnchor }), { year: 1015, month: 9, day: 10 }, 28);
check("день выставлен руками", started.day, 14);
check("и это плодовитые дни, а не кровь", started.fertile, true);

/* Ручная установка главнее событий, случившихся до неё, — этим и чинят счёт. */
const fix = [mk("хадеги", "date: 1 сольмануд 1015", "кровь пришла"), mk("хадеги", "date: 2 сольмануд 1015")];
syncWholeChat(fix);
const fixAnchor = cycleAnchor({ year: 1015, month: 9, day: 2 }, 20);
check("рука перебила прежнее событие",
    cycleSummary(findBodyState(fix, null, { manualBody: fixAnchor }), { year: 1015, month: 9, day: 2 }, 28).day, 20);

/* ============================================================
 * Слова промпта против движка.
 *
 * Самая дорогая ошибка в этом модуле была не в арифметике: промпт требовал
 * от модели слова, которые парсер узнавал, а applyBodyEvents молча выбрасывал.
 * «кровь кончилась», «кровь не в срок» и «схватки начались» не делали ничего,
 * и заметить это можно было только чтением обоих файлов подряд.
 * ============================================================ */

console.log("\n=== Слова промпта доходят до движка ===");

/* Тот же список, что в BLOCK_BODY (index.js). Если там появится слово,
   а обработчика к нему не будет, тест это скажет. */
const PROMPT_WORDS = [
    "кровь пришла", "кровь кончилась", "кровь не в срок",
    "семя пролилось", "семя не пролилось",
    "дитя шевельнулось", "дитя бьётся", "дитя затихло",
    "схватки начались", "родила", "выкидыш",
    "дитя у груди", "отняли от груди", "поняла, что тяжела", "понесла",
    "голодала", "хворала", "была в дороге", "извелась",
    "зубок прорезался", "дитя пошло", "дитя заговорило",
    "дитя занемогло", "дитя поправилось", "дитя померло",
    "подняла тяжёлое", "надорвалась", "упала", "побили", "легла пластом",
    "дитя родилось мёртвым",
];

const unknown = PROMPT_WORDS.filter((w) => !parseBodyEvents(w));
check("каждое слово узнаётся парсером", unknown.join(", ") || "нет", "нет");

const engineSrc = readFileSync(new URL("./chat-state.js", import.meta.url), "utf8");
const handledEvents = new Set([...engineSrc.matchAll(/case\s+"(\w+)":/g)].map((m) => m[1]));
const orphans = [...new Set(PROMPT_WORDS.flatMap((w) => parseBodyEvents(w) ?? []))]
    .filter((id) => !handledEvents.has(id));
check("у каждого события есть обработчик", orphans.join(", ") || "нет", "нет");

/* Чат из сообщений с явной датой: якорь на каждом, поэтому день ровно тот,
   что написан, и счёт не зависит от догадок по эйкте. */
function chatOf(steps) {
    const chat = steps.map(([day, body, month = 9]) =>
        mk("хадеги", `date: ${day} ${month === 9 ? "сольмануд" : "твимануд"} 1015`, body ?? ""));
    syncWholeChat(chat);
    return chat;
}
const dayAt = (day, month = 9) => ({ year: 1015, month, day });

console.log("\n=== Кровь: конец и не в срок ===");

const ended = findBodyState(chatOf([[1, "кровь пришла"], [3, "кровь кончилась"]]), null, {});
check("«кровь кончилась» запоминается", !!ended.bleedEnded, true);
check("и панель говорит то же", bodyView(ended, dayAt(3), {}).status, "Кровь кончилась.");

const odd = findBodyState(chatOf([[1, "кровь пришла"], [10, "кровь не в срок"]]), null, {});
check("«кровь не в срок» не двигает счёт цикла", cycleDay(odd.lastBleed, dayAt(10), 28), 10);
check("но показывается отдельно", bodyView(odd, dayAt(10), {}).extra, "Кровь не в срок, помимо тидир");

console.log("\n=== Схватки и стадия наружу ===");

const term9 = pregnancyAnchor(dayAt(20), { part: 9, known: true });
const calm = bodyView(findBodyState(chatOf([[20, null]]), null, { manualBody: term9 }), dayAt(20), {});
/* Без этого поля промпт не включал блок [BIRTH WATCH] ни разу за всю жизнь
   расширения: он смотрит именно на stage.id. */
check("стадия уезжает наружу", calm.stage.id, "falli");

const labour = bodyView(
    findBodyState(chatOf([[20, "схватки начались"]]), null, { manualBody: term9 }), dayAt(20), {});
check("схватки меняют слова", labour.titleHint, "Схватки");
check("стадия при этом прежняя", labour.stage.id, "falli");
check("и совет другой", labour.advice.startsWith("Воду грей"), true);

check("погода доходит до примет",
    calm.signs.some((s) => s.text.includes("Холод")), false);
check("а в мороз — доходит",
    bodyView(findBodyState(chatOf([[20, null]]), null, { manualBody: term9 }), dayAt(20), { weather: "лютый мороз" })
        .signs.some((s) => s.text.includes("Холод")), true);
/* Вид приметы нужен панели: по нему она берёт знак из icons/sign-*.svg. */
check("и у приметы есть вид",
    bodyView(findBodyState(chatOf([[20, null]]), null, { manualBody: term9 }), dayAt(20), { weather: "лютый мороз" })
        .signs.find((s) => s.text.includes("Холод")).kind, "weather-toll");

console.log("\n=== Шевеления ===");

const term5 = pregnancyAnchor(dayAt(1), { part: 5, known: true });
const felt = bodyView(
    findBodyState(chatOf([[1, null], [2, "дитя шевельнулось"], [5, null]]), null, { manualBody: term5 }),
    dayAt(5), {});
check("после квикнана тишина считается", felt.kicks.days, 3);
check("и тревожит", felt.kicks.alarm, true);

const hushed = bodyView(
    findBodyState(chatOf([[1, null], [2, "дитя шевельнулось"], [3, "дитя затихло"]]), null, { manualBody: term5 }),
    dayAt(3), {});
/* Раньше «дитя затихло» ставило отметку шевеления и панель отвечала
   «Дитя бьётся крепко» — ровно наоборот сказанному в сцене. */
check("«дитя затихло» не выдаётся за шевеление", hushed.kicks.text, "Дитя притихло");
check("и это тревога", hushed.kicks.alarm, true);

console.log("\n=== Сказанное однажды ===");

function marked(day, lines) {
    return {
        is_user: false, gen_finished: `told-${seq++}`, extra: {},
        mes: ["проза", "<!-- [URD:", "eykt: хадеги", `date: ${day} сольмануд 1015`,
            ...lines, "weather: снег", "location: дом", "mood: ок", "] -->"].join("\n"),
    };
}
const toldChat = [
    marked(5, ["child_name: Хельга", "faderni: признано", "midwife: Арнхейд, полдня пути"]),
    mk("хадеги", "date: 6 сольмануд 1015"),
    mk("хадеги", "date: 7 сольмануд 1015"),
];
syncWholeChat(toldChat);
const told = readChat(toldChat, null, {}).told;
check("имя дитяти живёт дальше своего хода", told.childName, "Хельга");
check("фадерни тоже", told.faderni, "признано");
check("и повитуха", told.midwife, "Арнхейд, полдня пути");

const afterBirthChat = [...toldChat, mk("хадеги", "date: 8 сольмануд 1015", "родила")];
syncWholeChat(afterBirthChat);
const toldAfterBirth = readChat(afterBirthChat, null, {}).told;
check("после родов приготовления ни к чему", String(toldAfterBirth.midwife), "undefined");
check("а имя остаётся", toldAfterBirth.childName, "Хельга");

const lost = [...toldChat, mk("хадеги", "date: 8 сольмануд 1015", "выкидыш")];
syncWholeChat(lost);
check("выкидыш уносит сказанное о дитяти", String(readChat(lost, null, {}).told), "null");

console.log("\n=== Давность семени ===");

/* Шансы обнулены нарочно: проверяем не бросок, а то, от какого дня отсчитается
   дитя, объявленное сценой много позже последней близости. */
const noChance = {
    opit: { internal: 0, external: 0 }, hreinsun: { internal: 0, external: 0 },
    thverrandi: { internal: 0, external: 0 }, tidir: { internal: 0, external: 0 },
};
const lateGuess = [
    marked(1, ["sex: да", "internal: да"]),
    mk("хадеги", "date: 1 твимануд 1015", "понесла"),
];
syncWholeChat(lateGuess);
const guessed = findBodyState(lateGuess, null, { chances: noChance });
check("давняя близость не датирует дитя задним числом",
    pregnancyTerm(guessed.pregnancy.conceived, dayAt(1, 11)).part, 1);

/* А свежая — датирует, и в этом весь смысл поля. */
const soonGuess = [marked(1, ["sex: да", "internal: да"]), mk("хадеги", "date: 20 сольмануд 1015", "понесла")];
syncWholeChat(soonGuess);
check("а недавняя — датирует",
    findBodyState(soonGuess, null, { chances: noChance }).pregnancy.conceived.day, 1);

/*
 * Близость помнится и тогда, когда броска не было вовсе.
 *
 * Якорь крови поставлен на двадцатое, а сцена идёт вторым числом: счёт цикла
 * в минусе, фазы нет, бросать не по чему. Раньше tryConceive на этом выходе
 * возвращался молча и терял день близости вместе с броском — и «понесла»
 * тремя днями позже заводило дитя от дня догадки, а не от той ночи. Ношение
 * отставало на месяц, и заметить это было нечем.
 */
const blindSeed = [
    marked(2, ["sex: да", "internal: да"]),
    mk("хадеги", "date: 5 сольмануд 1015", "понесла"),
];
syncWholeChat(blindSeed);
const blind = findBodyState(blindSeed, null, {
    manualBody: { at: dayAt(1), body: { lastBleed: dayAt(20) } },
});
check("несчитаемый цикл не отменяет броска", !!blind.lastRoll, false);
check("но близость всё равно помнится", blind.lastSeed?.day, 2);
check("и «понесла» датирует дитя от неё", blind.pregnancy.conceived.day, 2);

console.log("\n=== Чтение чата ===");

const stable = chatOf([[1, "кровь пришла"], [2, null]]);
const stableOpts = { manualBody: cycleAnchor(dayAt(1), 5) };
readChat(stable, null, stableOpts);
/* Раньше проходы шли с разными настройками и переписывали друг друга: каждый
   честно возвращал «изменилось», и панель сохраняла чат на каждой перерисовке. */
check("повторное чтение ничего не меняет", readChat(stable, null, stableOpts).changed, false);
check("и третье тоже", readChat(stable, null, stableOpts).changed, false);

check("маркер с одним событием не отбрасывается",
    String(parseUrd("<!-- [URD:\nbody: кровь пришла\n] -->")?.body), "bleedStart");
check("маркер с одним именем — тоже",
    parseUrd("<!-- [URD:\nchild_name: Хельга\n] -->")?.childName, "Хельга");

/* ============================================================
 * Бросок: пол, число дитяти, шанс зачатия.
 *
 * Пол «в среднем пятьдесят на пятьдесят» — недостаточное условие, и это
 * выяснилось на живых прогонах. Чистый FNV-1a давал honest 52% по всему
 * диапазону и при этом СЕРИИ по двадцать дней подряд: четыре ролевые с
 * близкими датами зачатия рожали четырёх сыновей. Поэтому проверяем не долю,
 * а длину серий по подряд идущим дням.
 * ============================================================ */

console.log("\n=== Пол дитяти ===");

const sexRow = (chatId, from, n) => {
    let row = "";
    for (let i = 0; i < n; i++) row += rollSex(chatId, serialToDate(from + i));
    return row;
};
const longestRun = (row) => {
    let run = 1, max = 1;
    for (let i = 1; i < row.length; i++) { run = row[i] === row[i - 1] ? run + 1 : 1; max = Math.max(max, run); }
    return max;
};

const span = serialOf(1010, 1, 1);
const all = sexRow("demo", span, 20 * 364);
const sons = [...all].filter((c) => c === "m").length;
check("доля сыновей около половины",
    Math.abs(sons / all.length - 0.5) < 0.02, true);
/* Порог с запасом: у сломанного хэша серии доходили до двадцати. */
check("серий подряд не бывает длинных", longestRun(sexRow("demo", serialOf(1015, 9, 1), 200)) <= 10, true);

/* Без чата в сиде две разные истории с одинаковым началом рожали одинаковых
   детей — это замечалось. */
const sameDay = serialToDate(serialOf(1015, 9, 6));
check("в разных чатах дети разные",
    new Set(["A", "B", "C", "D", "E"].map((id) => rollSex(id, sameDay))).size, 2);

console.log("\n=== Двойни ===");

let single = 0, twins = 0, triplets = 0;
for (let i = 0; i < 20 * 364; i++) {
    const n = rollBirths("demo", serialToDate(span + i));
    if (n === 1) single++; else if (n === 2) twins++; else triplets++;
}
const totalBirths = single + twins + triplets;
check("двойни около полутора процентов",
    Math.abs(twins / totalBirths - MULTIPLE_CHANCE.twins) < 0.004, true);
check("тройни редки, но случаются", triplets > 0 && triplets / totalBirths < 0.001, true);
check("у двойни у каждого свой пол",
    rollSexes("demo", sameDay, 2).length, 2);

/* Носящая двоих больше и тяжелее — на часть срока вперёд. */
const twinTerm = pregnancySummary(
    { conceived: { year: 1015, month: 1, day: 1 }, quickened: null, births: 2, sex: "m" },
    addDays(1015, 1, 1, 250));
check("двойню видно к последней части", !!twinTerm.twinHint, true);
check("а раньше — нет",
    String(pregnancySummary({ conceived: { year: 1015, month: 1, day: 1 }, quickened: null, births: 2 },
        addDays(1015, 1, 1, 100)).twinHint), "null");

console.log("\n=== Формула зачатия ===");

/* База плюс надбавка за фазу, всё на множитель за пролившееся мимо. */
check("в открытые дни внутрь", conceptionChance("opit", true), 0.25);
check("в открытые дни мимо", Number(conceptionChance("opit", false).toFixed(4)), 0.05);
check("вне окна — только база", conceptionChance("thverrandi", true), 0.02);
check("в дни крови — тоже база", conceptionChance("tidir", true), 0.02);
check("после крови — с надбавкой", Number(conceptionChance("hreinsun", true).toFixed(4)), 0.08);
check("мимо никогда не ноль", conceptionChance("tidir", false) > 0, true);

/* ============================================================
 * Дитя.
 *
 * Возраст считается вычитанием дат — той же арифметикой, что и ношение.
 * Значит таймскип обязан двигать дитя вместе с датой сцены, без единой
 * отдельной формулы. Это и проверяем в первую очередь.
 * ============================================================ */

console.log("\n=== Дитя: возраст и таймскип ===");

const childOn = (day, month) => ({ born: { year: 1015, month: 9, day: 1 }, order: 0, sex: "f", name: "Хельга" });
const seeChild = (days) => childSummary(childOn(), addDays(1015, 9, 1, days), { eykt: 4, weekday: 0 });

check("в день родов", seeChild(0).age, "родилось нынче");
check("на пятый день", seeChild(5).age, "5 дней от роду");
check("во вторую девятину", seeChild(15).age, "вторая девятина");
check("через два месяца", seeChild(60).age, "2 месяца от роду");
check("через год", seeChild(360).age, "год от роду");
check("под два года", seeChild(700).age, "полтора года с лишком");
check("после двух лет счёт кончается", String(seeChild(730)), "null");

check("стадия по возрасту — новорождённое", seeChild(3).stage.id, "nyfaett");
check("в пеленах", seeChild(40).stage.id, "reifabarn");
check("у груди", seeChild(120).stage.id, "brjostbarn");
check("ползунок", seeChild(300).stage.id, "skridbarn");
check("ходунок", seeChild(500).stage.id, "gangbarn");

/* Главное: таймскип. Сцена прыгает на два месяца — дитя обязано повзрослеть
   ровно на столько же, без своей арифметики скачков. */
const grow = [
    mk("хадеги", "date: 1 сольмануд 1015"),
    mk("хадеги", "date: 1 сольмануд 1015", "родила"),
    mk("хадеги", "", "", "2 месяца"),
];
syncWholeChat(grow);
/* Мертворождение выключено нарочно: здесь проверяется взросление, а не
   везение. Базовые пять процентов иначе валят тест раз в двадцать прогонов. */
const ALIVE = { stillbirth: { base: 0, preterm: 0, early: 0, perStrain: 0 } };
const grownState = readChat(grow, null, { risks: ALIVE, manualBody: pregnancyAnchor({ year: 1015, month: 9, day: 1 }, { part: 9, known: true }) });
check("таймскип состарил дитя вместе с датой",
    childSummary(grownState.body.children[0], grownState.date, {}).days, 60);
check("и стадия догнала", childSummary(grownState.body.children[0], grownState.date, {}).stage.id, "reifabarn");

console.log("\n=== Дитя: нужды ===");

const needAt = (days, eykt, weekday) =>
    childNeed(days, addDays(1015, 9, 1, days), eykt, weekday, "seed");

/* Номер лаугардага берём из таблицы, а не числом: порядок дней недели уже
   переставляли, и зашитая цифра переехала бы на соседний день молча. */
const LAU = WEEKDAYS.findIndex((w) => w.en === "Saturday");
const OTHER_DAY = (LAU + 3) % 7;

check("нужда всегда находится", typeof needAt(30, 4, OTHER_DAY), "string");
/* Мыли под вечер, после дневных дел, — потому и эйкты вечерние. */
check("в лаугардаг под вечер моют",
    /мыт|банн|корыт/.test(needAt(30, 5, LAU)) && /мыт|банн|корыт/.test(needAt(30, 6, LAU)), true);
check("а с утра в тот же день — как обычно", /мыт|банн|корыт/.test(needAt(30, 2, LAU)), false);
check("в другой день не моют", /мыт|банн|корыт/.test(needAt(30, 5, OTHER_DAY)), false);
/* Одна эйкта — одна нужда: свайп не должен её перекидывать. */
check("нужда не пляшет в пределах эйкты", needAt(30, 4, 0), needAt(30, 4, 0));
check("а с эйктой меняется", needAt(30, 4, 0) !== needAt(30, 7, 0), true);
/* Слов на голод несколько нарочно: одна и та же строка каждый третий ход
   утомляет быстрее любой неточности. */
const spoken = new Set();
for (let d = 0; d < 200; d++) for (let e = 0; e < 8; e++) spoken.add(needAt(30 + d, e, d % 7));
check("слов на нужды много", spoken.size > 15, true);
check("современных слов в них нет",
    [...spoken].some((s) => /подгузник|памперс|бутылочк|смес|соск/i.test(s)), false);

console.log("\n=== Дитя: события сцены ===");

check("зубок узнаётся", parseBodyEvents("зубок прорезался"), "childTooth");
check("первые шаги", parseBodyEvents("дитя пошло"), "childWalks");
check("первое слово", parseBodyEvents("дитя заговорило"), "childSpeaks");
check("хворь", parseBodyEvents("дитя занемогло"), "childSick");
check("выздоровление", parseBodyEvents("дитя поправилось"), "childWell");
check("смерть", parseBodyEvents("дитя померло"), "childDied");
/* Соседние правила не должны их перехватывать. */
check("«дитя затихло» — по-прежнему тишина", parseBodyEvents("дитя затихло"), "quiet");
check("«занемогла» — про мать, не про дитя", parseBodyEvents("занемогла"), "sott");

function childChat(extra = []) {
    const chat = [
        mk("хадеги", "date: 1 сольмануд 1015"),
        mk("хадеги", "date: 1 сольмануд 1015", "родила"),
        ...extra,
    ];
    syncWholeChat(chat);
    return chat;
}
const bornOptions = { risks: ALIVE, manualBody: pregnancyAnchor({ year: 1015, month: 9, day: 1 }, { part: 9, known: true }) };

const sick = childChat([mk("хадеги", "date: 20 сольмануд 1015", "дитя занемогло")]);
const sickView = bodyView(readChat(sick, null, bornOptions).body, { year: 1015, month: 9, day: 22 }, {});
check("хворь перебивает обычную нужду", sickView.children[0].need, "хворает 2 дня");
check("и тревожит", sickView.children[0].alarm, true);

const well = childChat([
    mk("хадеги", "date: 20 сольмануд 1015", "дитя занемогло"),
    mk("хадеги", "date: 25 сольмануд 1015", "дитя поправилось"),
]);
const wellView = bodyView(readChat(well, null, bornOptions).body, { year: 1015, month: 9, day: 26 }, {});
check("поправилось — тревога ушла", wellView.children[0].alarm, false);

const toothed = childChat([mk("хадеги", "date: 20 сольмануд 1015", "зубок прорезался")]);
const toothView = bodyView(readChat(toothed, null, bornOptions).body, { year: 1015, month: 9, day: 21 }, {});
check("за первый зуб полагается таннфе",
    toothView.children[0].marks.some((m) => m.includes("таннфе")), true);
/* Веха — новость, а не статус: через неделю о ней уже не пишут. */
const toothLater = bodyView(readChat(toothed, null, bornOptions).body, { year: 1015, month: 10, day: 1 }, {});
check("а через неделю уже не новость", toothLater.children[0].marks.length, 0);

const named = childChat([{
    is_user: false, gen_finished: "nm", extra: {},
    mes: ["проза", "<!-- [URD:", "eykt: хадеги", "date: 5 сольмануд 1015",
        "child_name: Хельга", "weather: снег", "location: дом", "mood: ок", "] -->"].join("\n"),
}]);
const namedState = readChat(named, null, bornOptions);
check("имя из маркера легло на дитя", namedState.body.children[0].name, "Хельга");
check("и панель зовёт его по имени",
    bodyView(namedState.body, { year: 1015, month: 9, day: 6 }, {}).children[0].title, "Хельга");

const gone = childChat([mk("хадеги", "date: 20 сольмануд 1015", "дитя померло")]);
check("умершее дитя уходит из счёта",
    String(readChat(gone, null, bornOptions).body.children), "undefined");

/* Кровь заводит цикл заново, но уже рождённых детей она не отменяет. */
const bledAfter = childChat([
    mk("хадеги", "date: 20 хейаннир 1016", "отняли от груди"),
    mk("хадеги", "date: 25 хейаннир 1016", "кровь пришла"),
]);
check("новый цикл матери дитя не уносит",
    readChat(bledAfter, null, bornOptions).body.children?.length, 1);

/* ============================================================
 * Ручная беременность из Tímatal.
 *
 * Форма отдаёт движку точную дату зачатия, число дитяти и пол. Здесь
 * проверяется не разметка, а то, что из этих трёх полей выходит.
 * ============================================================ */

console.log("\n=== Ручная беременность: плод и пол ===");

const handToday = { year: 1015, month: 9, day: 20 };
const byHandPreg = (setup) => pregnancyAnchor(handToday, setup, null, { chatId: "t" }).body.pregnancy;

const singleHand = byHandPreg({ part: 5, known: true, births: 1, sex: "f" });
check("одно дитя, дочь", `${singleHand.births} ${singleHand.sexes.join(",")}`, "1 f");

const twoSons = byHandPreg({ part: 3, known: true, births: 2, sex: "m" });
check("двойня, оба сыновья", `${twoSons.births} ${twoSons.sexes.join(",")}`, "2 m,m");

const three = byHandPreg({ part: 9, known: true, births: 3, sex: "f" });
check("тройня, все дочери", `${three.births} ${three.sexes.join(",")}`, "3 f,f,f");

/* «Случайно» — не «оставить как было», а бросок по дате зачатия: он
   детерминированный, поэтому на одну дату всегда даёт одно и то же. */
const anyA = byHandPreg({ part: 4, known: true, births: 2, sex: null });
const anyB = byHandPreg({ part: 4, known: true, births: 2, sex: null });
check("случайный пол не пляшет между нажатиями", anyA.sexes.join(","), anyB.sexes.join(","));
check("и у каждого свой", new Set(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
        pregnancyAnchor(handToday, { part: 4, births: 2 }, null, { chatId: id }).body.pregnancy.sexes.join(","))
).size > 1, true);

check("больше тройни не бывает", byHandPreg({ part: 1, births: 9 }).births, 3);
check("меньше одного — тоже", byHandPreg({ part: 1, births: 0 }).births, 1);
/* Ноль — это «не назвали», значит жребий, а не пустой плод. */
check("и жребий даёт живое число", byHandPreg({ part: 1, births: 0 }).sexes.length, 1);

console.log("\n=== Ручная беременность: дата зачатия ===");

/* Часть срока и точная дата — одно и то же с разных концов. Форма держит их
   в согласии, а движок обязан принять любой из двух путей. */
const byPart = byHandPreg({ part: 5, known: true });
check("часть срока отсчитывается назад по тридцать дней",
    pregnancyTerm(byPart.conceived, handToday).days, 120);
check("и помечается вычисленной", byPart.guessedDate, true);

const exact = { year: 1015, month: 8, day: 10 };
const byDate = byHandPreg({ conceived: exact, part: 2, known: true });
check("точная дата берётся как есть",
    `${byDate.conceived.day}/${byDate.conceived.month}`, "10/8");
check("срок считается от неё", pregnancyTerm(byDate.conceived, handToday).days, 40);
check("и вычисленной не помечается", String(byDate.guessedDate), "false");

/* Якорь цикла ставится за две недели до зачатия — иначе панель показала бы
   кровь ровно в тот день, когда дитя взялось. */
check("кровь отсчитана назад от зачатия",
    daysSinceBleeding(pregnancyAnchor(handToday, { conceived: exact }, null, {}).body.lastBleed, exact), 13);

/* Уже случившееся правка срока не отменяет. */
const quickened = { year: 1015, month: 9, day: 1 };
const again = pregnancyAnchor(handToday, { part: 7, known: true },
    { conceived: exact, quickened, knownSince: quickened, father: "Змей" }, { chatId: "t" }).body.pregnancy;
check("шевеление переживает правку срока", again.quickened.day, 1);
check("и отец тоже", again.father, "Змей");

/* ============================================================
 * Тягота, угроза, потеря.
 *
 * Самая дорогая часть модуля: ошибка здесь стоит не строчки в панели,
 * а ребёнка. Поэтому проверяется и то, что беда случается, и — не менее
 * важно — что она НЕ случается на ровном месте.
 * ============================================================ */

console.log("\n=== Тягота ===");

check("«упала» узнаётся", parseBodyEvents("упала"), "fell");
check("«надорвалась»", parseBodyEvents("надорвалась"), "strained");
check("«подняла тяжёлое»", parseBodyEvents("подняла тяжёлое"), "heavy");
check("«побили»", parseBodyEvents("побили"), "beaten");
check("«легла пластом»", parseBodyEvents("легла пластом"), "rest");
check("«дитя родилось мёртвым»",
    String(parseBodyEvents("дитя родилось мёртвым")), "birth,stillborn");
/* «Слегла» занято хворью — одно слово на два смысла не годится вовсе. */
check("«слегла» — это хворь, а не постельный режим", parseBodyEvents("слегла"), "sott");

const strainDay = (d) => ({ year: 1015, month: 9, day: d });
const oneFall = [{ id: "fell", at: strainDay(1) }];
check("свежая тягота весит полностью", strainLoad(oneFall, strainDay(1)), 5);
check("и слабеет со временем", strainLoad(oneFall, strainDay(4)), 2);
check("а к своему сроку сходит на нет", strainLoad(oneFall, strainDay(6)), 0);
check("тяготы складываются",
    strainLoad([{ id: "fell", at: strainDay(1) }, { id: "beaten", at: strainDay(1) }], strainDay(1)), 11);

/* Кривая уязвимости: раньше всего теряют в первые недели, к середине срока
   утроба держит крепче всего, к концу встряска уже торопит роды. */
check("первые недели — самые хрупкие", termVulnerability(10) > termVulnerability(120), true);
check("середина срока — самая крепкая", termVulnerability(120) < termVulnerability(250), true);

console.log("\n=== Угроза ===");

const threatChat = (part, event, chatId) => {
    const chatRisk = [
        mk("хадеги", "date: 1 сольмануд 1015"),
        mk("хадеги", "date: 1 сольмануд 1015", event),
    ];
    syncWholeChat(chatRisk);
    return readChat(chatRisk, null, {
        chatId,
        risks: { threatScale: 50 },
        manualBody: pregnancyAnchor(strainDay(1), { part, known: true }, null, { chatId }),
    });
};

const early = threatChat(2, "упала", "th1");
check("тягота при дитяти даёт угрозу", !!early.body.pregnancy.threat, true);
check("на малом сроке исход — выкидыш", early.body.pregnancy.threat.outcome, "lost");
check("угроза видна в панели",
    bodyView(early.body, strainDay(1), {}).state, "threat");
check("и тревожит", bodyView(early.body, strainDay(1), {}).alarm, true);
/* Отлежится ли — решено, но панель об этом молчит: знать заранее, что всё
   напрасно, героине неоткуда. */
check("панель не выдаёт, спасётся ли",
    bodyView(early.body, strainDay(1), {}).extra.includes("попробовать"), true);

const lateRisk = threatChat(9, "надорвалась", "th2");
check("на сносях исход — роды раньше срока", lateRisk.body.pregnancy.threat.outcome, "labour");

/* Бросок детерминированный: свайп не переигрывает судьбу дитяти. */
check("угроза не пляшет между пересчётами",
    JSON.stringify(threatChat(2, "упала", "th1").body.pregnancy.threat),
    JSON.stringify(early.body.pregnancy.threat));
/* Судьба своя у каждой истории. Проверяем долю, а не шесть подряд взятых
   чатов: шесть могут случайно совпасть, и однажды совпали. */
const savedShare = (() => {
    let hits = 0, saved = 0;
    for (let i = 0; i < 400; i++) {
        const roll = rollThreat({
            chatId: `chat${i}`, today: strainDay(1), termDays: 30,
            load: 5, strainId: "fell", risks: { threatScale: 50 },
        });
        if (roll.hit) { hits++; if (roll.savable) saved++; }
    }
    return saved / hits;
})();
check("отлёживается примерно половина угроз", Math.abs(savedShare - 0.5) < 0.1, true);

/* Без беременности тягота ничего не рушит — только копится. */
const noPreg = (() => {
    const chatRisk = [mk("хадеги", "date: 1 сольмануд 1015"), mk("хадеги", "", "упала")];
    syncWholeChat(chatRisk);
    return readChat(chatRisk, null, { chatId: "th3", risks: { threatScale: 50 } }).body;
})();
check("небеременной тягота не грозит ничем", String(noPreg.pregnancy), "undefined");
check("но тело её помнит", noPreg.strain.length, 1);

console.log("\n=== Угроза сбывается ===");

/* Угроза висит свои два дня и разрешается сама — в общем проходе по чату,
   а не в панели: иначе выкидыш случился бы на экране, а в счёте цикла нет. */
const matured = (part, chatId, extra = []) => {
    const chatRisk = [
        mk("хадеги", "date: 1 сольмануд 1015"),
        mk("хадеги", "date: 1 сольмануд 1015", "упала"),
        ...extra,
        mk("хадеги", "date: 4 сольмануд 1015"),
    ];
    syncWholeChat(chatRisk);
    return readChat(chatRisk, null, {
        chatId,
        risks: { threatScale: 50 },
        manualBody: pregnancyAnchor(strainDay(1), { part, known: true }, null, { chatId }),
    });
};

const lostIt = matured(2, "th1");
check("на малом сроке дитя не удержалось", String(lostIt.body.pregnancy), "undefined");
check("потеря записана", lostIt.body.lastLoss.kind, "lost");
/* Четвёртое, а не третье: угроза поспела к третьему дню, но сбывается она
   на первом же сообщении, чья дата этот срок перешла. Между ходами время
   не идёт — идти ему негде. */
check("и цикл пошёл заново", lostIt.body.lastBleed.day, 4);
check("панель говорит о потере", bodyView(lostIt.body, strainDay(4), {}).state, "loss");
/* Горе не вечно: через девять дней панель возвращается к обычному счёту. */
check("а через полторы недели — уже нет",
    bodyView(lostIt.body, { year: 1015, month: 9, day: 20 }, {}).state, "cycling");

const preterm = matured(9, "th2");
check("на сносях начались схватки, а не роды", !!preterm.body.pregnancy?.labour, true);
check("и помечены недоношенными", preterm.body.pregnancy.early, true);
/* Сцену родов у ролевой не отбираем: дитя родится, когда сцена скажет. */
check("дитя ещё не родилось", String(preterm.body.children), "undefined");

console.log("\n=== Лечь пластом ===");

/* Половина угроз отлёживается. Какая именно — решено в тот же миг, что и сама
   угроза, чтобы «легла пластом» не стало кнопкой «отменить беду». */
const savableId = ["s1", "s2", "s3", "s4", "s5", "s6"].find(
    (id) => threatChat(2, "упала", id).body.pregnancy?.threat?.savable);
const doomedId = ["s1", "s2", "s3", "s4", "s5", "s6"].find(
    (id) => threatChat(2, "упала", id).body.pregnancy?.threat?.savable === false);
check("бывают угрозы, которые отлёживаются", !!savableId, true);
check("и бывают, которые нет", !!doomedId, true);

const rested = matured(2, savableId, [mk("хадеги", "date: 2 сольмануд 1015", "легла пластом")]);
check("легла пластом — дитя удержалось", !!rested.body.pregnancy, true);
check("и угрозы больше нет", String(rested.body.pregnancy.threat), "undefined");

const restedInVain = matured(2, doomedId, [mk("хадеги", "date: 2 сольмануд 1015", "легла пластом")]);
check("а когда не судьба — не помогает", String(restedInVain.body.pregnancy), "undefined");

console.log("\n=== Мертворождение ===");

const still = (days, load = 0) => rollStillbirth({
    chatId: "x", conceived: { year: 1015, month: 1, day: 1 }, termDays: days, load,
});
check("до шести месяцев не выживает никто", still(150).chance, 1);
check("семь месяцев — почти всегда потеря", still(VIABLE_DAY - 1).chance > 0.5, true);
check("восемь месяцев — уже надежда", still(VIABLE_DAY + 10).chance < 0.3, true);
check("в срок — как у всех", still(270).chance, STILLBIRTH.base);
check("тягота поднимает долю", still(270, 8).chance > still(270).chance, true);
check("но не делает её неизбежной", still(270, 8).chance < 0.5, true);

/* Сцена вправе объявить мертворождение сама — тогда бросок не спрашиваем. */
const declaredRisk = (() => {
    const chatRisk = [
        mk("хадеги", "date: 1 сольмануд 1015"),
        mk("хадеги", "date: 1 сольмануд 1015", "дитя родилось мёртвым"),
    ];
    syncWholeChat(chatRisk);
    return readChat(chatRisk, null, {
        chatId: "sb",
        risks: { stillbirth: { base: 0, preterm: 0, early: 0, perStrain: 0 } },
        manualBody: pregnancyAnchor(strainDay(1), { part: 9, known: true }, null, { chatId: "sb" }),
    }).body;
})();
check("объявленное сценой мертворождение сильнее броска",
    String(declaredRisk.children), "undefined");
check("и записано как потеря", declaredRisk.lastLoss.kind, "stillborn");

console.log("\n=== Призыв Фригг ===");

const carryingRisk = pregnancyAnchor(strainDay(1), { part: 9, known: true }, null, { chatId: "fr" });
const called = labourAnchor(strainDay(1), carryingRisk.body.pregnancy);
check("призыв ставит схватки", !!called.body.pregnancy.labour, true);
check("и помечает их призванными", called.body.pregnancy.summoned, true);
check("зачатие при этом не сдвигается",
    JSON.stringify(called.body.pregnancy.conceived),
    JSON.stringify(carryingRisk.body.pregnancy.conceived));
check("без беременности призывать нечего", String(labourAnchor(strainDay(1), null)), "null");

const summonView = bodyView(called.body, strainDay(1), {});
check("панель показывает схватки", summonView.titleHint, "Схватки");
check("промпту видно, что они только начались", summonView.labour.days, 0);
check("и что это призыв", summonView.labour.summoned, true);
/* Схватки перерастают угрозу: держать обе значило бы показывать две беды разом. */
const threatened = { ...carryingRisk.body.pregnancy, threat: { at: strainDay(1), outcome: "lost", savable: false } };
check("призыв снимает угрозу",
    String(labourAnchor(strainDay(1), threatened).body.pregnancy.threat), "undefined");

/* ============================================================
 * Женское питьё.
 *
 * Главное, что здесь проверяется, — не механика, а МОЛЧАНИЕ: наружу не должна
 * выходить разница между «прервало» и «прерывать было нечего». Женщина видит
 * одно и то же, и панель обязана показывать ей одно и то же.
 * ============================================================ */

console.log("\n=== Отвар: что растёт когда ===");

check("можжевельник есть круглый год",
    [1, 5, 9, 12].every((m) => herbsInSeason(m).some((h) => h.id === "einir")), true);
check("пижма только летом",
    herbsInSeason(9).some((h) => h.id === "reinfani") && !herbsInSeason(1).some((h) => h.id === "reinfani"), true);
check("рожки только к жатве",
    herbsInSeason(12).some((h) => h.id === "korn") && !herbsInSeason(9).some((h) => h.id === "korn"), true);
check("зимой одна трава", herbsInSeason(3).length, 1);

/* Траву не выбирают: выпадает по сезону и по жребию. Жребий тот же самый,
   что везде, — от чата и дня. */
const herbDay = { year: 1015, month: 12, day: 10 };
check("выбор травы не пляшет между вызовами",
    pickHerb("hz", herbDay).id, pickHerb("hz", herbDay).id);
check("в другой истории может выпасть другая",
    new Set(Array.from({ length: 40 }, (_, i) => pickHerb(`h${i}`, herbDay).id)).size > 1, true);

const ergotShare = (() => {
    let seen = 0;
    for (let i = 0; i < 600; i++) if (pickHerb(`e${i}`, herbDay).id === "korn") seen++;
    return seen / 600;
})();
check("рожки — редкость", ergotShare > 0.01 && ergotShare < 0.15, true);

console.log("\n=== Отвар: исходы ===");

const drinkOn = (chatId, body, today = herbDay, death = false) =>
    herbAnchor(today, body, { chatId, death }).body;

/* Небеременной отвар «срабатывает» всегда: кровь приходит, и героиня уверена,
   что трава помогла. Прерывать было нечего — но знать ей это неоткуда. */
const notCarrying = drinkOn("hn", { lastBleed: { year: 1015, month: 11, day: 20 }, disruption: { id: "hungr", at: herbDay } });
check("небеременной кровь приходит всегда", notCarrying.herb.worked, true);
check("и счётчик задержки сброшен", notCarrying.lastBleed.day, 10);
check("сбой цикла снят", String(notCarrying.disruption), "undefined");
check("скрытый слой знает правду", notCarrying.herb.wasPregnant, false);

/* Беременной — по броску травы. Ищем оба исхода. */
const carryingBody = (chatId) => pregnancyAnchor(herbDay, { part: 2, known: false }, null, { chatId }).body;
const ids = Array.from({ length: 30 }, (_, i) => `p${i}`);
const workedId = ids.find((id) => drinkOn(id, carryingBody(id)).herb.worked);
const failedId = ids.find((id) => !drinkOn(id, carryingBody(id)).herb.worked);
check("бывает, что прерывает", !!workedId, true);
check("бывает, что нет", !!failedId, true);

const interrupted = drinkOn(workedId, carryingBody(workedId));
check("прервало — беременности нет", String(interrupted.pregnancy), "undefined");
check("и цикл пошёл заново", interrupted.lastBleed.day, 10);
/* Потерю не записываем: героиня о ней не узнает, а панель молчит о том,
   чего героиня не знает. */
check("потеря не записана", String(interrupted.lastLoss), "undefined");
check("панель показывает обычный цикл",
    bodyView(interrupted, herbDay, {}).state, "cycling");

const survived = drinkOn(failedId, carryingBody(failedId));
check("не прервало — дитя цело", !!survived.pregnancy, true);
check("но отвар его достал", !!survived.pregnancy.herbExposure, true);
check("и трава записана", survived.pregnancy.herbExposure.id, survived.herb.id);

/* Самое важное: панель не выдаёт разницы. */
const seenByHer = (body) => {
    const v = bodyView(body, herbDay, {});
    return JSON.stringify({ status: v.draught?.status, title: v.draught?.title });
};
check("выпившая с дитятей и без видят одно и то же",
    seenByHer(drinkOn("same", carryingBody("same"))),
    seenByHer(drinkOn("same", { lastBleed: { year: 1015, month: 11, day: 20 } })));

console.log("\n=== Отвар: откат ===");

const tollOf = (id) => {
    const body = { lastBleed: herbDay, herb: { id, at: herbDay, worked: true, wasPregnant: false } };
    return { body, view: (d) => herbView(body.herb, { year: 1015, month: 12, day: 10 + d }) };
};
check("лёгкий откат держится два дня", String(tollOf("einir").view(3)), "null");
check("а на второй ещё виден", tollOf("einir").view(2).status, "Мутит. Голова кружится.");
check("средний — три", tollOf("malurt").view(3).status, "Рвота. Слабость.");
check("тяжёлый — пять", tollOf("reinfani").view(5).status, "Жар. Кровь идёт обильно.");

/* Кровь, пришедшая после отвара, откат не отменяет: она от него и пришла. */
const afterBlood = (() => {
    const chat = [
        mk("хадеги", "date: 10 хаустмануд 1015"),
        mk("хадеги", "date: 11 хаустмануд 1015", "кровь пришла"),
    ];
    syncWholeChat(chat);
    return readChat(chat, null, {
        chatId: "hb",
        manualBody: { at: herbDay, body: { lastBleed: herbDay, herb: { id: "reinfani", at: herbDay, worked: true, wasPregnant: false } } },
    }).body;
})();
check("«кровь пришла» не стирает откат", afterBlood.herb.id, "reinfani");

console.log("\n=== Спорынья: цена без тумблера смерти ===");

/*
 * Сорок пять процентов за две недели пластом и месяц пустой утробы — вот
 * настоящая расплата за рожки. Будь она вся на смертельном тумблере, который
 * выключен по умолчанию, спорынья была бы просто лучшей травой: знай жди осени.
 */
const korn = tollOf("korn");
check("откат почти втрое дольше пижмы",
    HERB_TOLLS.dire.days > HERB_TOLLS.heavy.days * 2, true);
check("на третий день ещё судороги", korn.view(3).status, "Жар, судороги. Силы ушли.");
check("на шестнадцатый — сухая хворь", korn.view(16).lingering, true);
check("и утроба всё ещё закрыта", herbBarren(korn.body.herb, { year: 1015, month: 12, day: 26 }), true);
check("а через месяц отпускает", String(korn.view(35)), "null");
check("у прочих трав бесплодия нет", HERB_TOLLS.light.barren + HERB_TOLLS.mid.barren + HERB_TOLLS.heavy.barren, 0);

/* Закрытая утроба — не украшение: зачатие в эти дни не случается вовсе. */
const barrenTry = (() => {
    const chat = [
        mk("хадеги", "date: 10 хаустмануд 1015"),
        {
            is_user: false, gen_finished: "bt", extra: {},
            mes: ["проза", "<!-- [URD:", "eykt: хадеги", "date: 20 хаустмануд 1015",
                "sex: да", "internal: да", "weather: снег", "location: дом", "mood: ок", "] -->"].join("\n"),
        },
    ];
    syncWholeChat(chat);
    return readChat(chat, null, {
        chatId: "bt",
        chances: { base: 1, phase: {}, withheld: 1 },
        manualBody: { at: herbDay, body: { lastBleed: herbDay, herb: { id: "korn", at: herbDay, worked: true, wasPregnant: false } } },
    }).body;
})();
check("после рожков не понесёт даже при шансе 1", String(barrenTry.pregnancy), "undefined");

/* Смертельный исход — только у рожков и только по тумблеру. */
const fatalOf = (herb, death) => rollHerb({
    chatId: "dz", today: herbDay, herb: HERBS[herb], pregnant: true, death,
}).fatal;
check("без тумблера не убивает никого", [...Object.keys(HERBS)].some((h) => fatalOf(h, false)), false);
check("с тумблером — только рожки",
    ["einir", "malurt", "reinfani"].some((h) => fatalOf(h, true)), false);
const deathShare = (() => {
    let dead = 0;
    for (let i = 0; i < 500; i++) {
        if (rollHerb({ chatId: `dd${i}`, today: herbDay, herb: HERBS.korn, pregnant: true, death: true }).fatal) dead++;
    }
    return dead / 500;
})();
check("и то не всякий раз", deathShare > 0.05 && deathShare < 0.2, true);

console.log("\n" + "─".repeat(60));
console.log(`Пройдено: ${ok}   Провалено: ${bad}`);
process.exit(bad ? 1 : 0);
