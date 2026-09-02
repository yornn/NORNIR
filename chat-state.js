/*
 * NORNIR — состояние сцены, привязанное к сообщениям чата.
 *
 * Источник правды — последнее актуальное сообщение {{char}}, а не какое-то
 * «текущее состояние» внутри расширения. Разобранный снимок сцены лежит
 * в msg.extra, и этим всё решается само собой:
 *
 *  - SillyTavern держит на каждый свайп свою копию extra (swipe_info[i].extra)
 *    и подставляет её обратно при переключении, так что у каждой перегенерации
 *    своя погода, одежда и мысль;
 *  - удалили сообщение — оно ушло из chat[] вместе со своими данными, и поиск
 *    с конца находит предыдущее;
 *  - откат назад работает без отдельной логики, потому что откатывать нечего.
 *
 * Ровно на этом ломаются трекеры с глобальным состоянием: оно двигается только
 * вперёд, и после удаления сообщения инфоблок показывает данные, которых в чате
 * уже нет.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Keys & Stamps ...... Ключи в extra и отпечаток генерации
 * 2. Sync ............... Приведение сообщения к каноническому виду
 * 3. Lookup ............. Поиск актуального состояния в чате
 * 4. Maintenance ........ Разовый проход по всей истории
 */

import {
    TOLD_FIELDS,
    addDays,
    eyktForHour,
    hasDate,
    hasTime,
    hasUrd,
    parseUrd,
    serialOf,
    serialToDate,
    stripUrd,
} from "./parser.js";

import {
    CHILD_WATCH_DAYS,
    CYCLE_DEFAULT,
    STRAINS,
    TERM_DAYS,
    THREAT_DAYS,
    cycleSummary,
    herbBarren,
    pickHerb,
    pregnancyTerm,
    rollBirths,
    rollConception,
    rollSex,
    rollSexes,
    rollHerb,
    rollStillbirth,
    rollThreat,
    strainLoad,
} from "./body.js";

/* ============================================================
 * 1. KEYS & STAMPS
 * ============================================================ */

/** Разобранный снимок сцены. */
const KEY_STATE = "nornirState";
/** Исходный маркер — чтобы перечитать его, если парсер поумнеет. */
const KEY_MARKER = "nornirMarker";
/** Отпечаток генерации, которой принадлежит снимок. */
const KEY_STAMP = "nornirStamp";
/**
 * Дата сцены — отдельно от снимка, и не случайно.
 *
 * Снимок целиком выводится из маркера и при каждой пересборке затирается
 * заново. Дата же модели больше не принадлежит: её ставит пользователь через
 * Tímatal, а дальше она едет вперёд сама. Лежи она в снимке — первая же
 * пересборка её бы стёрла.
 *
 * `{ year, month, day, anchored }`. Якорь (anchored: true) поставлен руками
 * или пришёл из старого маркера, он неприкосновенен. Остальные выведены
 * переносом и пересчитываются, если якорь сдвинули.
 */
const KEY_DATE = "nornirDate";
/**
 * Состояние тела: от какого дня идёт счёт цикла.
 *
 * Тоже отдельным ключом и по той же причине, что дата, — снимок из маркера
 * при каждой пересборке переписывается заново, а тело переносится по чату.
 */
const KEY_BODY = "nornirBody";

/** Глубина поиска состояния вверх по чату. */
export const SCAN_DEPTH = 25;

/**
 * Отметка времени к единому виду — секундам эпохи.
 *
 * Приведение обязательно, и вот почему. `gen_finished` в памяти — объект Date,
 * а в файле чата та же величина лежит строкой ISO. Сравнение через String()
 * давало «Sun Aug 09 2026 23:54:57 GMT+0300» против «2026-08-09T20:54:57.779Z»:
 * одно и то же мгновение, разные строки. После каждой перезагрузки страницы
 * отпечаток переставал совпадать, снимок считался чужим и стирался — вместе
 * с погодой, локацией, настроением и мыслью.
 *
 * Секунды, а не миллисекунды: у Date.toString() долей секунды нет, у ISO есть,
 * и на миллисекунде сравнение разъезжалось бы снова.
 *
 * Побочная выгода: старые отпечатки, записанные в прежнем виде, приводятся
 * к тому же числу — уже сохранённые чаты переезжают сами.
 */
function canonicalStamp(value) {
    if (value === undefined || value === null || value === "") return "";
    /*
     * Уже приведённое второй раз не приводим.
     *
     * Приведение обязано быть идемпотентным: в extra ложится ВЫВОД этой
     * функции, и при следующей сверке он же приходит на вход. А Date.parse
     * на голых числах разбирает их как год — «-10800» превращалось в 8800-й
     * год, отпечаток переставал совпадать сам с собой, и снимок стирался как
     * чужой. С настоящими датами таверны этого не случалось (десять цифр
     * годом не читаются), но зависеть от такого совпадения нельзя.
     */
    if (/^-?\d+$/.test(String(value))) return String(value);
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : String(value);
}

/**
 * Отпечаток конкретной генерации сообщения.
 *
 * `gen_finished` меняется при каждой новой генерации и хранится
 * в swipe_info вместе с extra, поэтому по нему видно, относится ли снимок
 * к текущему свайпу. Правка текста руками отпечаток не меняет — значит,
 * отредактированная проза не уносит с собой календарь.
 */
function stampOf(msg) {
    return canonicalStamp(msg?.gen_finished ?? msg?.send_date ?? "");
}

function clearKeys(msg) {
    let changed = false;
    for (const key of [KEY_STATE, KEY_MARKER, KEY_STAMP]) {
        if (msg.extra?.[key] !== undefined) {
            delete msg.extra[key];
            changed = true;
        }
    }
    /* Якорь даты переживает потерю снимка: его ставят и на приветствие
       персонажа, у которого маркера нет и не будет. Выведенную дату убираем —
       без снимка её всё равно некому читать. */
    if (msg.extra?.[KEY_DATE] && !msg.extra[KEY_DATE].anchored) {
        delete msg.extra[KEY_DATE];
        changed = true;
    }
    return changed;
}

