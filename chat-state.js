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
 * снимок сцены, дата и тело, — считается за один вызов
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
 * раскладывает даты и ведёт счёт тела.
 *
 * @param {Array} chat Массив сообщений
 * @param {{year:number, month:number|"AUK", day:number}|null} startDate Дата начала чата
 * @param {{ keepMarker?: boolean, manualBody?: object }} options
 * @returns {{ state: object|null, index: number, date: object|null, body: object|null,
 *             changed: boolean }}
 */
export function readChat(chat, startDate = null, options = {}) {
    const empty = { state: null, index: -1, date: null, body: null, changed: false };
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
    if (!Array.isArray(chat)) return { changed: false, current: null, body: null };

    let carried = dateOf(startDate); // дата, доехавшая сюда
    let lastEykt = null;             // эйкта сообщения, откуда её везём
    let changed = false;

    /*
     * Цикл по умолчанию начинается с первого дня в день начала чата.
     *
     * Иначе счёт не идёт вовсе, пока в сцене не случится кровь, — а можно
     * забыть, заторопиться или просто не захотеть начинать ролевую с этого.
     * Первый день — предположение, и рука в Tímatal его перебивает.
     */
    let bodyCarried = carried ? { lastBleed: { ...carried } } : null;

    /* Ручная запись из метаданных встаёт в тот день, на который её поставили,
       и дальше счёт идёт уже от неё. */
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
           ниже по нему ещё ведётся счёт тела. */
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

    return { changed, current: carried, body: bodyCarried };
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
 * Запись ручной беременности — чтобы вести срок ношения.
 *
 * Дату зачатия можно не знать: тогда считаем назад от названной части срока.
 * Такая дата помечается вычисленной — чтобы форма в Tímatal знала, что
 * подставила её сама.
 *
 * Кровь при этом ставится за две недели до зачатия, как и бывает: снимут
 * беременность — цикл начнётся заново от того дня, который назовут.
 *
 * @param {object} today Дата сцены
 * @param {{part?: number, conceived?: object|null}|null} setup
 *        null — снять беременность
 */
export function pregnancyAnchor(today, setup) {
    if (!today || today.year == null) return null;

    /* Сняли — цикл начинается заново от сегодняшнего дня. */
    if (setup === null) return { at: { ...today }, body: { lastBleed: { ...today } } };

    const part = Math.max(1, Math.min(9, Math.round(Number(setup.part) || 1)));
    const conceived = setup.conceived
        ? { ...setup.conceived }
        : serialToDate(serialOf(today.year, today.month, today.day) - (part - 1) * 30);

    return {
        at: { ...today },
        body: {
            lastBleed: serialToDate(serialOf(conceived.year, conceived.month, conceived.day) - 13),
            pregnancy: { conceived, guessedDate: !setup.conceived },
        },
    };
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
