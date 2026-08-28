/*
 * NORNIR — уведомления.
 *
 * Своей системы уведомлений здесь нет и не будет: показывает их таверна
 * (toastr), а этот модуль только считает, О ЧЁМ говорить. Он чистый — ни
 * DOM, ни SillyTavern, — и потому проверяется тестами наравне с календарём
 * и телом.
 *
 * Модель работы та же, что у всего расширения: своего «текущего момента» мы
 * не храним. На каждом такте снимается СЛЕПОК того, за чем следим (день,
 * эйкта, Луна, месяц, праздник, фаза цикла, состояние утробы), и сравнивается
 * с предыдущим. Что изменилось — о том и уведомляем.
 *
 * Отсюда два следствия, ради которых всё и сделано так:
 *
 *  - свайпы, откат и правка сообщений работают сами собой. Откатились на ход
 *    назад — слепок стал прежним, никаких «событий» подчищать не надо;
 *  - первый такт после открытия чата молчит. Сравнивать не с чем, и без этого
 *    правила таверна встречала бы каждый вход в чат пачкой уведомлений о том,
 *    что и так на экране. За молчание отвечает noticesBetween: нет прошлого
 *    слепка — нет уведомлений.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Kinds .............. Виды уведомлений и набор по умолчанию
 * 2. Wording ............ Строки: день недели, дата, строка дня
 * 3. Snapshot ........... Слепок наблюдаемого
 * 4. Diff ............... Что изменилось между двумя слепками
 */

import {
    EYKTIR,
    MONTHS,
    WEEKDAYS,
    aukDays,
    eyktForHour,
    isAuk,
    moonPhase,
    seasonOf,
    serialOf,
    weekdayOf,
} from "./parser.js";

import { holidayView } from "./holidays.js";

/* ============================================================
 * 1. KINDS
 * ============================================================ */

/*
 * Виды уведомлений.
 *
 * Список, а не набор флагов в настройках, — по той же причине, по какой
 * списком сделаны слои праздников: их включают наборами, и добавить девятый
 * вид не должно значить добавить девятую настройку.
 *
 * `icon` — знак в заголовке уведомления. Подписи здесь нет нарочно: их
 * переводит i18n в момент отрисовки, а модуль обязан оставаться чистым.
 * Подписи лежат в reference.js, рядом с самой галочкой.
 */
export const NOTICE_KINDS = [
    { id: "day",    icon: "🌅" },
    { id: "eykt",   icon: "🧭" },
    { id: "moon",   icon: "🌕" },
    { id: "season", icon: "🌿" },
    { id: "feast",  icon: "🔥" },
    { id: "cycle",  icon: "🩸" },
    { id: "body",   icon: "🤰" },
    { id: "marker", icon: "ᚱ" },
];

export const NOTICE_IDS = NOTICE_KINDS.map((k) => k.id);

/*
 * По умолчанию — только то, о чём просили: день и фаза цикла. Остальное
 * добирается галочками. Уведомление, пришедшее без спросу, выключают вместе
 * со всеми остальными, поэтому лишнего в наборе быть не должно.
 */
export const DEFAULT_NOTICES = ["day", "cycle"];

const ICONS = Object.fromEntries(NOTICE_KINDS.map((k) => [k.id, k.icon]));

/** Фазу цикла ведёт вид «cycle», всё прочее в утробе — вид «body». */
const CYCLE_STATES = ["cycling", "late"];

/*
 * Состояния, о которых панель молчит по замыслу, — и уведомления молчат тоже.
 *
 * Скрытая беременность: зачатие уже в данных, но героиня о нём не знает.
 * Всплывашка в день соития выдала бы кубик с головой, а дальше приходила бы
 * каждые сутки: заголовком у этого состояния служит счётчик дней задержки,
 * и он тикает. Ни того, ни другого быть не должно.
 *
 * Вместо этого голос подаёт задержка — см. lateDays ниже. Женщина замечает,
 * что крови нет; причины она не знает, и уведомление её не называет.
 */
const HIDDEN_STATES = ["pregnant_unknown"];

/** За сколько дней предупреждать о приближении праздника. */
export const FEAST_WARNING_DAYS = 3;

/* ============================================================
 * 2. WORDING
 * ============================================================ */