/** Вырезает сам маркер из текста — то, что показывается в чате. */
function markerOf(text) {
    const clean = stripUrd(text);
    const raw = String(text ?? "");
    // Маркер — это разница между исходником и очищенным текстом. Хранить его
    // отдельно надёжнее, чем весь сырой текст: правка прозы его не затрагивает.
    if (clean === raw) return null;
    const m = raw.match(/<!--\s*\[URD:[\s\S]*?\]\s*-->|<!--\s*\[URD:[\s\S]*$/i);
    return m ? m[0] : null;
}

/* ============================================================
 * 2. SYNC
 * ============================================================ */

/**
 * Приводит сообщение к каноническому виду.
 *
 * Снимок всегда выводится из ТЕКСТА ЭТОГО СВАЙПА. Если маркера в нём нет,
 * а в extra висит чужой снимок (SillyTavern копирует extra в новый свайп) —
 * снимок удаляется, а не остаётся показываться от прошлой генерации.
 *
 * Идемпотентна: повторный вызов на уже обработанном сообщении ничего не меняет.
 *
 * @param {object} msg Сообщение чата
 * @param {{ keepMarker?: boolean }} options keepMarker — не вырезать маркер (режим отладки)
 * @returns {boolean} true, если сообщение изменилось и чат стоит сохранить
 */
export function syncMessage(msg, { keepMarker = false } = {}) {
    if (!msg || msg.is_user || typeof msg.mes !== "string") return false;
    msg.extra = msg.extra || {};

    // 1. В тексте есть маркер — свежая генерация, она и есть источник.
    if (hasUrd(msg.mes)) {
        const parsed = parseUrd(msg.mes);
        const marker = markerOf(msg.mes);
        if (!parsed) {
            // Маркер есть, но пустой или сплошь плейсхолдеры — данных нет.
            return clearKeys(msg) || stripMarker(msg, keepMarker);
        }
        let changed = false;
        if (JSON.stringify(msg.extra[KEY_STATE]) !== JSON.stringify(parsed)) {
            msg.extra[KEY_STATE] = parsed;
            changed = true;
        }
        if (msg.extra[KEY_MARKER] !== marker) { msg.extra[KEY_MARKER] = marker; changed = true; }
        /* Дата в маркере — это старый чат: новых полей date модель уже не
           пишет. Она главнее перенесённой, поэтому становится якорем, и
           прежние истории переезжают на новую схему сами.

           Но поставленную руками не трогаем. Иначе пользователь правит дату
           в Tímatal на старом сообщении, а следующая же пересборка возвращает
           её к тому, что когда-то написала модель. */
        if (hasDate(parsed) && msg.extra[KEY_DATE]?.source !== "user") {
            const anchor = { year: parsed.year, month: parsed.month, day: parsed.day, anchored: true, source: "marker" };
            if (JSON.stringify(msg.extra[KEY_DATE]) !== JSON.stringify(anchor)) {
                msg.extra[KEY_DATE] = anchor;
                changed = true;
            }
        }
        const stamp = stampOf(msg);
        if (msg.extra[KEY_STAMP] !== stamp) { msg.extra[KEY_STAMP] = stamp; changed = true; }
        return stripMarker(msg, keepMarker) || changed;
    }

    // 2. Маркера в тексте нет, но есть снимок от ЭТОЙ же генерации — он валиден.
    if (msg.extra[KEY_STATE] && canonicalStamp(msg.extra[KEY_STAMP]) === stampOf(msg)) {
        // Перечитываем сохранённый маркер: если парсер с тех пор стал умнее,
        // снимок подтянется сам, без повторной генерации.
        const marker = msg.extra[KEY_MARKER];
        if (typeof marker === "string") {
            const reparsed = parseUrd(marker);
            if (reparsed && JSON.stringify(reparsed) !== JSON.stringify(msg.extra[KEY_STATE])) {
                msg.extra[KEY_STATE] = reparsed;
                return true;
            }
        }
        return false;
    }

    // 3. Ни маркера, ни своего снимка — чужие данные тут висеть не должны.
    return clearKeys(msg);
}

/** Убирает маркер из видимого текста и из копии текущего свайпа. */
function stripMarker(msg, keepMarker) {
    if (keepMarker) return false;
    const clean = stripUrd(msg.mes);
    if (clean === msg.mes) return false;
    msg.mes = clean;
    // Свайпы держат собственную копию текста — иначе маркер вернётся при переключении.
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === "number") {
        const current = msg.swipes[msg.swipe_id];
        if (typeof current === "string") msg.swipes[msg.swipe_id] = stripUrd(current);
    }
    return true;
}

/* ============================================================
 * 3. LOOKUP
 *
 * Наружу торчит ОДНА функция — readChat(). Всё, что выводится из истории —
 * снимок сцены, дата, тело, сказанное однажды, — считается за один вызов
 * и одним набором настроек.
 *
 * Так было не всегда, и разница стоила дорого. Раньше вызывающий брал дату
 * одной функцией, тело другой, снимок третьей, и каждая заново шла по всему
 * чату. Настройки при этом передавались кто во что горазд: поиск снимка не знал
 * про ручную запись о теле, поиск даты — вообще ни про что. Проходы писали
 * в msg.extra разное, каждый честно возвращал «изменилось», и панель на каждой
 * перерисовке сохраняла чат. Один refresh() успевал обойти историю раз десять.
 *
 * Отсюда правило: один проход, один options. Тонкие обёртки ниже оставлены для
 * тестов и совместимости и сами ничего не считают.
 * ============================================================ */

/**
 * Всё, что известно из истории чата, за один проход.
 *
 * Сначала скан с конца до первого сообщения {{char}} со снимком — по дороге
 * сообщения лениво синхронизируются, так подхватывается чат, в котором маркеры
 * ещё не разобраны. Потом один проход вперёд, который
 * раскладывает даты, ведёт тело и собирает сказанное однажды.
 *
 * @param {Array} chat Массив сообщений
 * @param {{year:number, month:number|"AUK", day:number}|null} startDate Дата начала чата
 * @param {{ keepMarker?: boolean, chatId?: string, chances?: object, manualBody?: object }} options
 * @returns {{ state: object|null, index: number, date: object|null, body: object|null,
 *             told: object|null, changed: boolean }}
 */
export function readChat(chat, startDate = null, options = {}) {
    const empty = { state: null, index: -1, date: null, body: null, told: null, changed: false };
    if (!Array.isArray(chat) || chat.length === 0) return empty;

    let changed = false;
    let found = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== "string") continue;
        if (msg.is_user) continue;

        if (syncMessage(msg, options)) changed = true;

        if (msg.extra?.[KEY_STATE]) { found = { msg, index: i }; break; }
        if (chat.length - 1 - i >= SCAN_DEPTH) break;
    }

    const resolved = resolveDates(chat, startDate, options);
    if (resolved.changed) changed = true;

    /* Дата живёт отдельным ключом и переносится вперёд — подмешиваем её
       в снимок. Наружу уезжает один плоский объект: вызывающему незачем знать,
       что поля собраны из двух мест. */
    let state = null;
    if (found) {
        const date = dateOf(found.msg.extra[KEY_DATE]);
        state = date ? { ...found.msg.extra[KEY_STATE], ...date } : found.msg.extra[KEY_STATE];
    }

    return {
        state,
        index: found?.index ?? -1,
        date: resolved.current,
        body: resolved.body,
        told: resolved.told,
        changed,
    };
}

/**
 * Прежняя форма ответа — для тестов и для тех мест, где нужен только снимок.
 *
 * @returns {{ state: object, index: number, changed: boolean }|null}
 */
export function findLatestState(chat, options = {}) {
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const read = readChat(chat, options.startDate ?? null, options);
    if (!read.state) return read.changed ? { state: null, index: -1, changed: true } : null;
    return { state: read.state, index: read.index, changed: read.changed };
}

