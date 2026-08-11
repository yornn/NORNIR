/* ============================================================
 * Norse Calendar — праздники года.
 *
 * Отдельный модуль, а не таблица в parser.js, по той же причине, по какой
 * тело живёт в body.js: календарь считает дни, а праздники — это уже знание
 * о мире, со своими источниками, оговорками и слоями достоверности. Считать
 * их календарю незачем, а вот дни у него они берут.
 *
 * ГЛАВНОЕ ПРАВИЛО ДАТ: праздник привязан не к числу, а к дню недели внутри
 * месяца. Зимние ночи — первая суббота гормануда, Sumarmál — первый четверг
 * харпы, Þorri начинается в пятницу, Góa — в воскресенье. Так считали на
 * самом деле, и без этого даты поплыли бы от года к году.
 *
 * В нашем календаре у этого правила есть приятное следствие. Год всегда
 * состоит из целых недель (364 = 52 vika, а в год сумарауки 371 = 53), и
 * начинается всегда с Laugardagr. Поэтому день недели у любого числа один
 * и тот же во всяком году:
 *
 *     1 Gormánaður  — Laugardagr (суббота)
 *     1 Þorri       — Frjádagr   (пятница)
 *     1 Góa         — Sunnudagr  (воскресенье)
 *     1 Harpa       — Þórsdagr   (четверг)
 *
 * То есть исторические правила ложатся на этот календарь без единой натяжки:
 * первая суббота гормануда — это и есть первое гормануда. Совпадение не
 * случайное — оно следует из устройства мисcери, — но проверяется тестом
 * (test-holidays.mjs), а не принимается на веру: стоит кому-нибудь тронуть
 * длину аукнэтр, и правило рассыплется молча.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: выдуманных праздников. Каждая строка таблицы либо названа
 * в источнике, либо честно помечена как реконструкция.
 * ============================================================ */

import {
    MONTHS_LORE,
    WEEKDAYS_LORE,
    addDays,
    isAuk,
    serialOf,
    serialToDate,
    weekdayOf,
} from "./parser.js";

/* Номер месяца и день недели берём из таблиц parser.js по имени, а не числом.
   Числа пришлось бы держать в голове и править в двух местах: тронули порядок
   месяцев — и праздники молча разъехались бы по году. */
const mo = (translit) => MONTHS_LORE.findIndex((m) => m.translit === translit) + 1;
const wd = (en) => WEEKDAYS_LORE.findIndex((w) => w.en === en);

/**
 * Слои достоверности.
 *
 * Заведены затем, чтобы включать и выключать праздники не поштучно, а
 * пластами: кому-то нужна строгая сага, кому-то живой обычай, а кому-то
 * и современное неоязычество. Порядок — от твёрдого к придуманному, и он же
 * задаёт старшинство, когда в один день попадает несколько праздников.
 */
export const HOLIDAY_TIERS = [
    {
        id: "attested", ru: "Засвидетельствованные",
        hint: "Названы в сагах, законах или скальдических висах. Спорить тут можно о подробностях, но не о самом факте.",
    },
    {
        id: "probable", ru: "Вероятные",
        hint: "Восстановлены по косвенным данным: имя месяца, поздний обычай, слово в законе. Праздник правдоподобен, но прямого свидетельства эпохи нет.",
    },
    {
        id: "christian", ru: "Христианские",
        hint: "Пришли с крещением и к XI веку уже вошли в хозяйственный год. Для языческой Скандинавии их нет.",
    },
    {
        id: "modern", ru: "Современные",
        hint: "Неоязыческая реконструкция XX века. К эпохе викингов отношения не имеет; включается для тех, кто играет по нынешнему Асатру.",
    },
];

/**
 * Откуда праздник родом.
 *
 * `norse` — общескандинавский, был везде; `iceland` и `sweden` — местные.
 * Тинг в Уппсале в исландской усадьбе не празднуют, и наоборот.
 */
export const HOLIDAY_REGIONS = [
    { id: "norse", ru: "Общескандинавский" },
    { id: "iceland", ru: "Исландский" },
    { id: "sweden", ru: "Шведский" },
];

