/*
 * NORNIR — женский цикл и срок ношения по скандинавскому счёту.
 *
 * Это напоминалка, а не трекер тела. День цикла и беременность выставляет
 * автор в Tímatal, а дальше панель только считает от календаря: какой сегодня
 * день цикла и какая фаза, какая часть ношения и когда ждать. Модель сюда
 * ничего не сообщает — ни крови, ни близости, ни родов, — и ничего здесь
 * не решается броском. Что с героиней дальше, отыгрывает ролевая.
 *
 * Так было не всегда. Прежний модуль вёл зачатие, приметы тела, угрозу,
 * роды, послеродовое и детей до двух лет — и всё это уходило модели в
 * контекст, где мешало ролевой больше, чем помогало. Та версия целиком
 * лежит в ветке testik.
 *
 * Модели отсюда уходит одна строка, и только когда есть что сказать: идёт
 * кровь или героиня носит. В обычный день цикла она молчит (см. bodyView).
 *
 * ОГОВОРКА ПРО ДОСТОВЕРНОСТЬ. Названия фаз — hreinsun, vaxandi, þverrandi —
 * сконструированы по образцу языка, источников на них нет: тема в саги просто
 * не попадала. Засвидетельствованы blóðfall («кровотечение») и tíðir в позднем
 * исландском.
 */

import { addDays, isAuk, serialOf } from "./parser.js";

/* ============================================================
 * 1. ЦИКЛ
 * ============================================================ */

/**
 * Двадцать восемь дней, и это не настройка.
 *
 * Настройкой она побыла ровно один круг и успела сохраниться со значением 30.
 * Тридцатка ловко маскировалась: таймскип в три месяца — это девяносто дней,
 * то есть три полных оборота, и цикл возвращался на тот же день, будто застыл.
 * Фазы расписаны от первого дня до двадцать восьмого, так что и длина одна.
 */
export const CYCLE_DEFAULT = 28;

/**
 * Фазы цикла.
 *
 * К Луне цикл НЕ привязан, и это решение, а не упущение. Фазу Луны считает
 * календарь, у неё своя цепочка вычислений от даты сцены, и вешать на ту же
 * дату второй счёт — значит связать две сущности, которые в жизни не совпадают
 * (лунный месяц 29,5 дня, цикл 28). Здесь свой счёт, от последней крови.
 *
 * `to: null` — до конца цикла, какой бы длины он ни был.
 *
 * `status` — то, что видно в панели с одного взгляда. `hint` — что за этим
 * стоит, показывается по клику. Названия фаз, статусы и пояснения заданы
 * пользователем: это её сеттинг и её словарь, менять их «покрасивее» нельзя.
 * Модели они не уходят — ни статус, ни пояснение.
 */
export const CYCLE_PHASES = [
    {
        id: "tidir",
        norse: "Tíðir", ru: "Дни крови",
        from: 1, to: 5,
        status: "Кровь идёт.",
        hint: "Тело холодеет и очищается. Дитя сейчас не возьмётся. Силы покидают утробу.",
    },
    {
        id: "hreinsun",
        norse: "Hreinsun ok Vaxandi", ru: "Очищение и Рост",
        from: 6, to: 11,
        status: "Тело сохнет. Сила прибывает.",
        hint: "Лоно очистилось и затягивается после крови. Лоно сухое, но согревается. Дитя ещё не возьмётся.",
    },
    {
        id: "opit",
        norse: "Opit ok Heitt", ru: "Открытое и Горячее лоно",
        from: 12, to: 16,
        status: "Лоно открыто. Фрейя близко.",
        hint: "Тело тёплое и сочащееся влагой. Самое время для семени. Лоно готово принять дитя.",
    },
    {
        id: "thverrandi",
        norse: "Þverrandi", ru: "Тяжелеющее лоно",
        from: 17, to: null,
        status: "Лоно затворилось. Тяжесть в чреве.",
        hint: "Тело закрылось и тяжелеет. Лоно ждёт — зародилась ли в нём жизнь или кровь снова прольётся на землю.",
    },
];

/** Длина цикла в разумных пределах: короче двадцати и длиннее сорока не бывает. */
export function normalizeCycleLength(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return CYCLE_DEFAULT;
    return Math.min(40, Math.max(20, Math.round(n)));
}

/**
 * День цикла, считая от последней крови.
 *
 * Кровь пришла — значит день первый. Дальше по кругу: цикл, на который никто
 * не обратил внимания в игре, просто повторяется. Задержек панель не ведёт —
 * их, если надо, отыгрывает ролевая, а счёт правится рукой в Tímatal.
 *
 * @returns {number|null} 1..length, либо null если крови ещё не было
 */