/* ============================================================
 * 3b. DATES
 *
 * Дату модель больше не пишет: это единственное поле маркера, которое она не
 * наблюдала в сцене, а вычисляла — и вычисляла вслух, по-разному в каждом
 * свайпе. Теперь её ставит пользователь, а расширение везёт вперёд.
 *
 * Перенос сам по себе даты не двигает. Двигает её эйкта: если в новом
 * сообщении она РАНЬШЕ прежней (был наттмал, стал моргун), значит сутки
 * сменились. Эйкту модель определяет по сцене — «солнце в зените» — и
 * ошибается на ней редко.
 *
 * Скачки через несколько суток («прошла неделя») так не поймать, и ловить их
 * догадками не стоит: для них есть календарь в Tímatal.
 * ============================================================ */

/**
 * Потерянная смена года в дате из старого маркера.
 *
 * Год здесь начинается первым гормануда — первым днём зимы (см. MONTHS).
 * Значит счёт года перещёлкивает посреди осени, а модель, которая писала даты
 * в старых чатах, думает привычным календарём, где год меняется в январе.
 * Отсюда ровно одна ошибка: после «4 хейаннир 1015» она пишет «1 гормануд
 * 1015» вместо 1016 — и якорь тащит всю историю на 284 дня НАЗАД. Панель
 * верила ему молча: ношение съезжало на девять месяцев, цикл считался
 * от крови, которой ещё не было.
 *
 * Чиним только этот случай и только его. Признак надёжный: дата ушла назад
 * больше чем на полгода, а с прибавленным годом встаёт скромным шагом вперёд.
 * Меньший откат так не лечим — это уже не потерянный год, а просто путаница,
 * и подменять её скачком на год вперёд было бы хуже болезни.
 *
 * Руку пользователя не трогаем вовсе: назначенный день — авторский акт, и
 * назад его двигают намеренно.
 */
const HALF_YEAR = 182;

function rollLostYear(date, carried, source) {
    if (!date || source !== "marker" || !carried) return date;
    const was = serialOf(carried.year, carried.month, carried.day);
    const now = serialOf(date.year, date.month, date.day);
    if (was - now <= HALF_YEAR) return date;

    const rolled = { ...date, year: date.year + 1 };
    const then = serialOf(rolled.year, rolled.month, rolled.day);
    return then > was && then - was <= HALF_YEAR ? rolled : date;
}

/**
 * Применяет события тела к состоянию на дату этого сообщения.
 *
 * Порядок разбора важнее, чем кажется. Роды и потеря закрывают беременность,
 * зачатие её открывает, кровь двигает якорь цикла — и всё это может прийти
 * в одном сообщении. Разбираем по одному, слева направо, как оно и случилось
 * бы в сцене.
 *
 * Зачатие не гадаем: семя, пролившееся в плодовитые дни, даёт дитя. Бросок
 * кубика тут смотрелся бы честнее, но невоспроизводимо — свайп давал бы то
 * беременность, то нет, а календарь обязан считать одинаково.
 */