/**
 * Сами праздники.
 *
 * `rule` — как найти первый день в году:
 *   `{ month, weekday, nth }` — n-й такой день недели в месяце; nth = -1
 *                              означает последний;
 *   `{ month, day }`          — просто число, для христианских и современных:
 *                              они привязаны к григорианскому дню, а не
 *                              к неделе, и переводятся через таблицу месяцев.
 *
 * `days` — сколько суток длится. `since` — год, раньше которого праздника
 * в этом мире нет.
 *
 * `gloss` — что это, одной строкой для панели. `source` — откуда известно;
 * у реконструкций там стоит прямая оговорка, а не ссылка, и это намеренно:
 * пусть неправда о происхождении будет видна сразу.
 */
export const HOLIDAYS = [
    /* ── Засвидетельствованные ── */
    {
        id: "vetrnaetr", norse: "Vetrnætr", ru: "Зимние ночи",
        tier: "attested", region: "norse", days: 3,
        rule: { month: mo("Gormanud"), weekday: wd("Saturday"), nth: 1 },
        gloss: "Начало зимнего полугодия: скот забит, мясо посолено, дом полон. Большой пир и главное сходбище года по усадьбам.",
        source: "«Сага о Глуме Убийце», «Сага о Гисли»",
    },
    {
        id: "alfablot", norse: "Álfablót", ru: "Жертва альвам",
        tier: "attested", region: "norse", days: 3,
        rule: { month: mo("Gormanud"), weekday: wd("Saturday"), nth: 1 },
        gloss: "Домашний обряд тех же зимних ночей — альвам и предкам рода. Правит хозяйка, чужаков в дом не пускают вовсе: гостя заворачивают от порога.",
        source: "«Восточные висы» Сигвата Тордарсона, где его самого и завернули",
    },
    {
        id: "disablot", norse: "Dísablót", ru: "Жертва дисам",
        tier: "attested", region: "norse", days: 3,
        rule: { month: mo("Gormanud"), weekday: wd("Saturday"), nth: 1 },
        gloss: "Жертва дисам — женским духам-покровительницам рода. Идёт в те же зимние ночи и держится на женщинах дома.",
        source: "«Сага об Эгиле», «Сага о Хервёр»",
    },
    {
        id: "disathing", norse: "Dísaþing", ru: "Тинг дис",
        tier: "attested", region: "sweden", days: 3,
        rule: { month: mo("Goa"), weekday: wd("Sunday"), nth: 1 },
        gloss: "Шведский черёд того же обряда: жертва дисам в Уппсале, а при ней тинг и большая ярмарка. Съезжается вся округа.",
        source: "«Сага об Олаве Святом»",
    },
    {
        id: "hokunott", norse: "Hǫkunótt", ru: "Ночь перед Йолем",
        tier: "attested", region: "norse", days: 1,
        rule: { month: mo("Morsugur"), day: 30 },
        gloss: "Ночь, с которой начинают пить Йоль. Что значит само слово, спорят до сих пор.",
        source: "«Сага о Хаконе Добром»",
    },
    {
        id: "jol", norse: "Jól", ru: "Йоль",
        tier: "attested", region: "norse", days: 13,
        rule: { month: mo("Thorri"), weekday: wd("Friday"), nth: 1 },
        gloss: "Середина зимы и главный праздник года: тринадцать суток пиров, клятвы на кабане, Один под именем Jólnir ходит по земле.",
        source: "«Сага о Хаконе Добром»",
    },
    {
        id: "sigrblot", norse: "Sigrblót", ru: "Жертва на победу",
        tier: "attested", region: "norse", days: 3,
        rule: { month: mo("Harpa"), weekday: wd("Thursday"), nth: 1 },
        gloss: "Он же Sumarmál — начало летнего полугодия. Жертва Одину на победу, перед тем как корабли пойдут в поход.",
        source: "«Сага об Инглингах», «Гулатингслёг»",
    },
    {
        id: "althingi", norse: "Alþingi", ru: "Всеобщий тинг",
        tier: "attested", region: "iceland", days: 14,
        rule: { month: mo("Solmanud"), weekday: wd("Thursday"), nth: -1 },
        gloss: "Не жертва, а главное людское дело года: две недели на Полях тинга — законы, тяжбы, сговоры о свадьбах и торг. Кто не поехал, тот весь год не при делах.",
        source: "«Книга об исландцах», «Серый гусь»",
    },

    /* ── Вероятные ── */
    {
        id: "thorrablot", norse: "Þorrablót", ru: "Жертва Торри",
        tier: "probable", region: "iceland", days: 1,
        rule: { month: mo("Thorri"), weekday: wd("Friday"), nth: 1 },
        gloss: "Встреча месяца самых злых холодов, в первую его пятницу.",
        source: "Имя месяца древнее и надёжное, но праздник в известном нам виде — исландское возрождение XIX века. Что делали в этот день при викингах, неизвестно.",
    },
    {
        id: "goublot", norse: "Góublót", ru: "Жертва Гои",
        tier: "probable", region: "norse", days: 1,
        rule: { month: mo("Goa"), weekday: wd("Sunday"), nth: 1 },
        gloss: "Встреча Гои — месяца, за которым зиме уже недолго.",
        source: "Восстановлено по имени месяца и позднему обычаю; прямого свидетельства эпохи нет.",
    },
    {
        id: "midsumar", norse: "Miðsumar", ru: "Середина лета",
        tier: "probable", region: "norse", days: 1,
        rule: { month: mo("Solmanud"), day: 15 },
        gloss: "Солнцеворот: самый долгий день, костры на холмах.",
        source: "Костры и середина лета известны по позднему обычаю; отдельного праздника с этим именем саги не называют.",
    },

    /* ── Христианские, с тысячного года ── */
    {
        id: "jonsmessa", norse: "Jónsmessa", ru: "Иванов день",
        tier: "christian", region: "norse", days: 1, since: 1000,
        rule: { month: mo("Skerpla"), day: 24 },
        gloss: "Травы, сорванные в эту ночь, сильнее обычных, а роса на них целебна. Катаются по ней нагими от хвори.",
        source: "24 июня по счёту церкви; в этом календаре — скерпла",
    },
    {
        id: "olafsmessa", norse: "Ólafsmessa", ru: "Олавов день",
        tier: "christian", region: "norse", days: 1, since: 1031,
        rule: { month: mo("Solmanud"), day: 29 },
        gloss: "Память Олава Святого, павшего при Стикластадире.",
        source: "29 июля; раньше 1031 года праздника нет вовсе — Олава причли к святым лишь через год после гибели",
    },
    {
        id: "krossmessa-var", norse: "Krossmessa á vár", ru: "Крестов день весенний",
        tier: "christian", region: "norse", days: 1, since: 1000,
        rule: { month: mo("Harpa"), day: 3 },
        gloss: "Веха хозяйственного года: с неё считают сроки найма и выгона скота.",
        source: "3 мая по счёту церкви; в этом календаре — харпа",
    },
    {
        id: "krossmessa-haust", norse: "Krossmessa á haust", ru: "Крестов день осенний",
        tier: "christian", region: "norse", days: 1, since: 1000,
        rule: { month: mo("Tvimanud"), day: 14 },
        gloss: "Осенняя веха: скот сгоняют с горных пастбищ, работников рассчитывают.",
        source: "14 сентября по счёту церкви; в этом календаре — твимануд",
    },

    /* ── Современные: по умолчанию выключены ── */
    {
        id: "ostara", norse: "Ostara", ru: "Остара",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Goa"), day: 21 },
        gloss: "Весеннее равноденствие.",
        source: "Неоязыческая реконструкция XX века. Для эпохи викингов подтверждений нет.",
    },
    {
        id: "beltane", norse: "Beltane", ru: "Бельтайн",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Harpa"), day: 1 },
        gloss: "Начало лета, костры и скот между огнями.",
        source: "Неоязыческая реконструкция XX века, и притом кельтская по происхождению. Для эпохи викингов подтверждений нет.",
    },
    {
        id: "litha", norse: "Litha", ru: "Лита",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Skerpla"), day: 21 },
        gloss: "Летнее солнцестояние.",
        source: "Неоязыческая реконструкция XX века. Для эпохи викингов подтверждений нет.",
    },
    {
        id: "freyfaxi", norse: "Freyfaxi", ru: "Фрейфакси",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Heyannir"), day: 1 },
        gloss: "Первый сноп, начало жатвы.",
        source: "Неоязыческая реконструкция XX века: Freyfaxi в сагах — имя коня, а не праздника. Для эпохи викингов подтверждений нет.",
    },
    {
        id: "mabon", norse: "Mabon", ru: "Мабон",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Tvimanud"), day: 21 },
        gloss: "Осеннее равноденствие.",
        source: "Неоязыческая реконструкция XX века. Для эпохи викингов подтверждений нет.",
    },
    {
        id: "samhain", norse: "Samhain", ru: "Самайн",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Haustmanud"), day: 30 },
        gloss: "Канун зимы, ночь, когда грань тонка.",
        source: "Неоязыческая реконструкция XX века, и притом кельтская. Ставится на 31 октября, но в месяце тридцать дней — стоит последним числом хаустмануда.",
    },
    {
        id: "yule", norse: "Yule", ru: "Юль",
        tier: "modern", region: "norse", days: 1,
        rule: { month: mo("Ylir"), day: 21 },
        gloss: "Зимнее солнцестояние по нынешнему счёту.",
        source: "Неоязыческое написание и дата XX века. Настоящий Jól стоит в этом календаре отдельно и позже — смотри его.",
    },
];