export function cycleDay(lastBleed, today, length = CYCLE_DEFAULT) {
    if (!lastBleed || !today) return null;
    const len = normalizeCycleLength(length);
    const passed = serialOf(today.year, today.month, today.day)
        - serialOf(lastBleed.year, lastBleed.month, lastBleed.day);
    if (passed < 0) return null;
    return (passed % len) + 1;
}

/** Фаза по дню цикла. */
export function phaseOf(day, length = CYCLE_DEFAULT) {
    if (day == null) return null;
    const len = normalizeCycleLength(length);
    for (const phase of CYCLE_PHASES) {
        const to = phase.to ?? len;
        if (day >= phase.from && day <= to) return phase;
    }
    return CYCLE_PHASES[CYCLE_PHASES.length - 1];
}

/**
 * Сводка по циклу на день сцены.
 *
 * @param {{lastBleed: object|null}} body Состояние тела, донесённое по чату
 * @param {object} today Дата сцены
 * @param {number} length Длина цикла
 */
export function cycleSummary(body, today, length = CYCLE_DEFAULT) {
    const day = cycleDay(body?.lastBleed, today, length);
    if (day == null) return null;
    const phase = phaseOf(day, length);
    return { day, length: normalizeCycleLength(length), phase };
}

/* ============================================================
 * 2. НОШЕНИЕ
 *
 * Слова «луна» здесь нет и быть не должно: оно занято календарём, где Tungl
 * считается своей цепочкой от даты сцены. Срок называется НОШЕНИЕМ и меряется
 * девятками: «Ношение: 3/9».
 *
 * Девять частей по тридцать дней — 270 суток. В нашем календаре месяц ровно
 * тридцатидневный, так что народный счёт совпадает с арифметикой и переводить
 * недели ни во что не надо.
 * ============================================================ */

export const TERM_DAYS = 270;
export const TERM_PARTS = 9;

/** Шевеление обычно чувствуют на пятой части. */
const QUICKENING_DAY = 130;

/** С четвёртой части живот уже не спрятать — это видно всякому. */
export const OBVIOUS_DAY = 90;

/** Последняя часть ношения — «подошедшая к падению». */
const LAST_PART_DAY = TERM_DAYS - 30;

/*
 * Стадии — только заголовок панели. Счёт ведёт день от зачатия, а не события:
 * шевеление здесь не сообщается, оно наступает по сроку.
 */
export const PREGNANCY_STAGES = [
    {
        id: "dulid", norse: "Dulið", ru: "Сокрытое",
        status: "Носит дитя. Оно ещё не подало голоса.",
        hint: "Дитя пока не шевелилось — о нём не говорят вслух и срока не считают.",
    },
    {
        id: "kviknat", norse: "Kviknat", ru: "Ожившее",
        status: "Дитя шевельнулось. Оно живое.",
        hint: "С первого движения дитя считают живым, и говорить о нём вслух теперь можно. Отсюда и ведут счёт сроку.",
    },
    {
        id: "falli", norse: "Komin at falli", ru: "Подошедшая к падению",
        status: "Тело тяжело. Срок близок.",
        hint: "Последняя часть срока. Живот опустился, спина ломит, дитя ворочается редко и грузно.",
    },
];

/**
 * Часть ношения, 1..9 и дальше, если переносила.
 *
 * Считаем от зачатия. Первый день — уже первая часть: женщина не считает
 * с нуля.
 */
export function pregnancyTerm(conceived, today) {
    if (!conceived || !today) return null;
    const days = serialOf(today.year, today.month, today.day)
        - serialOf(conceived.year, conceived.month, conceived.day);
    if (days < 0) return null;
    return { days, part: Math.floor(days / 30) + 1 };
}

/*
 * Родительный падеж месяцев — таблицей, а не правилом.
 *
 * Правило тут не выводится: гормануд → гормануда, но харпа → харпы, а торри
 * и гои не склоняются вовсе. Двенадцать строк дешевле попытки угадать окончание.
 */
const MONTH_GENITIVE = [
    "гормануда", "юлира", "морсуга", "торри", "гои", "эйнмануда",
    "харпы", "скерплы", "сольмануда", "хейаннира", "твимануда", "хаустмануда",
];

/**
 * Когда ждать — не датой, а вехой года.
 *
 * Повитуха недель не считает и числа не называет. Разброс намеренный:
 * назвать точный день значило бы соврать про то, чего в XI веке не знали.
 */