function applyBodyEvents(body, events, today, ctx = {}) {
    let next = body ? { ...body } : {};

    /* Мертворождение читаем заранее, а не отдельным случаем в разборе.
       «Дитя родилось мёртвым» задевает два правила сразу — роды и исход, —
       и порядок между ними зависел бы от того, как их записали в таблице. */
    const stillborn = events.includes("stillborn");

    for (const event of events) {
        switch (event) {
            case "bleedStart":
                /*
                 * Кровь закрывает и подозрение, и кормление: цикл пошёл заново.
                 *
                 * Но не всё, что было, ею отменяется. Уже рождённых детей
                 * кровь не уносит, и выпитый отвар не перестаёт мутить оттого,
                 * что тидир пришли, — а приходят они как раз после него.
                 * Переносим их через сброс поимённо.
                 */
                next = {
                    lastBleed: { ...today },
                    ...(next.children ? { children: next.children } : {}),
                    ...(next.herb ? { herb: next.herb } : {}),
                };
                break;
            case "bleedEnd":
                /* Кровь кончилась раньше или позже, чем считает таблица фаз.
                   Своего счёта не заводит — только поправляет вид панели. */
                if (next.lastBleed) next.bleedEnded = { ...today };
                break;
            case "oddBleeding":
                /* Кровь не в срок — не начало цикла, и якорь она НЕ двигает:
                   иначе одно тревожное пятно сбивало бы весь дальнейший счёт.
                   Записываем как примету, а не как тидир. */
                next.oddBleed = { ...today };
                break;
            case "labour":
                /* Схватки. Родов ещё нет — они придут своим событием, — но
                   с этой минуты панель показывает роды, а не ношение. */
                if (next.pregnancy) {
                    next.pregnancy = { ...next.pregnancy, labour: { ...today } };
                }
                break;
            case "seedSpilled":
                next = tryConceive(next, today, true, ctx);
                break;
            case "seedWithheld":
                /* Наружу или с оглядкой — шанс мал, но не ноль, и бросок
                   всё равно делается: иначе «мы же поберёглись» становилось бы
                   стопроцентной защитой, чего в XI веке не бывало. */
                next = tryConceive(next, today, false, ctx);
                break;
            case "kick":
                /* Шевеление — и отметка, что дитя живо, и, если это первое,
                   тот самый квикнан. Затишье оно снимает. */
                if (next.pregnancy) {
                    next.pregnancy = { ...next.pregnancy, lastKick: { ...today }, quietSince: null };
                    if (!next.pregnancy.quickened) {
                        next.pregnancy.quickened = { ...today };
                        next.pregnancy.knownSince = next.pregnancy.knownSince ?? { ...today };
                    }
                }
                break;
            case "quiet":
                /*
                 * Затишье — своя отметка, а не поддельное шевеление.
                 *
                 * Раньше здесь при пустом lastKick ставился lastKick = сегодня,
                 * то есть на слова «дитя затихло» панель отвечала «Дитя бьётся
                 * крепко». Теперь запоминаем день, с которого дитя не слыхать,
                 * и счётчик тишины растёт от него.
                 */
                if (next.pregnancy && !next.pregnancy.quietSince) {
                    next.pregnancy = { ...next.pregnancy, quietSince: { ...today } };
                }
                break;
            case "quickened":
                if (next.pregnancy) {
                    /* Первое шевеление — оно же и последнее на сегодня: без
                       lastKick счётчик тишины не от чего было бы считать, и
                       вся тревога о дитяти оставалась мёртвой веткой. */
                    next.pregnancy = {
                        ...next.pregnancy,
                        quickened: { ...today },
                        lastKick: { ...today },
                        quietSince: null,
                    };
                    /* Шевеление и есть тот миг, когда подозрение становится
                       знанием. Исторически — ровно так. */
                    if (!next.pregnancy.knownSince) next.pregnancy.knownSince = { ...today };
                }
                break;
            case "hungr":
            case "sott":
            case "ferd":
            case "ugg":
                /* Сбой откладывает кровь. Беременной он ничего не меняет:
                   там своя причина, и вторая поверх неё была бы шумом. */
                if (!next.pregnancy && !next.nursing) {
                    next.disruption = { id: event, at: { ...today } };
                }
                /* Но на утробу голод и хворь давят наравне с падением. */
                next = addStrain(next, event, today, ctx);
                break;
            case "heavy":
            case "strained":
            case "fell":
            case "beaten":
                next = addStrain(next, event, today, ctx);
                break;
            case "rest":
                /* Единственный ответ на угрозу, какой был у этого века:
                   лечь и не вставать. Помогает не всегда — какие угрозы
                   отлёживаются, решено в тот же миг, что и сама угроза. */
                next.resting = { ...today };
                if (next.pregnancy?.threat?.savable) {
                    const { threat, ...rest } = next.pregnancy;
                    next.pregnancy = { ...rest, held: { ...today } };
                }
                break;
            case "conceived":
                /* Сцена объявила зачатие — бросок больше не спрашиваем. */
                if (!next.pregnancy) next.pregnancy = newPregnancy(next, today, ctx);
                break;
            case "realized":
                /* Героиня поняла, что тяжела. Если в данных беременности нет —
                   значит бросок промахнулся, а игра ушла вперёд; верим сцене
                   и заводим дитя от последней близости. */
                if (!next.pregnancy) next.pregnancy = newPregnancy(next, today, ctx);
                if (!next.pregnancy.knownSince) {
                    next.pregnancy = { ...next.pregnancy, knownSince: { ...today } };
                }
                break;
            case "birth": {
                if (!next.pregnancy) break;
                const term = pregnancyTerm(next.pregnancy.conceived, today);
                const roll = rollStillbirth({
                    chatId: ctx.chatId,
                    risks: ctx.risks,
                    conceived: next.pregnancy.conceived,
                    termDays: term?.days ?? TERM_DAYS,
                    load: strainLoad(next.strain, today),
                });
                /* Сцена вправе объявить мертворождение сама — тогда бросок
                   не спрашиваем, как и при объявленном зачатии. */
                if (stillborn || roll.still) {
                    /* Дитя не заводим вовсе: мёртворождённого не окропляли
                       водой и не нарекали, по закону он человеком не стал.
                       Панели о нём сказать нечего, кроме самой потери. */
                    next.lastLoss = { at: { ...today }, kind: "stillborn", early: roll.early };
                    next.lastBleed = { ...today };
                } else {
                    /* Дитя заводим ДО того, как стереть беременность: пол
                       и число берутся из неё, а решены они были в день зачатия. */
                    next.children = [
                        ...(next.children ?? []),
                        ...bornChildren(next.pregnancy, today).map(
                            (c) => (roll.early ? { ...c, early: true } : c)),
                    ];
                    /* Кормление само по себе отменяет тидир — счёт цикла встаёт
                       до тех пор, пока дитя не отнимут от груди. */
                    next.nursing = { since: { ...today } };
                }
                delete next.pregnancy;
                delete next.oddBleed;
                delete next.strain;
                break;
            }
            /* Веха ставится тому, у кого её ещё нет: у двойни первым пошёл
               кто-то один, и записывать это обоим было бы неправдой. */
            case "childTooth":
                next.children = markMilestone(next.children, "tooth", today);
                break;
            case "childWalks":
                next.children = markMilestone(next.children, "walks", today);
                break;
            case "childSpeaks":
                next.children = markMilestone(next.children, "speaks", today);
                break;
            case "childSick":
                next.children = markMilestone(next.children, "sick", today, true);
                break;
            case "childWell":
                next.children = (next.children ?? []).map((c) => {
                    if (!c.sick) return c;
                    const { sick, ...rest } = c;
                    return rest;
                });
                break;
            case "stillborn":
                /* Прочитано выше, до разбора. «Дитя родилось мёртвым» задевает
                   сразу два правила — роды и исход, — и порядок между ними
                   зависел бы от того, как их записали в таблице событий.
                   Случай оставлен пустым нарочно: он и есть обработчик. */
                break;
            case "childDied":
                /* Уносим младшего: если умирает дитя, это почти всегда
                   новорождённое, а старшего сцена назвала бы по имени. */
                if (next.children?.length) {
                    const youngest = [...next.children].sort(
                        (a, b) => serialOf(b.born.year, b.born.month, b.born.day)
                            - serialOf(a.born.year, a.born.month, a.born.day))[0];
                    next.children = next.children.filter((c) => c !== youngest);
                    if (!next.children.length) delete next.children;
                }
                break;
            case "lost":
                if (next.pregnancy) next.lastLoss = { at: { ...today }, kind: "lost" };
                delete next.pregnancy;
                delete next.oddBleed;
                delete next.bleedEnded;
                delete next.strain;
                next.lastBleed = { ...today };
                break;
            case "nursingStart":
                if (!next.pregnancy) next.nursing = { since: { ...today } };
                break;
            case "nursingEnd":
                delete next.nursing;
                delete next.bleedEnded;
                next.lastBleed = { ...today };
                break;
            default:
                break;
        }
    }
    return Object.keys(next).length ? next : null;
}

/**
 * Близость — бросок на зачатие.
 *
 * Шанс берётся по фазе цикла, бросок детерминированный (см. rollConception).
 * Результат кладём в состояние целиком: он же показывается в отладке, и по
 * нему видно, был ли бросок вообще и насколько близко разошлось.
 */
/**
 * Насколько давняя близость ещё может считаться причиной.
 *
 * Без потолка «понесла» через полгода после единственной записанной близости
 * заводило дитя задним числом: героиня объявляла о беременности и в тот же ход
 * оказывалась на восьмой части ношения. Полтора цикла — предел, за которым
 * связывать одно с другим уже гадание, а не счёт.
 */
const SEED_MEMORY_DAYS = 45;

/**
 * Дитя, зачатое по слову сцены, а не по броску.
 *
 * Дата берётся от последней близости, если она была недавно: именно от неё
 * ребёнок и пошёл. Не было или было слишком давно — считаем от сегодняшнего дня.
 */
function newPregnancy(body, today, ctx = {}) {
    const seed = body.lastSeed;
    const ago = seed
        ? serialOf(today.year, today.month, today.day) - serialOf(seed.year, seed.month, seed.day)
        : null;
    const fresh = ago !== null && ago >= 0 && ago <= SEED_MEMORY_DAYS;
    const conceived = fresh ? { ...seed } : { ...today };
    return startedPregnancy(conceived, ctx);
}

/**
 * Новая запись о ношении.
 *
 * Пол и число дитяти решаются здесь, один раз, и ложатся В ЗАПИСЬ. Раньше пол
 * считали при каждом чтении из одной только даты зачатия — без чата в сиде,
 * поэтому две разные истории с одинаковым началом рожали одинаковых детей.
 */
function startedPregnancy(conceived, ctx = {}) {
    const births = rollBirths(ctx.chatId, conceived, ctx.multiples);
    const sexes = rollSexes(ctx.chatId, conceived, births);
    return {
        conceived,
        quickened: null,
        knownSince: null,
        births,
        sexes,
        /* Первый — он же тот, о ком гадают. Двойню до последней части срока
           всё равно никто не различает. */
        sex: sexes[0],
    };
}

/**
 * Дети, родившиеся из этой беременности.
 *
 * `order` нужен, чтобы двойня не жила в такт: нужды у них считаются от одного
 * дня рождения, и без порядкового номера оба всегда хотели бы одного и того же.
 */