/** Праздник по имени, либо null. */
export function holidayById(id) {
    return HOLIDAYS.find((h) => h.id === id) ?? null;
}

/** Слои по умолчанию: всё, кроме современного. */
export const DEFAULT_TIERS = HOLIDAY_TIERS.filter((t) => t.id !== "modern").map((t) => t.id);

/**
 * Первый день праздника в этом году.
 *
 * Ищем n-й день недели в месяце. Месяц ровно тридцатидневный, поэтому таких
 * дней всегда четыре или пять, и «последний четверг» считается с хвоста.
 *
 * @returns {{year:number, month:number, day:number}|null}
 */
export function holidayStart(holiday, year) {
    if (!holiday || !Number.isFinite(year)) return null;
    if (holiday.since != null && year < holiday.since) return null;

    const { month, day, weekday, nth } = holiday.rule;
    if (day != null) return { year, month, day };

    /* День недели первого числа месяца известен, дальше простая арифметика:
       сколько дней добрать до нужного дня недели. */
    const first = weekdayOf(year, month, 1);
    const shift = (weekday - first + 7) % 7;

    if (nth > 0) {
        const d = 1 + shift + (nth - 1) * 7;
        return d <= 30 ? { year, month, day: d } : null;
    }
    /* Последний: шагаем от первого попавшегося семёрками, пока в месяце. */
    let d = 1 + shift;
    while (d + 7 <= 30) d += 7;
    return { year, month, day: d };
}