export function dueWords(conceived) {
    const due = addDays(conceived.year, conceived.month, conceived.day, TERM_DAYS);
    if (isAuk(due.month)) return "к самой середине лета, на аукнэтр";
    const part = due.day <= 10 ? "к началу" : due.day <= 20 ? "к середине" : "к исходу";
    return `${part} ${MONTH_GENITIVE[due.month - 1]}`;
}

/**
 * Сводка по ношению.
 *
 * @param {{conceived: object}} pregnancy
 * @param {object} today Дата сцены
 */
export function pregnancySummary(pregnancy, today) {
    if (!pregnancy?.conceived) return null;
    const counted = pregnancyTerm(pregnancy.conceived, today);
    if (!counted) return null;

    const { days, part } = counted;
    const stage = days >= LAST_PART_DAY ? PREGNANCY_STAGES[2]
        : days >= QUICKENING_DAY ? PREGNANCY_STAGES[1]
            : PREGNANCY_STAGES[0];

    return {
        days,
        part,
        stage,
        overdue: days >= TERM_DAYS,
        due: dueWords(pregnancy.conceived),
    };
}

/* ============================================================
 * 3. СТРОКА ДЛЯ МОДЕЛИ
 *
 * Чего модель знает о теле героини, решает одно правило: то, что героиня
 * знает о себе сама и о чём сцена может вспомнить к слову. Это две вещи —
 * идёт кровь и носит дитя. Фазы цикла, приметы, пояснения — для панели.
 *
 * Срок отдаётся словом, а не дробью. «5/9» модель принимается пересчитывать
 * вслух; «идёт пятый месяц» так говорит и сама героиня.
 * ============================================================ */

const MONTH_ORDINALS = [
    "первый", "второй", "третий", "четвёртый", "пятый",
    "шестой", "седьмой", "восьмой", "девятый",
];

/** Строка о крови — только в дни тидир, в прочие дни цикла модели нечего знать. */
function cyclePhrase(summary) {
    if (summary?.phase.id !== "tidir") return null;
    return "У {{user}} сейчас тидир — идёт месячная кровь.";
}

/** Строка о ношении: какой месяц и видно ли это со стороны. */
function pregnancyPhrase(summary) {
    if (!summary) return null;
    if (summary.overdue) {
        return "{{user}} носит дитя, и срок уже вышел: роды могут начаться со дня на день.";
    }
    const month = MONTH_ORDINALS[Math.min(summary.part, TERM_PARTS) - 1];
    const seen = summary.days >= OBVIOUS_DAY ? "Живот уже виден." : "По ней этого пока не видно.";
    return `{{user}} носит дитя: идёт ${month} месяц из девяти. ${seen}`;
}

/* ============================================================
 * 4. ВИД
 *
 * Одна точка сборки на всё: и панель, и строка для модели, и Tímatal берут
 * данные отсюда. Разложить их по местам в двух разных функциях значило бы
 * рано или поздно показать в панели одно, а модели сказать другое.
 * ============================================================ */

/**
 * @param {{lastBleed?: object, pregnancy?: {conceived: object}}|null} body
 *        Состояние тела с конца чата
 * @param {object} today Дата сцены
 *
 * `icon` и `extraIcon` — имена файлов в `icons/`, без пути и расширения:
 * панель рисует их маской, а решает, какой знак у какого состояния, всё-таки
 * тело, а не раскладка.
 *
 * @returns {{state: "cycling"|"pregnant", icon, title, titleHint, count,
 *   status, statusHint, extra, extraIcon, phrase}|null}
 */
export function bodyView(body, today) {
    if (!body || !today) return null;

    const pregnancy = pregnancySummary(body.pregnancy, today);
    if (pregnancy) {
        return {
            state: "pregnant",
            icon: `phase-${pregnancy.stage.id}`,
            title: pregnancy.stage.norse,
            titleHint: pregnancy.stage.ru,
            count: `Ношение: ${Math.min(pregnancy.part, TERM_PARTS)}/${TERM_PARTS}`,
            status: pregnancy.overdue ? "Срок вышел. Дитя может прийти со дня на день." : pregnancy.stage.status,
            statusHint: pregnancy.stage.hint,
            extra: `Ждать ${pregnancy.due}`,
            extraIcon: "body-due",
            phrase: pregnancyPhrase(pregnancy),
        };
    }

    const cycle = cycleSummary(body, today);
    if (!cycle) return null;
    return {
        state: "cycling",
        icon: `phase-${cycle.phase.id}`,
        title: cycle.phase.norse,
        titleHint: cycle.phase.ru,
        count: `${cycle.day}/${cycle.length}`,
        status: cycle.phase.status,
        statusHint: cycle.phase.hint,
        extra: null,
        extraIcon: null,
        phrase: cyclePhrase(cycle),
    };
}