function bornChildren(pregnancy, today) {
    const count = Math.max(1, pregnancy.births ?? 1);
    const sexes = pregnancy.sexes ?? [pregnancy.sex ?? null];
    return Array.from({ length: count }, (_, i) => ({
        born: { ...today },
        order: i,
        sex: sexes[i] ?? sexes[0] ?? null,
        name: null,
    }));
}

/**
 * Раздаёт имена детям из строки маркера.
 *
 * Двойню модель называет через «; », как и события: «Хельга; Торвальд».
 * Имена ложатся по порядку рождения и больше не меняются — переименование
 * после обряда наречения этот век не знал.
 */
/**
 * Отмечает веху у первого дитяти, у которого её ещё нет.
 *
 * @param {boolean} everyone true — ставить всем (хворь ходит по дому разом)
 */
function markMilestone(children, key, today, everyone = false) {
    if (!children?.length) return children;
    let done = false;
    return children.map((child) => {
        if (child[key]) return child;
        if (done && !everyone) return child;
        done = true;
        return { ...child, [key]: { ...today } };
    });
}

function nameChildren(children, told) {
    if (!children?.length || !told) return children;
    const names = String(told).split(";").map((s) => s.trim()).filter(Boolean);
    if (!names.length) return children;

    /* Именуем только тех, кто ещё под присмотром: имя из свежего маркера
       не должно переименовать давно выросшего. */
    let changed = false;
    const out = children.map((child, i) => {
        const name = names[i];
        if (!name || child.name === name || /^не наречен/i.test(name.replace(/ё/g, "е"))) return child;
        changed = true;
        return { ...child, name };
    });
    return changed ? out : children;
}

/**
 * Тягота легла на тело — и, если она беременна, бросок на угрозу.
 *
 * Список чистим от того, что уже отпустило: незачем таскать по всему чату
 * запись о голоде трёхмесячной давности. Порог — самая долгая тягота из всех.
 */
function addStrain(body, id, today, ctx = {}) {
    const spec = STRAINS[id];
    if (!spec) return body;

    const here = serialOf(today.year, today.month, today.day);
    const kept = (body.strain ?? []).filter((item) => {
        const age = here - serialOf(item.at.year, item.at.month, item.at.day);
        return age >= 0 && age < (STRAINS[item.id]?.days ?? 0);
    });
    const next = { ...body, strain: [...kept, { id, at: { ...today } }] };

    /* Угроза бывает только при дитяти, и только одна зараз: вторая поверх
       первой ничего не добавила бы, а сроки перепутала бы наверняка. */
    if (!next.pregnancy || next.pregnancy.threat) return next;

    const term = pregnancyTerm(next.pregnancy.conceived, today);
    if (!term) return next;

    const roll = rollThreat({
        chatId: ctx.chatId,
        risks: ctx.risks,
        today,
        conceived: next.pregnancy.conceived,
        termDays: term.days,
        load: strainLoad(next.strain, today),
        strainId: id,
    });
    next.lastThreatRoll = { at: { ...today }, id, ...roll };
    if (roll.hit) {
        next.pregnancy = {
            ...next.pregnancy,
            threat: { at: { ...today }, cause: id, outcome: roll.outcome, savable: roll.savable },
        };
    }
    return next;
}

/**
 * Угроза, провисевшая свой срок, сбывается.
 *
 * Зовётся из общего прохода по чату, когда дата доехала до дня расплаты.
 * Событие подставляется то же самое, каким его написала бы сцена, — поэтому
 * дальше всё идёт обычным путём, и никакой второй ветки состояний нет.
 */
function matureThreat(body, today, ctx = {}) {
    const threat = body?.pregnancy?.threat;
    if (!threat) return body;
    const due = serialOf(threat.at.year, threat.at.month, threat.at.day) + THREAT_DAYS;
    if (serialOf(today.year, today.month, today.day) < due) return body;

    /* Выкидыш — это факт, а не сцена: он случился, и сцене остаётся его
       описать. Роды раньше срока — наоборот, целая сцена, и отбирать её
       у ролевой нельзя. Поэтому здесь не рождение, а начало схваток;
       дитя родится, когда сцена напишет «родила». */
    if (threat.outcome === "lost") {
        return applyBodyEvents(body, ["lost"], today, ctx);
    }
    const { threat: gone, ...rest } = body.pregnancy;
    return { ...body, pregnancy: { ...rest, labour: { ...today }, early: true } };
}

function tryConceive(body, today, internal, ctx) {
    const next = { ...body };
    if (next.pregnancy || next.nursing) return next;

    /*
     * День близости запоминаем раньше всех проверок и независимо от них.
     *
     * Бросок может не состояться — утроба закрыта отваром, счёт цикла ещё
     * не заведён или дата сцены ушла раньше якоря крови, — а близость всё
     * равно была, и помнить её надо. Ради этого lastSeed и существует: если
     * сцена позже напишет «понесла», дитя отсчитается от этой ночи, а не от
     * дня, когда героиня о нём догадалась (см. newPregnancy).
     *
     * Раньше строка стояла в двух местах из трёх, и средний выход — тот,
     * что по несчитаемому циклу, — терял близость молча. Кончалось это
     * ношением, отставшим на месяц: панель показывала 1/9 там, где по счёту
     * было 2/9, и роды приезжали позже срока.
     */
    next.lastSeed = { ...today };

    /* После чёрных рожков утроба месяц не примет семени вовсе — это и есть
       настоящая цена спорыньи, а не смертельный исход по тумблеру. */
    if (herbBarren(next.herb, today)) return next;

    /* Фазу без якоря крови не вычислить, а без фазы нет и шанса. Бросок
       пропускаем, но выше уже записано, что близость была. */
    const cycle = cycleSummary(next, today, CYCLE_DEFAULT);
    if (!cycle) return next;

    const roll = rollConception({
        chatId: ctx.chatId,
        today,
        cycleDay: cycle.day,
        phaseId: cycle.phase.id,
        internal,
        chances: ctx.chances,
    });
    next.lastRoll = { at: { ...today }, ...roll, internal };
    if (roll.hit) {
        next.pregnancy = startedPregnancy({ ...today }, ctx);
    }
    return next;
}

/* ============================================================
 * 3b-bis. СКАЗАННОЕ ОДИН РАЗ
 *
 * Имя, данное при обряде, признание отцовства, положение дитяти по закону,
 * повитуха и приготовления к родам — это не наблюдения сцены, а факты. Модель
 * называет их однажды, а действуют они дальше.
 *
 * Раньше их читали из снимка последнего сообщения, и стоило модели не повторить
 * строку — панель их теряла. Теперь они едут по чату тем же обозом, что дата
 * и тело: выводятся заново на каждом пересчёте, поэтому откат и удаление
 * сообщений уносят их сами собой, как и всё остальное.
 * ============================================================ */

/** Готовность к родам: после родов она уже ни к чему. */
const BIRTH_WATCH_FIELDS = ["midwife"];

/**
 * Подхватывает названное в этом сообщении и решает, что пережило события.
 *
 * @param {object|null} told Что доехало сюда
 * @param {object} state Снимок сцены этого сообщения
 * @param {string[]} events События тела из того же сообщения
 */