/** Все дни праздника подряд, от первого до последнего. */
export function holidayDays(holiday, year) {
    const start = holidayStart(holiday, year);
    if (!start) return [];
    const from = serialOf(start.year, start.month, start.day);
    return Array.from({ length: holiday.days }, (_, i) => serialToDate(from + i));
}

/**
 * Отбор по слоям и краю света.
 *
 * `region` — где идёт ролевая: `all` пропускает всё, а названный край
 * оставляет свои праздники и общескандинавские. Исландцу шведский тинг
 * в Уппсале праздновать не с чего, но Йоль — общий.
 */
function allowed(holiday, { tiers = DEFAULT_TIERS, region = "all" } = {}) {
    if (!tiers.includes(holiday.tier)) return false;
    if (region !== "all" && holiday.region !== "norse" && holiday.region !== region) return false;
    return true;
}

/**
 * Какие праздники стоят на этот день.
 *
 * Возвращаем ВСЕ, а не первый попавшийся: в зимние ночи разом идут и общий
 * пир, и альвам, и дисам, и это не путаница таблицы, а как оно и было — три
 * обряда одних суток, разными руками и в разных углах усадьбы.
 *
 * Смотрим и прошлый год: праздник, начавшийся в хаустмануде, может дотянуться
 * до гормануда следующего, а Alþingi перешагивает через аукнэтр.
 *
 * @returns {Array<{holiday:object, day:number, days:number, first:boolean, last:boolean}>}
 */
export function holidaysOn(year, month, day, opts = {}) {
    if (year == null || month == null || day == null) return [];
    const here = serialOf(year, month, day);
    const out = [];

    for (const holiday of HOLIDAYS) {
        if (!allowed(holiday, opts)) continue;
        for (const y of [year - 1, year]) {
            const start = holidayStart(holiday, y);
            if (!start) continue;
            const from = serialOf(start.year, start.month, start.day);
            const n = here - from;
            if (n < 0 || n >= holiday.days) continue;
            out.push({
                holiday,
                day: n + 1,
                days: holiday.days,
                first: n === 0,
                last: n === holiday.days - 1,
            });
            break;
        }
    }

    /* Старшинство: сперва слой (сага важнее реконструкции), потом длина —
       тринадцать суток Йоля весомее одного дня, — потом порядок таблицы. */
    const tierOrder = (h) => HOLIDAY_TIERS.findIndex((t) => t.id === h.tier);
    return out.sort((a, b) =>
        tierOrder(a.holiday) - tierOrder(b.holiday)
        || b.days - a.days
        || HOLIDAYS.indexOf(a.holiday) - HOLIDAYS.indexOf(b.holiday));
}