/**
 * Имя дня недели одним словом.
 *
 * В таблице у дня стоит пояснение целиком («День Тора», а у лаугардага —
 * «„Банный день“ — день омовения»). В строку дня идёт только его начало:
 * уведомление — не справочник, длинного пояснения в нём никто не читает.
 */
export function weekdayName(index) {
    const day = WEEKDAYS[index];
    if (!day) return "";
    return day.desc.split("—")[0].replace(/[«»„“”"]/g, "").trim();
}

/** «7 Юлир 998», а во вставные дни — «Сумарауки, 2-й из 4». */
export function dateLine(date) {
    if (!date || date.year == null) return "";
    const { year, month, day } = date;
    if (isAuk(month)) return `Сумарауки, ${day}-й из ${aukDays(year)}`;
    return `${day} ${MONTHS[month - 1].ru} ${year}`;
}

/**
 * Строка дня — то, ради чего уведомления и заводились.
 *
 * «Хадеги · 7 Юлир 998 · День Тора · Йоль». Порядок частей от ближнего
 * к дальнему: который час, какое число, какой день недели, что за день.
 * Чего нет — то молчит: без времени в маркере не будет эйкты, в будни не
 * будет праздника.
 */
export function dayLine(snap) {
    if (!snap?.has) return "";
    return [
        snap.eykt != null ? EYKTIR[snap.eykt].ru : null,
        dateLine(snap.date),
        snap.weekday != null ? weekdayName(snap.weekday) : null,
        snap.feasts[0]?.ru ?? null,
    ].filter(Boolean).join(" · ");
}

/* ============================================================
 * 3. SNAPSHOT
 * ============================================================ */

/**
 * Слепок того, за чем следят уведомления.
 *
 * Считается из тех же данных, что и панель, и ничего своего не выдумывает:
 * дата и час приходят из маркера, праздники и Луна — из календаря, утроба —
 * из готовой сводки bodyView.
 *
 * @param {object} input
 * @param {object|null} input.scene Снимок сцены: year, month, day, hour
 * @param {object|null} input.view Сводка по телу (bodyView), либо null
 * @param {boolean} input.holidays Считать ли праздники (настройка расширения)
 * @param {object} input.holidayOpts Слои достоверности и край света
 * @param {boolean} input.stale Последний ответ пришёл без маркера
 * @returns {object} Слепок; сравнивать его следует только с другим слепком
 */
export function watchSnapshot(input = {}) {
    const {
        scene = null,
        view = null,
        holidays = false,
        holidayOpts = {},
        stale = false,
    } = input;

    const has = !!scene && scene.year != null && scene.month != null && scene.day != null;
    const date = has ? { year: scene.year, month: scene.month, day: scene.day } : null;
    const auk = has && isAuk(date.month);

    const snap = {
        has,
        date,
        serial: has ? serialOf(date.year, date.month, date.day) : null,
        eykt: scene?.hour != null ? eyktForHour(scene.hour) : null,
        /* У вставных дней своего дня недели нет: они стоят между неделями
           и в счёт не входят. Поэтому здесь null, а не выдуманный лаугардаг. */
        weekday: has && !auk ? weekdayOf(date.year, date.month, date.day) : null,
        month: has ? date.month : null,
        season: has ? seasonOf(date.month).norse : null,
        auk,
        moon: null,
        feasts: [],
        soon: null,
        /* Утробу держим двумя полями: по `bodyState` видно, чья это новость —
           цикла или ношения, по `mark` — сменилось ли положение дел. Счёт
           дней («12/28») в метку не входит нарочно: он меняется каждые сутки,
           и уведомление приходило бы ежедневно вместо смены фазы. */
        bodyState: view?.state ?? null,
        mark: view ? `${view.state}|${view.title ?? ""}|${view.labour ? "labour" : ""}` : null,
        title: view?.title ?? null,
        hint: view?.titleHint ?? null,
        status: view?.status ?? null,
        count: view?.count ?? null,
        /* Число, а не строка: по строке «кровь не приходила 29 дней» нельзя
           понять, первый ли это день задержки, — она меняется каждые сутки. */
        lateDays: view?.lateDays ?? null,
        /*
         * Шевеление и отвар живут отдельно от главной метки.
         *
         * У них своя новость и свои слова, и подмешивать их в `mark` нельзя:
         * тогда «дитя притихло» пришло бы под заголовком стадии ношения.
         * В метку берём настроение, а не строку: строка считает дни («тихо
         * три дня») и менялась бы каждые сутки.
         */
        kicks: view?.kicks
            ? { mood: view.kicks.alarm ? "alarm" : "calm", text: view.kicks.text }
            : null,
        draught: view?.draught
            ? {
                mark: `${view.draught.id}|${view.draught.lingering ? "after" : "toll"}`,
                title: view.draught.title,
                status: view.draught.status,
            }
            : null,
        stale: !!stale,
    };

    if (has && !auk) {
        snap.moon = moonPhase(date.year, date.month, date.day).phase.norse;
    }

    if (has && holidays) {
        const feast = holidayView(date.year, date.month, date.day, holidayOpts);
        if (feast && !feast.none) {
            snap.feasts = [
                { id: feast.id, norse: feast.norse, ru: feast.ru, gloss: feast.gloss },
                /* У прочих праздников этих же суток id наружу не отдаётся —
                   различаем их по имени, оно уникально не хуже. */
                ...feast.others.map((o) => ({ id: o.norse, norse: o.norse, ru: o.ru, gloss: o.gloss })),
            ];
        }
        if (feast?.next) {
            snap.soon = { ru: feast.next.ru, norse: feast.next.norse, days: feast.next.days };
        }
    }

    return snap;
}

/* ============================================================
 * 4. DIFF
 * ============================================================ */

function notice(kind, text, title = null, level = "info") {
    return { kind, icon: ICONS[kind], title, text, level };
}

/** Склоняет «день / дня / дней». */
function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/**
 * Что изменилось между двумя слепками.
 *
 * @param {object|null} prev Прошлый слепок; null — первый такт, молчим
 * @param {object|null} next Нынешний слепок
 * @param {string[]} kinds Включённые виды уведомлений
 * @returns {Array<{kind, icon, title, text, level}>} По порядку показа
 */
export function noticesBetween(prev, next, kinds = DEFAULT_NOTICES) {
    if (!prev || !next) return [];
    const on = (id) => kinds.includes(id);
    const out = [];

    /* Пропавший маркер — единственное, о чём стоит сказать и без даты:
       панель молчит именно потому, что ей нечего сказать. */
    if (on("marker") && next.stale && !prev.stale) {
        out.push(notice(
            "marker",
            "Ответ пришёл без инфоблока — панель осталась на прежнем ходу.",
            null,
            "warning",
        ));
    }

    if (!next.has) return out;

    const dayChanged = next.serial !== prev.serial;

    /* ── День ── */
    if (on("day") && dayChanged) {
        out.push(notice("day", dayLine(next)));
    }

    /* ── Эйкта ──
       Внутри суток эйкта — единственное, что двигается, и о ней говорим
       отдельно. Но если день уже назван, повторять его час незачем: он
       стоит первым словом в строке дня. */
    if (on("eykt") && next.eykt != null && next.eykt !== prev.eykt
        && !(on("day") && dayChanged)) {
        const eykt = EYKTIR[next.eykt];
        out.push(notice("eykt", `${eykt.ru} — ${eykt.desc.toLowerCase()}`));
    }

    /* ── Луна ── */
    if (on("moon") && next.moon && next.moon !== prev.moon) {
        const { phase } = moonPhase(next.date.year, next.date.month, next.date.day);
        out.push(notice("moon", `${phase.icon} ${phase.ru} — ${phase.desc}`, phase.norse));
    }

    /* ── Поворот года ──
       Полугодие важнее месяца, месяц важнее вставных дней: о первом дне зимы
       говорят «пришла зима», а не «настал Гормануд». Поэтому ветки взаимно
       исключающие — три уведомления об одном дне не нужны. */
    if (on("season") && dayChanged) {
        if (next.season !== prev.season) {
            const winter = next.season === "Vetr";
            out.push(notice(
                "season",
                winter
                    ? "Первый день зимы. Год повернул: Gormánuðr, месяц забоя."
                    : "Первый день лета. Год повернул: Harpa, месяц пробуждения.",
                winter ? "Vetr" : "Sumar",
            ));
        } else if (next.auk && !prev.auk) {
            const days = aukDays(next.date.year);
            out.push(notice(
                "season",
                `Вставные дни в середине лета: ${days} ${plural(days, "сутки", "суток", "суток")} перед сенокосом.`,
                "Auknætr",
            ));
        } else if (next.month !== prev.month && !next.auk) {
            const m = MONTHS[next.month - 1];
            out.push(notice("season", `${m.ru} — ${m.gloss}`, m.norse));
        }
    }

    /* ── Праздники ──
       Праздник вчерашний и праздник сегодняшний различаются только именем:
       у трёхдневного Йоля id все три дня один, и уведомление приходит один
       раз — в первый его день. */
    if (on("feast")) {
        const was = new Set(prev.feasts.map((f) => f.id));
        for (const feast of next.feasts) {
            if (was.has(feast.id)) continue;
            out.push(notice("feast", `${feast.ru} — ${feast.gloss}`, feast.norse, "success"));
        }

        /* Предупреждение — один раз на праздник: в тот такт, когда до него
           стало три дня или меньше. Таймскип через порог тоже считается. */
        const { soon } = next;
        const before = prev.soon;
        const crossed = soon
            && soon.days > 0
            && soon.days <= FEAST_WARNING_DAYS
            && (!before || before.norse !== soon.norse || before.days > FEAST_WARNING_DAYS);
        if (crossed) {
            out.push(notice(
                "feast",
                `${soon.ru} — через ${soon.days} ${plural(soon.days, "день", "дня", "дней")}.`,
                soon.norse,
            ));
        }
    }

    /* ── Задержка ──
     *
     * Голос вместо молчания скрытого состояния.
     *
     * Отсутствие крови месяц и дольше женщина замечает в любом веке: тидир
     * ходили всю её жизнь раз в месяц, и не заметить их отсутствия нельзя.
     * Чего она не знает — так это причины: дитя, хворь, голод, дорога. Мы
     * говорим ровно то, что ей видно, и ни слова о причине.
     *
     * Один раз, а не каждые сутки: считаем не строку со счётчиком, а сам
     * переход «задержки не было → задержка есть».
     *
     * Только в скрытом состоянии: при названном сбое о задержке и так
     * сказано своим уведомлением, вместе с причиной, которую героиня знает.
     */
    if (on("cycle")
        && next.lateDays != null
        && prev.lateDays == null
        && HIDDEN_STATES.includes(next.bodyState)) {
        out.push(notice(
            "cycle",
            `Кровь не приходила ${next.lateDays} ${plural(next.lateDays, "день", "дня", "дней")}.`,
            "Tíðir",
        ));
    }

    /* ── Утроба ──
       Оба вида читают одну метку, но разные её половины: цикл — свои
       состояния, ношение и всё прочее — остальные. Так «Tíðir» не приходит
       беременной, а «Схватки начались» не приходит вместо смены фазы. */
    if (next.mark && next.mark !== prev.mark && !HIDDEN_STATES.includes(next.bodyState)) {
        const isCycle = CYCLE_STATES.includes(next.bodyState);
        const kind = isCycle ? "cycle" : "body";
        if (on(kind)) {
            /*
             * Счёт дней прячем ровно у одного состояния — счёта цикла.
             *
             * Там это «12/28», голая дробь без слова, да ещё и меняющаяся
             * каждые сутки. У всех прочих счёт — часть новости: «Ношение:
             * 4/9» у ношения, «Кровь не приходила: 40 дней» у сбоя. Задержка
             * от названной причины должна сообщать столько же, сколько
             * задержка без причины, — иначе по одной короткой строке видно,
             * что причины нет, а это уже подсказка.
             */
            const head = [next.hint, next.bodyState === "cycling" ? null : next.count]
                .filter(Boolean).join(" · ");
            out.push(notice(
                kind,
                [head, next.status].filter(Boolean).join(". "),
                next.title,
                next.bodyState === "threat" || next.bodyState === "loss" ? "warning" : "info",
            ));
        }
    }

    /* ── Дитя и отвар ──
       Обе новости идут под видом «утроба», какой бы ни была главная метка:
       отвар пьют и не нося дитя, а шевеление важнее стадии срока. */
    if (on("body")) {
        const mood = next.kicks?.mood ?? null;
        if (mood && mood !== (prev.kicks?.mood ?? null)) {
            out.push(notice("body", `${next.kicks.text}.`, null, mood === "alarm" ? "warning" : "info"));
        }

        const drank = next.draught?.mark ?? null;
        if (drank && drank !== (prev.draught?.mark ?? null)) {
            out.push(notice("body", next.draught.status, next.draught.title, "warning"));
        }
    }

    return out;
}