function carryTold(told, state, events) {
    let next = told;
    for (const key of TOLD_FIELDS) {
        const value = state[key];
        if (!value || next?.[key] === value) continue;
        next = { ...(next ?? {}), [key]: value };
    }
    if (!next) return null;

    /* Дитя потеряно — вместе с ним уходит и всё, что о нём говорили. */
    if (events.includes("lost")) return null;

    /* Родила — приготовления сделали своё дело. Имя, фадерни и положение
       по закону остаются: они о самом дитяти, а не о ожидании. */
    if (events.includes("birth")) {
        const rest = { ...next };
        for (const key of BIRTH_WATCH_FIELDS) delete rest[key];
        return Object.keys(rest).length ? rest : null;
    }
    return next;
}

/** Номер эйкты 0–7, либо null. */
function eyktIndex(state) {
    return hasTime(state) ? eyktForHour(state.hour) : null;
}

/** Копия даты без служебного флага. */
function dateOf(entry) {
    if (!entry || entry.year == null) return null;
    return { year: entry.year, month: entry.month, day: entry.day };
}

/**
 * Проставляет датам по всему чату согласованные значения.
 *
 * Идёт с начала: несёт последнюю известную дату вперёд, на каждом сообщении
 * {{char}} перекладывая её в extra. Якоря по дороге перехватывают эстафету.
 *
 * Проход по всему чату, а не от конца: сдвинули якорь в середине — всё, что
 * после него, обязано пересчитаться. Дешёвая цена, зато нет состояния,
 * которое могло бы разъехаться с историей.
 *
 * Начальная дата приходит извне (из метаданных чата): её ставят в Tímatal ещё
 * до первого хода, когда цепляться в истории не за что.
 *
 * @param {Array} chat
 * @param {{year:number, month:number|"AUK", day:number}|null} startDate
 * @returns {{changed: boolean, current: object|null}} current — дата на конце чата
 */
export function resolveDates(chat, startDate = null, options = {}) {
    if (!Array.isArray(chat)) return { changed: false, current: null, body: null, told: null };

    let carried = dateOf(startDate); // дата, доехавшая сюда
    let lastEykt = null;             // эйкта сообщения, откуда её везём
    let changed = false;

    /*
     * Цикл по умолчанию начинается с первого дня в день начала чата.
     *
     * Иначе счёт не идёт вовсе, пока в сцене не случится кровь, — а можно
     * забыть, заторопиться или просто не захотеть начинать ролевую с этого.
     * Первый день — предположение, и любое явное указание его перебивает:
     * и событие в маркере, и рука в Tímatal.
     */
    let bodyCarried = carried ? { lastBleed: { ...carried } } : null;

    /* Названное однажды — имя дитяти, фадерни, повитуха — едет отдельно от
       тела: кровь и роды перезаводят счёт цикла, а имя от этого не меняется. */
    let toldCarried = null;

    /* Ручная запись из метаданных встаёт в тот день, на который её поставили,
       и дальше события сцены ложатся уже поверх неё. */
    const manual = options.manualBody?.at && options.manualBody?.body ? options.manualBody : null;
    let manualDone = !manual;
    const manualAt = manual ? serialOf(manual.at.year, manual.at.month, manual.at.day) : 0;

    for (const msg of chat) {
        if (!msg || !msg.extra) continue;

        /* Якоря читаем с любого сообщения, включая приветствие персонажа и
           реплики пользователя: на новом чате прицепиться больше не к чему.
           Оба — и дату, и цикл — до проверки на снимок, иначе выставленное
           в Tímatal до первого хода потерялось бы. */
        const bodyAnchor = msg.extra[KEY_BODY];
        if (bodyAnchor?.anchored) {
            /* Копируем якорь целиком: он несёт не только день цикла, но и
               беременность, выставленную руками. */
            const { anchored, ...rest } = bodyAnchor;
            bodyCarried = { ...rest, anchored: true };
        }

        /* Якорь даты фиксирует день, но сообщение на этом не заканчивается:
           в том же маркере могут стоять и события тела. Раньше здесь стоял
           continue, и «семя пролилось» в сообщении с датой просто терялось. */
        const anchor = msg.extra[KEY_DATE];
        const anchorDate = dateOf(anchor);

        /* Якорь без года — не якорь.
           Модель, сбившись посреди маркера, пишет «date: 6 сольмануд» без
           года; старая проверка на дату года не требовала, и такая запись
           уезжала в extra якорем с year: null. Дальше её читали как дату —
           и всё чтение чата падало на первом же обращении к year. Панель
           после этого замирала на прошлой истории, Tímatal не открывался,
           а инжект молча переставал собираться: одно исключение гасило всю
           цепочку.

           Такие записи вычищаем на месте. Рукой их не поставить —
           setSceneDate всегда пишет полную дату, — так что терять нечего,
           а чат, уже испорченный старой сборкой, лечится сам. */
        if (anchor?.anchored && !anchorDate) {
            delete msg.extra[KEY_DATE];
            changed = true;
        }

        const anchored = !!anchor?.anchored && !!anchorDate;
        if (anchored) {
            /* Дату из маркера сверяем с той, что доехала сюда: время вперёд
               или стоит, но назад на полгода оно не ходит. */
            carried = rollLostYear(anchorDate, carried, anchor.source);
            lastEykt = eyktIndex(msg.extra[KEY_STATE]);
            /* Первая же известная дата открывает и счёт цикла: иначе он начнётся
               со следующего сообщения, то есть на сутки позже календаря. */
            if (!bodyCarried) bodyCarried = { lastBleed: { ...carried } };
        }

        /* А вот выведенную дату кладём только туда, где есть снимок сцены:
           только такие сообщения потом кто-то читает. */
        if (msg.is_user) continue;
        const state = msg.extra[KEY_STATE];
        if (!state) continue;

        if (!carried) {
            if (msg.extra[KEY_DATE] !== undefined) { delete msg.extra[KEY_DATE]; changed = true; }
            continue;
        }

        const eykt = eyktIndex(state);
        /* День, названный якорем, никуда не двигаем — он и есть ответ. */
        if (!anchored) {
            if (state.passed != null) {
                /* Названный скачок бьёт догадку по эйкте. «Прошло два месяца»
                   с точки зрения эйкт выглядит как обычное утро, и складывать
                   одно с другим значило бы приписать сцене лишние сутки. */
                if (state.passed > 0) {
                    carried = addDays(carried.year, carried.month, carried.day, state.passed);
                }
            } else if (eykt !== null && lastEykt !== null && eykt < lastEykt) {
                /* Эйкта откатилась назад — значит через полночь перевалили. */
                carried = addDays(carried.year, carried.month, carried.day, 1);
            }
        }
        if (eykt !== null) lastEykt = eykt;

        if (!anchored) {
            const resolved = { ...carried, anchored: false };
            if (JSON.stringify(msg.extra[KEY_DATE]) !== JSON.stringify(resolved)) {
                msg.extra[KEY_DATE] = resolved;
                changed = true;
            }
        }

        /* Дошли до дня, на который поставили руками, — ручное берёт верх. */
        if (!manualDone && serialOf(carried.year, carried.month, carried.day) >= manualAt) {
            bodyCarried = JSON.parse(JSON.stringify(manual.body));
            manualDone = true;
        }

        /* Тело едет тем же обозом, что и дата: событие «кровь пришла»
           запоминает день, от которого дальше считается цикл. Считаем прямо
           здесь, потому что дата этого сообщения уже известна — отдельным
           проходом пришлось бы вычислять её заново.

           Якорь, поставленный руками, прочитан выше и любые события до него
           уже перебил; событие в этом же сообщении, наоборот, свежее. */
        /* Близость приходит отдельными полями: сцена её видит, а событием
           в общем списке она смотрелась бы наравне с родами. */
        const events = [...(state.body ?? [])];
        if (state.sex === true) {
            events.unshift(state.internal === false ? "seedWithheld" : "seedSpilled");
        }
        if (!msg.extra[KEY_BODY]?.anchored && events.length) {
            bodyCarried = applyBodyEvents(bodyCarried, events, carried, {
                chatId: options.chatId,
                chances: options.chances,
                risks: options.risks,
            });
        }

        /*
         * Угроза, провисевшая свои два дня, сбывается сама — здесь, в общем
         * проходе, потому что здесь известна дата этого сообщения.
         *
         * Считать это в панели было бы проще и неверно: панель показывает,
         * а состояние меняет только разбор событий. Иначе выкидыш случился бы
         * на экране, а в счёте цикла — нет.
         *
         * ПОСЛЕ событий сообщения, и это важно: «легла пластом» в тот самый
         * день, когда срок вышел, обязано успеть. Иначе последний день угрозы
         * был бы уже не последним, а прошедшим.
         */
        if (!msg.extra[KEY_BODY]?.anchored) {
            bodyCarried = matureThreat(bodyCarried, carried, {
                chatId: options.chatId,
                chances: options.chances,
                risks: options.risks,
            });
        }
        toldCarried = carryTold(toldCarried, state, events);

        /* Имя из маркера ложится на рождённых детей. Делаем это здесь, а не
           в applyBodyEvents: имя приходит отдельным полем и живёт в told,
           а события про него ничего не знают. */
        if (bodyCarried?.children?.length && toldCarried?.childName) {
            const named = nameChildren(bodyCarried.children, toldCarried.childName);
            if (named !== bodyCarried.children) bodyCarried = { ...bodyCarried, children: named };
        }

        /* Выросших из-под присмотра убираем: два года — и дитя больше не
           младенец, панели о нём сказать нечего. */
        if (bodyCarried?.children?.length) {
            const here = serialOf(carried.year, carried.month, carried.day);
            const young = bodyCarried.children.filter(
                (c) => here - serialOf(c.born.year, c.born.month, c.born.day) <= CHILD_WATCH_DAYS);
            if (young.length !== bodyCarried.children.length) {
                bodyCarried = { ...bodyCarried };
                if (young.length) bodyCarried.children = young;
                else delete bodyCarried.children;
            }
        }
        /* Даты начала чата не было (её дал старый маркер посреди истории) —
           начинаем счёт с первого дня отсюда. */
        if (!bodyCarried) bodyCarried = { lastBleed: { ...carried } };
        if (msg.extra[KEY_BODY]?.anchored) {
            /* Ручную отметку не трогаем вовсе — она тут и стоит. */
        } else if (bodyCarried) {
            /* А флаг ручной установки вперёд не едет: он помечает то самое
               сообщение, где день задали, а не всё, что после него. Иначе
               откат назад упёрся бы в «якорь», которого никто не ставил. */
            const stored = { lastBleed: bodyCarried.lastBleed };
            if (JSON.stringify(msg.extra[KEY_BODY]) !== JSON.stringify(stored)) {
                msg.extra[KEY_BODY] = stored;
                changed = true;
            }
        } else if (msg.extra[KEY_BODY] !== undefined) {
            delete msg.extra[KEY_BODY];
            changed = true;
        }
    }
    /* Поставили «на сегодня», а сообщений с этой датой ещё нет — тогда
       ручное просто становится последним словом. */
    if (!manualDone) bodyCarried = JSON.parse(JSON.stringify(manual.body));

    return { changed, current: carried, body: bodyCarried, told: toldCarried };
}