/** Идёт ли праздник и какой это его день — только главный из совпавших. */
export function holidayNow(year, month, day, opts = {}) {
    return holidaysOn(year, month, day, opts)[0] ?? null;
}

/**
 * Ближайший праздник впереди и сколько до него дней.
 *
 * Считаем перебором по дням, а не сортировкой начал: праздники бывают
 * многодневными и разноимёнными, и «ближайший» — это ближайший ПЕРВЫЙ день,
 * какой встретится. Год с небольшим вперёд хватает: реже, чем раз в год,
 * праздников тут нет.
 *
 * @returns {{holiday:object, days:number, at:object}|null}
 */
export function nextHoliday(year, month, day, opts = {}) {
    const here = serialOf(year, month, day);
    const limit = 400;
    for (let n = 1; n <= limit; n++) {
        const d = serialToDate(here + n);
        const found = holidaysOn(d.year, d.month, d.day, opts).find((x) => x.first);
        if (found) return { holiday: found.holiday, days: n, at: d };
    }
    return null;
}

/**
 * Сводка для панели и промпта — одной точкой сборки, как и всё остальное.
 *
 * `count` пишем словами и только для многодневных: «день 2 из 3» на
 * однодневном празднике — шум, а не сведение.
 *
 * @returns {{norse, ru, gloss, source, tier, region, day, days, count, first,
 *   last, others, next}|null}
 */
export function holidayView(year, month, day, opts = {}) {
    if (year == null || month == null || day == null) return null;
    const all = holidaysOn(year, month, day, opts);
    const next = nextHoliday(year, month, day, opts);
    if (!all.length) {
        return next
            ? { none: true, next: { norse: next.holiday.norse, ru: next.holiday.ru, days: next.days, at: next.at } }
            : null;
    }

    const [main, ...rest] = all;
    const h = main.holiday;
    return {
        id: h.id,
        norse: h.norse,
        ru: h.ru,
        gloss: h.gloss,
        source: h.source,
        tier: h.tier,
        region: h.region,
        day: main.day,
        days: main.days,
        count: main.days > 1 ? `день ${main.day} из ${main.days}` : null,
        first: main.first,
        last: main.last,
        /* Прочие праздники этих же суток — отдельным списком, а не склейкой:
           панель рисует их своими строками, промпт называет через запятую. */
        others: rest.map((x) => ({ norse: x.holiday.norse, ru: x.holiday.ru, gloss: x.holiday.gloss })),
        next: next
            ? { norse: next.holiday.norse, ru: next.holiday.ru, days: next.days, at: next.at }
            : null,
    };
}

/**
 * Помечает дни недельной полосы: какие из них праздничные.
 *
 * Панель рисует семь клеток и должна знать про каждую, входит ли она
 * в праздник и не крайняя ли она в нём: у трёхдневного праздника все три дня
 * красятся, но у первого и последнего скругляется своя сторона.
 *
 * @param {Array<{year, month, day}>} dates Дни полосы по порядку
 * @returns {Array<{holiday:object, first:boolean, last:boolean}|null>}
 */
export function markWeek(dates, opts = {}) {
    return dates.map((d) => {
        const found = holidaysOn(d.year, d.month, d.day, opts)[0];
        return found ? { holiday: found.holiday, first: found.first, last: found.last } : null;
    });
}

/** Праздники года по порядку — для Tímatal и для тестов. */
export function holidaysOfYear(year, opts = {}) {
    return HOLIDAYS
        .filter((h) => allowed(h, opts))
        .map((h) => ({ holiday: h, at: holidayStart(h, year) }))
        .filter((x) => x.at)
        .sort((a, b) =>
            serialOf(a.at.year, a.at.month, a.at.day) - serialOf(b.at.year, b.at.month, b.at.day));
}

/** Слово о дне недели — для проверок и для Tímatal. */
export function weekdayNameOf(year, month, day) {
    return isAuk(month) ? null : WEEKDAYS_LORE[weekdayOf(year, month, day)].norse;
}

/** Последний день праздника — пригождается и панели, и тестам. */
export function holidayEnd(holiday, year) {
    const start = holidayStart(holiday, year);
    if (!start) return null;
    return addDays(start.year, start.month, start.day, holiday.days - 1);
}