/**
 * Ставит якорь даты на последнее сообщение чата.
 *
 * На сообщение, а не в настройки: тогда откат назад и удаление сообщений
 * уносят поправку вместе с собой, как и весь остальной снимок.
 *
 * Годится любое сообщение — приветствие персонажа, реплика пользователя,
 * что угодно. В новом чате снимков ещё нет, а дату выставить надо ДО первого
 * хода, иначе первый же ответ уедет не в тот день.
 *
 * Совсем пустой чат — единственный случай, когда цепляться не за что; тогда
 * дату держат метаданные чата, это забота вызывающего.
 *
 * @param {Array} chat
 * @param {{year:number, month:number|"AUK", day:number}} date
 * @param {{year:number, month:number|"AUK", day:number}|null} startDate
 * @returns {boolean} true, если было куда поставить
 */
export function setSceneDate(chat, date, startDate = null, options = {}) {
    if (!Array.isArray(chat) || !date || date.year == null) return false;
    const last = chat[chat.length - 1];
    if (!last) return false;
    last.extra = last.extra || {};
    last.extra[KEY_DATE] = { year: date.year, month: date.month, day: date.day, anchored: true, source: "user" };
    resolveDates(chat, startDate, options);
    return true;
}

/** Дата, действующая на конце чата, либо null. */
export function findSceneDate(chat, startDate = null, options = {}) {
    return resolveDates(chat, startDate, options).current;
}

/* ============================================================
 * 3c. РУЧНАЯ УСТАНОВКА
 *
 * Выставленное руками НЕ живёт на сообщении, и это выстраданное решение.
 *
 * Сначала якорь тела клался в extra последнего сообщения — рядом со снимком
 * сцены, «как всё остальное». Логика проходила все тесты, а в живой таверне
 * беременность не появлялась вовсе. Разница в том, чего нет в тестах: extra
 * последнего сообщения переживает не всё. Свайп подставляет копию из
 * swipe_info, перегенерация заводит свою, удаление уносит целиком — и якорь
 * исчезает в любой из этих щелей, молча.
 *
 * Дата начала чата с самого начала лежит в метаданных и работает исправно.
 * Ручное состояние тела — такой же авторский акт, а не событие сцены, и жить
 * ему там же. Плата честная: откат чата ручную установку не отменяет.
 *
 * Функции ниже ничего не сохраняют сами — они возвращают запись, а класть её
 * в метаданные дело вызывающего. Так их можно гонять в тестах без таверны.
 * ============================================================ */

/**
 * Запись ручного счёта цикла: «сегодня такой-то день».
 *
 * Внутри хранится дата последней крови — она одна, день цикла из неё
 * выводится. Обратный пересчёт делаем здесь, чтобы наружу торчало
 * человеческое «сегодня двенадцатый день».
 */
export function cycleAnchor(today, day) {
    if (!today || today.year == null) return null;
    const n = Math.max(1, Math.round(Number(day) || 1));
    return {
        at: { ...today },
        body: { lastBleed: serialToDate(serialOf(today.year, today.month, today.day) - (n - 1)) },
    };
}

/**
 * Запись ручной беременности — чтобы начать ролевую уже тяжёлой.
 *
 * Дату зачатия можно не знать: тогда считаем назад от названной части срока.
 * Такая дата помечается вычисленной, и в отладке видно, что она не настоящая.
 *
 * @param {object} today Дата сцены
 * @param {{part?: number, conceived?: object|null, known?: boolean, father?: string|null}|null} setup
 *        null — снять беременность
 * @param {object|null} previous Что уже накопилось, чтобы не потерять
 */
export function pregnancyAnchor(today, setup, previous = null, ctx = {}) {
    if (!today || today.year == null) return null;

    /* Сняли — цикл начинается заново от сегодняшнего дня. */
    if (setup === null) return { at: { ...today }, body: { lastBleed: { ...today } } };

    const part = Math.max(1, Math.min(9, Math.round(Number(setup.part) || 1)));
    const conceived = setup.conceived
        ? { ...setup.conceived }
        : serialToDate(serialOf(today.year, today.month, today.day) - (part - 1) * 30);

    /* Сколько дитяти. Не назвали — жребий по дате зачатия, как при обычном
       зачатии в игре. Назвали — столько и будет: это авторский акт. */
    const births = setup.births
        ? Math.max(1, Math.min(3, Math.round(Number(setup.births))))
        : (previous?.births ?? rollBirths(ctx.chatId, conceived, ctx.multiples));

    /*
     * Пол. «Случайно» — это не «оставить как было», а бросок по дате зачатия:
     * он детерминированный, поэтому на одну и ту же дату всегда даёт одно и то
     * же. Названный пол ставится всем: у двойни выбор один на обоих, иначе
     * форма разрослась бы в три отдельных списка ради редкого случая.
     */
    const chosen = setup.sex === "m" || setup.sex === "f" ? setup.sex : null;
    const sexes = chosen
        ? Array.from({ length: births }, () => chosen)
        : rollSexes(ctx.chatId, conceived, births);

    return {
        at: { ...today },
        body: {
            lastBleed: serialToDate(serialOf(conceived.year, conceived.month, conceived.day) - 13),
            pregnancy: {
                conceived,
                guessedDate: !setup.conceived,
                /* Правка части срока не отменяет того, что уже случилось:
                   шевельнулось — значит шевельнулось. */
                quickened: previous?.quickened ?? null,
                knownSince: setup.known ? (previous?.knownSince ?? { ...today }) : null,
                births,
                sexes,
                sex: sexes[0],
                /* Отца не выдумываем. Не назвали — так и останется неназванным:
                   в этом сеттинге отцовство не биология, а признание, и
                   приписывать его за игрока нельзя. */
                father: setup.father ?? previous?.father ?? null,
            },
        },
    };
}

/**
 * Призыв Фригг — схватки начинаются сейчас, что бы ни было в сцене.
 *
 * Фригг звали в родах; это её час. Кнопка нужна затем, что иногда ролевая
 * подошла к родам, а движок ждёт своего дня, — и спорить с автором о том,
 * когда начнутся схватки, расширению не по чину.
 *
 * Отменять призыв нечем, и это правильно: схватки не отыгрываются назад.
 * Передумала — «Убрать дитя» или выставь ношение заново.
 *
 * @param {object} today Дата сцены
 * @param {object|null} previous Что уже накоплено про эту беременность
 */
export function labourAnchor(today, previous = null) {
    if (!today || today.year == null || !previous?.conceived) return null;
    return {
        at: { ...today },
        body: {
            lastBleed: serialToDate(
                serialOf(previous.conceived.year, previous.conceived.month, previous.conceived.day) - 13),
            pregnancy: {
                ...previous,
                /* Угрозу снимаем: схватки её уже переросли, и держать обе
                   значило бы показывать в панели две беды разом. */
                threat: undefined,
                labour: { ...today },
                /* Роды — тот миг, когда о дитяти знают все. */
                knownSince: previous.knownSince ?? { ...today },
                summoned: true,
            },
        },
    };
}

/**
 * Женское питьё — отвар, возвращающий кровь.
 *
 * Траву не выбирают: героиня пьёт то, что дали. Движок берёт её по сезону и
 * по жребию, и жребий этот детерминированный — пересчёт истории не должен
 * подменить траву задним числом.
 *
 * Разницы между «прервало» и «прерывать было нечего» наружу не отдаём:
 * женщина видит одно и то же, кровь пришла. Правда живёт в скрытом слое.
 *
 * @param {object} today Дата сцены
 * @param {object|null} body Что накопилось к этому дню
 * @param {{chatId?: string, death?: boolean}} ctx
 */
export function herbAnchor(today, body, ctx = {}) {
    if (!today || today.year == null) return null;

    const herb = pickHerb(ctx.chatId, today);
    const pregnant = !!body?.pregnancy;
    const roll = rollHerb({ chatId: ctx.chatId, today, herb, pregnant, death: !!ctx.death });

    const next = { ...(body ?? {}) };
    next.herb = {
        id: herb.id,
        at: { ...today },
        worked: roll.worked,
        /* Скрытый слой: было ли что прерывать. В панель не выходит никогда. */
        wasPregnant: pregnant,
        fatal: roll.fatal,
    };

    if (roll.worked) {
        /* Кровь пришла. И если было дитя — его больше нет.
           Потерю не записываем: героиня о ней не узнает, а панель молчит
           о том, чего героиня не знает. */
        delete next.pregnancy;
        delete next.disruption;
        delete next.bleedEnded;
        delete next.oddBleed;
        next.lastBleed = { ...today };
    } else if (next.pregnancy) {
        /* Не подействовало — дитя осталось, но отвар его достал.
           Что из этого выйдет, решим позже: пока только отметка. */
        next.pregnancy = { ...next.pregnancy, herbExposure: { id: herb.id, at: { ...today } } };
    }

    return { at: { ...today }, body: next };
}

/** Состояние тела на конце чата, либо null. */
export function findBodyState(chat, startDate = null, options = {}) {
    return resolveDates(chat, startDate, options).body;
}

/* ============================================================
 * 4. MAINTENANCE
 * ============================================================ */

/**
 * Разовый проход по всей истории: разобрать маркеры, вырезать их из текста.
 * Используется при смене чата (миграция старых блоков) и кнопкой в настройках.
 *
 * @returns {number} Сколько сообщений изменилось
 */
export function syncWholeChat(chat, options = {}) {
    if (!Array.isArray(chat)) return 0;
    let count = 0;
    for (const msg of chat) {
        if (syncMessage(msg, options)) count++;
    }
    return count;
}

/** Есть ли в истории необработанные маркеры. */
export function chatHasRawMarkers(chat) {
    if (!Array.isArray(chat)) return false;
    return chat.some((m) => m && !m.is_user && typeof m.mes === "string" && hasUrd(m.mes));
}
