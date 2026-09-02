/*
 * NORNIR — Tímatal, мини-справочник по счёту времени.
 *
 * Tímatal (др.-исл. «счёт времени») — окно из меню «волшебной палочки»
 * рядом с полем ввода. Собирает в одном месте эйкты, месяцы, дни недели,
 * фазы Луны и шпаргалку по маркеру, чтобы не сверяться с заметками
 * посреди ролевой.
 *
 * Окно живёт двумя видами. Сперва карта: одиннадцать клейм, разложенных
 * по двум ларям — «Книга времени» (знание о мире) и «Мастерская» (то, как
 * расширение с этим знанием обходится). Щелчок по клейму открывает страницу
 * раздела во всю ширину окна, «← карта» возвращает обратно. Полотна из всех
 * разделов разом больше нет: у каждого своё окно, и потому кегль здесь
 * крупнее, чем был.
 *
 * Настройки вида запоминаются:
 *  - колонки выбираются облачками над таблицей: затемнённое облачко —
 *    колонки нет, зажжённое — есть. Выбор общий для всех таблиц: включили
 *    «Транслит» — он появился и в эйктах, и в месяцах.
 *  - колонка с древнескандинавским написанием (а в эйктах ещё и номер)
 *    постоянная: это опора таблицы, её не выключить.
 *
 * Если в чате уже есть инфоблок, текущая эйкта, месяц, день недели и фаза
 * Луны подсвечиваются — видно не только «какие бывают», но и «где мы сейчас»;
 * та же строка стоит на карте и в шапке каждой страницы.
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Helpers ............ Мелкие конструкторы DOM
 * 2. Columns ............ Реестр колонок, облачки выбора и таблица
 * 3. Sections ........... Эйкты, месяцы, дни недели, Луна, праздники, блок
 * 4. Assembly ........... Карта клейм и страница раздела
 *
 * Мастерская — не про счёт времени, а про поведение расширения: дата сцены,
 * утроба, уведомления, блок маркера, оформление. Стоит она здесь, а не в
 * панели настроек таверны, по одной причине: всё это настраивают, глядя на
 * чат, а справочник открыт поверх него.
 */

import { t } from "../../../i18n.js";

import { OBVIOUS_DAY, phaseOf, pregnancySummary } from "./body.js";

import { NOTICE_KINDS } from "./notify.js";

import {
    AUKNAETR_DAYS,
    AUK_AFTER_MONTH,
    COMMON_YEAR_DAYS,
    EYKTIR,
    MONTHS,
    MOON_PHASES,
    SUMARAUKI_DAYS,
    WEEKDAYS,
    aukDays,
    eyktForHour,
    hasDate,
    hasTime,
    isAuk,
    isSumaraukiYear,
    isValidDate,
    moonPhase,
    serialOf,
    serialToDate,
    seasonOf,
    vikaOf,
    weekdayOf,
    weeksInMisseri,
    dayOfMisseri,
    misseriLength,
} from "./parser.js";

import {
    HOLIDAYS,
    HOLIDAY_REGIONS,
    HOLIDAY_TIERS,
    holidayEnd,
    holidayStart,
    holidaysOn,
    nextHoliday,
} from "./holidays.js";

/* Справочник показывает ВСЕ слои, какие бы ни стояли в настройках: это
   книга, а не панель. Что из этого видно в инфоблоке, сказано примечанием
   под таблицами. */
const ALL_TIERS = HOLIDAY_TIERS.map((tier) => tier.id);

/* ============================================================
 * 1. HELPERS
 * ============================================================ */

function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

/* ============================================================
 * 2. COLUMNS
 *
 * Ключ колонки общий для всех таблиц, подпись — функция, потому что
 * перевод берётся в момент отрисовки. Подписи короткие: они же служат
 * надписями на облачках.
 * ============================================================ */

const COLUMN_LABELS = {
    num: () => "#",
    norse: () => t`Old Norse`,
    translit: () => t`Translit`,
    ru: () => t`Russian`,
    en: () => t`English`,
    modern: () => t`Modern`,
    hours: () => t`Hours`,
    cycle: () => t`Cycle days`,
    meaning: () => t`Meaning`,
    sun: () => t`Sun`,
    short: () => t`Short`,
    /* Праздники: когда стоит, сколько длится, чей и откуда известен. */
    when: () => t`Date`,
    weekday: () => t`Weekday`,
    days: () => t`Days`,
    region: () => t`Region`,
    source: () => t`Known from`,
};

/**
 * Постоянные колонки — опора таблицы, их не выключить и облачков у них нет.
 * Древнескандинавское написание есть везде, номер — только в эйктах; в CSS
 * они прижаты друг к другу, чтобы читались как одно целое.
 *
 * Дата праздника здесь по той же причине, что и номер месяца: праздник без
 * своего дня — не сведение, а имя. Колонки по умолчанию выключены все, кроме
 * русской, и таблица праздников открывалась бы вовсе без дат. В прочих
 * таблицах ключа `when` нет, так что им это ничего не меняет.
 */
export const PERMANENT_COLUMNS = ["num", "norse", "when"];

export const isPermanent = (key) => PERMANENT_COLUMNS.includes(key);

/** Ряд облачков: какие колонки показывать в таблицах этого раздела. */
function chipsRow(columns, prefs) {
    const row = h("div", "nrn-t-chips-row");
    for (const key of columns) {
        if (isPermanent(key)) continue;
        const on = prefs.isColumnVisible(key);
        const chip = h("button", on ? "nrn-t-chip nrn-t-chip-on" : "nrn-t-chip");
        chip.type = "button";
        chip.dataset.col = key;
        chip.setAttribute("aria-pressed", String(on));
        chip.textContent = COLUMN_LABELS[key]();
        row.append(chip);
    }
    return row;
}

/**
 * Таблица справочника.
 *
 * Ячейки выключенных колонок остаются в разметке, но получают display: none —
 * так переключение облачка не требует пересобирать таблицу, а колонка исчезает
 * целиком и ширины не занимает.
 *
 * @param {string[]} columns Ключи колонок в порядке показа
 * @param {Array<{cells: Record<string, string|Node>, current?: boolean}>} rows Строки
 * @param {object} prefs Настройки вида (см. buildReference)
 */
function table(columns, rows, prefs) {
    const scroller = h("div", "nrn-t-table-wrap");
    const tbl = h("table", "nrn-t-table");

    const thead = h("thead");
    const headRow = h("tr");
    for (const key of columns) {
        const th = h("th", prefs.isColumnVisible(key) ? null : "nrn-t-col-off");
        th.dataset.col = key;
        th.textContent = COLUMN_LABELS[key]();
        headRow.append(th);
    }
    thead.append(headRow);
    tbl.append(thead);

    const tbody = h("tbody");
    for (const row of rows) {
        const tr = h("tr", row.current ? "nrn-t-current" : null);
        if (row.current) tr.title = t`Current state of the scene`;
        for (const key of columns) {
            const td = h("td", prefs.isColumnVisible(key) ? null : "nrn-t-col-off");
            td.dataset.col = key;
            const cell = row.cells[key];
            if (cell instanceof Node) td.append(cell);
            else if (cell !== undefined && cell !== null) td.textContent = String(cell);
            tr.append(td);
        }
        // Маркер вешается на первую ячейку — она всегда постоянная, так что
        // подсветка текущей строки не пропадёт вместе с выключенной колонкой.
        if (row.current) tr.firstElementChild?.prepend(h("span", "nrn-t-marker", "▸"));
        tbody.append(tr);
    }
    tbl.append(tbody);

    scroller.append(tbl);
    return scroller;
}

/** Применяет состояние колонки ко всем таблицам и облачкам окна. */
function applyColumn(root, key, visible) {
    for (const cell of root.querySelectorAll(`th[data-col="${key}"], td[data-col="${key}"]`)) {
        cell.classList.toggle("nrn-t-col-off", !visible);
    }
    for (const chip of root.querySelectorAll(`.nrn-t-chip[data-col="${key}"]`)) {
        chip.classList.toggle("nrn-t-chip-on", visible);
        chip.setAttribute("aria-pressed", String(visible));
    }
}

/* ============================================================
 * 3. SECTIONS
 * ============================================================ */

/** Строка «сейчас в сцене», показывается только когда инфоблок разобран. */
function nowBanner(state) {
    if (!hasTime(state) && !hasDate(state)) return null;

    const parts = [];
    if (hasTime(state)) {
        const e = EYKTIR[eyktForHour(state.hour)];
        const hh = String(state.hour).padStart(2, "0");
        const mm = String(state.minute ?? 0).padStart(2, "0");
        parts.push(`${e.ru} · ${hh}:${mm}`);
    }
    if (hasDate(state)) {
        const { year, month, day } = state;
        if (isAuk(month)) {
            parts.push(`${isSumaraukiYear(year) ? "Sumarauki" : "Auknætr"} ${day}/${aukDays(year)}, ${year}`);
        } else {
            parts.push(`${day} ${MONTHS[month - 1].ru} ${year}`);
        }
        parts.push(WEEKDAYS[weekdayOf(year, month, day)].ru);
        parts.push(`vika ${vikaOf(year, month, day)}/${weeksInMisseri(year, month)}`);
        const { phase } = moonPhase(year, month, day);
        parts.push(`${phase.icon} ${phase.norse}`);
    }

    const banner = h("div", "nrn-t-now");
    banner.append(h("span", "nrn-t-now-label", t`In the scene now`));
    banner.append(h("span", "nrn-t-now-value", parts.join("  •  ")));
    return banner;
}

function lead(text) {
    return h("div", "nrn-t-lead", text);
}

/**
 * Тройка «день — месяц — год» древнеисландского календаря.
 *
 * Заведена общей, потому что мест два: дата сцены и дата зачатия. Раньше
 * такая тройка была одна и жила внутри выбора даты; вторую было бы проще
 * скопировать, но тогда правило про аукнэтр — в них дней четыре, а в год
 * сумарауки одиннадцать — пришлось бы помнить в двух местах.
 *
 * @param {object|null} initial С чего начать
 * @param {() => void} onChange Что позвать после каждой правки
 * @returns {{nodes: HTMLElement[], read: () => object, set: (d: object) => void}}
 */
function dateFields(initial, onChange = () => {}) {
    const select = (cls, options, chosen) => {
        const el = h("select", `nrn-t-picker-select ${cls}`);
        for (const [value, label] of options) {
            const opt = h("option", null, label);
            opt.value = String(value);
            if (String(value) === String(chosen)) opt.selected = true;
            el.append(opt);
        }
        return el;
    };

    const days = [];
    for (let d = 1; d <= 30; d++) days.push([d, String(d)]);
    const months = MONTHS.map((m, i) => [i + 1, m.ru]);
    months.splice(AUK_AFTER_MONTH, 0, ["AUK", "Аукнэтр"]);

    const start = initial?.year != null ? initial : { year: 1015, month: 1, day: 1 };
    const dayEl = select("nrn-t-picker-day", days, start.day);
    const monthEl = select("nrn-t-picker-month", months, start.month);
    const yearEl = h("input", "nrn-t-picker-year");
    yearEl.type = "number";
    yearEl.value = String(start.year);

    const read = () => ({
        year: Number(yearEl.value),
        month: monthEl.value === "AUK" ? "AUK" : Number(monthEl.value),
        day: Number(dayEl.value),
    });

    /* В аукнэтр дней всего четыре, а в год сумарауки одиннадцать — знать это
       пользователю неоткуда, поэтому лишние числа просто гасим. */
    const clamp = () => {
        const d = read();
        const max = d.month === "AUK" ? aukDays(d.year) : 30;
        for (const opt of dayEl.options) opt.disabled = Number(opt.value) > max;
        if (Number(dayEl.value) > max) dayEl.value = String(max);
    };

    const set = (d) => {
        if (!d || d.year == null) return;
        yearEl.value = String(d.year);
        monthEl.value = String(d.month);
        clamp();
        dayEl.value = String(d.day);
        clamp();
    };

    for (const el of [dayEl, monthEl, yearEl]) {
        el.addEventListener("input", () => { clamp(); onChange(); });
    }
    clamp();

    return { nodes: [dayEl, monthEl, yearEl], read, set };
}

/** Дата словом — «5 сольмануда 1015», как её прочла бы хозяйка. */
function dateWords(d) {
    if (!d || d.year == null) return "";
    const name = d.month === "AUK" ? "аукнэтр" : MONTHS[d.month - 1].ru.toLowerCase();
    return `${d.day} ${name} ${d.year}`;
}

/*
 * Открыта ли форточка правды.
 *
 * Флаг живёт в модуле, а не в настройках, и это выбор. Сохранённый в настройки
 * спойлер встречал бы автора распахнутым на новом чате — а он ровно то, на что
 * не хотят наткнуться случайно. Здесь он забывается вместе с перезагрузкой
 * страницы и переживает только пересборку окна: нажала «Поставить» — правда
 * не захлопнулась под руками.
 */
let truthOpen = false;

/**
 * Форточка правды — то, чего героиня знать не может.
 *
 * Панель, промпт и приметы устроены вокруг незнания: женщина видит, что кровь
 * не пришла, а не то, что бросок на зачатие лёг 0.417 против 0.250. Но автор
 * иногда обязан знать наверняка — иначе остаётся ждать полсотни ходов, чтобы
 * выяснить, было ли вообще о чём писать.
 *
 * Поэтому: закрыто по умолчанию, открывается нажатием, и ни одна строка отсюда
 * не уходит ни в промпт, ни в инфоблок.
 *
 * @param {{headline: string, rows: Array<{label: string, value: string}>}|null} truth
 */
function truthBox(truth) {
    const box = h("div", "nrn-t-truth");

    const toggle = h("button", "nrn-t-truth-toggle");
    toggle.type = "button";
    const body = h("div", "nrn-t-truth-body");

    if (!truth) {
        body.append(h("div", "nrn-t-picker-echo",
            t`Nothing to tell yet: the date of the scene is not set, so there is nothing to count from.`));
    } else {
        body.append(h("div", "nrn-t-truth-headline", truth.headline));
        for (const row of truth.rows) {
            const line = h("div", "nrn-t-truth-row");
            line.append(h("span", "nrn-t-truth-label", row.label),
                h("span", "nrn-t-truth-value", row.value));
            body.append(line);
        }
    }

    const syncOpen = () => {
        toggle.textContent = truthOpen ? t`Close it` : t`Look`;
        toggle.setAttribute("aria-expanded", String(truthOpen));
        body.classList.toggle("nrn-t-hidden", !truthOpen);
    };
    toggle.addEventListener("click", () => { truthOpen = !truthOpen; syncOpen(); });
    syncOpen();

    box.append(toggle, body);
    return box;
}

/**
 * Управление циклом.
 *
 * Ролевая не обязана начинаться с крови: можно начать с овуляции, и это такой
 * же законный старт. Отсюда же чинится сбившийся счёт — выставила день, и
 * дальше всё поехало от него.
 *
 * Показываем не «дату последней крови», а человеческое «сегодня такой-то
 * день»: внутри-то хранится дата, но пользователю считать её в уме незачем.
 *
 * Блок показывается и без даты сцены. Раньше он до неё не существовал вовсе —
 * и на новом чате Утроба просто отсутствовала, а из окна не было видно, есть
 * она вообще или отключена настройкой. Теперь блок на месте, кнопки в нём
 * погашены, и сказано почему.
 *
 * @param {{summary: object|null, length: number, onSet: (day:number)=>boolean}} cycle
 */
function cyclePicker(cycle) {
    const box = h("div", "nrn-t-picker");
    box.append(h("div", "nrn-t-picker-title", t`Womb`));

    /* Кнопка мигает подтверждением и возвращает прежнюю надпись: окно
       не перерисовывается, и без отклика непонятно, нажалось ли вообще. */
    const flash = (button, label) => {
        const was = button.textContent;
        button.textContent = label;
        setTimeout(() => { button.textContent = was; }, 1500);
    };

    /* ── Что сейчас ── */
    const now = h("div", "nrn-t-picker-now");
    if (cycle.view) {
        const line = [cycle.view.title, cycle.view.count].filter(Boolean).join(" · ");
        now.append(h("div", "nrn-t-picker-now-line", line));
        now.append(h("div", "nrn-t-picker-echo", cycle.view.status));
        if (cycle.view.extra) now.append(h("div", "nrn-t-picker-echo", cycle.view.extra));
        if (cycle.father) now.append(h("div", "nrn-t-picker-echo", `${t`Father`}: ${cycle.father}`));
    }
    box.append(now);

    /* Без даты сцены считать не от чего: цикл ведётся вычитанием дат, и первая
       из них приходит сверху. Блок остаётся на месте, но кнопки погашены —
       иначе нажатие молча ничего не делало бы. */
    const ready = !!cycle.today;
    if (!ready) {
        box.append(h("div", "nrn-t-picker-echo nrn-t-picker-warn",
            t`The date of the scene is not set yet, and the whole count runs from it. Set it above and this block comes alive.`));
    }

    /* ── Форточка правды ── */
    box.append(h("div", "nrn-t-picker-sub", t`The truth`));
    box.append(h("div", "nrn-t-picker-echo",
        t`What the panel knows and she does not: whether the seed took, from which day, how the roll fell. Not a word of it goes to the model.`));
    box.append(truthBox(cycle.truth));

    /* ── День цикла ── */
    const dayRow = h("div", "nrn-t-picker-row");
    dayRow.append(h("span", "nrn-t-picker-label", t`Today is day`));
    const dayEl = h("select", "nrn-t-picker-select");
    for (let d = 1; d <= cycle.length; d++) {
        const opt = h("option", null, String(d));
        opt.value = String(d);
        if (cycle.view?.state === "cycling" && cycle.view.count === `${d}/${cycle.length}`) opt.selected = true;
        dayEl.append(opt);
    }
    const setDay = h("button", "nrn-t-picker-apply", t`Set day`);
    setDay.type = "button";
    setDay.disabled = !ready;
    dayRow.append(dayEl, setDay);
    box.append(dayRow);

    const echo = h("div", "nrn-t-picker-echo");
    box.append(echo);
    const syncDay = () => {
        const phase = phaseOf(Number(dayEl.value), cycle.length);
        echo.textContent = `${phase.norse} — ${phase.hint}`;
    };
    dayEl.addEventListener("input", syncDay);
    setDay.addEventListener("click", () => {
        if (cycle.onSetDay(Number(dayEl.value))) flash(setDay, t`Day set`);
    });
    syncDay();

    /*
     * ── Беременность руками ──
     *
     * Часть срока и дата зачатия — одно и то же, сказанное с разных концов,
     * поэтому они связаны живьём: выбрала часть — подставилась дата, тронула
     * дату — пересчиталась часть. Держать их порознь значило бы завести
     * в одной форме два источника правды и объяснять потом, какой главнее.
     *
     * Число дитяти и пол — авторский акт, а не жребий: назвали — так и будет.
     * «Случайно» тоже отвечает не случайностью, а броском от даты зачатия,
     * тем же самым, что и в игре, — на одну дату всегда один ответ.
     */
    box.append(h("div", "nrn-t-picker-sub", t`Carrying`));

    const termRow = h("div", "nrn-t-picker-row");
    termRow.append(h("span", "nrn-t-picker-label", t`part`));

    const partEl = h("select", "nrn-t-picker-select");
    for (let p = 1; p <= 9; p++) {
        const opt = h("option", null, `${p}/9`);
        opt.value = String(p);
        if (cycle.part === p) opt.selected = true;
        partEl.append(opt);
    }

    const knownEl = h("select", "nrn-t-picker-select");
    for (const [value, label] of [["known", t`she knows`], ["unknown", t`she does not know`]]) {
        const opt = h("option", null, label);
        opt.value = value;
        if ((value === "known") === !!cycle.known) opt.selected = true;
        knownEl.append(opt);
    }

    /*
     * «Не знает» — только пока живот не выдал.
     *
     * С четвёртой части ношения движок объявляет знание сам (OBVIOUS_DAY):
     * тидир не пришли четырежды, поясок не сходится, отрицать нечего. Форма
     * при этом позволяла выставить «не знает» хоть на сроке 9/9 — и обещала
     * то, чего движок не исполнит: панель тут же показывала «знает», а
     * пользователь оставался с ощущением, что кнопка сломана. Гасим её там,
     * где выбор всё равно ничего не решает.
     */
    const syncKnown = (days) => {
        const obvious = days != null && days >= OBVIOUS_DAY;
        if (obvious) knownEl.value = "known";
        knownEl.disabled = obvious;
        knownEl.title = obvious
            ? t`By this part of the term there is no hiding it: the belly shows and the blood has not come four times over.`
            : "";
    };

    const fatherEl = h("input", "nrn-t-picker-text");
    fatherEl.type = "text";
    fatherEl.placeholder = t`Father, if named`;
    if (cycle.father) fatherEl.value = cycle.father;

    termRow.append(partEl, knownEl, fatherEl);
    box.append(termRow);

    /* ── Плод и пол ── */
    const broodRow = h("div", "nrn-t-picker-row");
    broodRow.append(h("span", "nrn-t-picker-label", t`bearing`));

    const birthsEl = h("select", "nrn-t-picker-select");
    for (const [value, label] of [[1, t`one child`], [2, t`twins`], [3, t`triplets`]]) {
        const opt = h("option", null, label);
        opt.value = String(value);
        if (Number(cycle.births ?? 1) === value) opt.selected = true;
        birthsEl.append(opt);
    }

    const sexEl = h("select", "nrn-t-picker-select");
    for (const [value, label] of [["any", t`sex at random`], ["m", t`son`], ["f", t`daughter`]]) {
        const opt = h("option", null, label);
        opt.value = value;
        if ((cycle.sex ?? "any") === value) opt.selected = true;
        sexEl.append(opt);
    }
    /* При двойне выбор один на всех — так и подписываем, чтобы не пришлось
       догадываться, к кому он относится. */
    const syncSexLabels = () => {
        const many = Number(birthsEl.value) > 1;
        sexEl.options[1].textContent = many ? t`all sons` : t`son`;
        sexEl.options[2].textContent = many ? t`all daughters` : t`daughter`;
        sexEl.options[0].textContent = many ? t`each at random` : t`sex at random`;
    };

    broodRow.append(birthsEl, sexEl);
    box.append(broodRow);

    /* ── Дата зачатия ── */
    const seedRow = h("div", "nrn-t-picker-row");
    seedRow.append(h("span", "nrn-t-picker-label", t`conceived`));

    const today = cycle.today ?? null;
    const fromPart = (part) => (today
        ? serialToDate(serialOf(today.year, today.month, today.day) - (part - 1) * 30)
        : null);
    const seed = dateFields(cycle.conceived ?? fromPart(Number(partEl.value)), () => {
        syncFromDate();
        syncEcho();
    });
    seedRow.append(...seed.nodes);
    box.append(seedRow);

    const pregEcho = h("div", "nrn-t-picker-echo");
    box.append(pregEcho);

    /* Часть срока → дата. */
    const syncFromPart = () => {
        const d = fromPart(Number(partEl.value));
        if (d) seed.set(d);
    };
    /* Дата → часть срока. Переносила — часть больше девяти, и список её
       не покажет; прижимаем к девятке, а точную дату всё равно отдаём как есть. */
    const syncFromDate = () => {
        if (!today) return;
        const d = seed.read();
        if (!isValidDate(d)) return;
        const days = serialOf(today.year, today.month, today.day) - serialOf(d.year, d.month, d.day);
        const part = Math.max(1, Math.min(9, Math.floor(days / 30) + 1));
        partEl.value = String(part);
    };

    /* Эхо пересказывает форму словами: что носит, какой срок, чего ждать.
       Без него связка «часть ⇄ дата» читается как два не связанных списка. */
    const syncEcho = () => {
        syncSexLabels();
        const d = seed.read();
        if (!today) {
            syncKnown(null);
            pregEcho.textContent = t`The date of the scene is not set yet, and the whole count runs from it. Set it above and this block comes alive.`;
            return;
        }
        if (!isValidDate(d)) { syncKnown(null); pregEcho.textContent = t`Not a date in this calendar`; return; }
        const days = serialOf(today.year, today.month, today.day) - serialOf(d.year, d.month, d.day);
        syncKnown(days);
        if (days < 0) { pregEcho.textContent = t`The conception has not happened yet`; return; }

        const births = Number(birthsEl.value);
        const chosen = sexEl.value === "any" ? null : sexEl.value;
        const summary = pregnancySummary({
            conceived: d, quickened: null, births,
            sex: chosen ?? undefined,
        }, today);

        const who = births === 3 ? t`triplets` : births === 2 ? t`twins` : t`one child`;
        const whose = chosen === "m" ? (births > 1 ? t`all sons` : t`son`)
            : chosen === "f" ? (births > 1 ? t`all daughters` : t`daughter`)
                : (births > 1 ? t`each at random` : t`sex at random`);

        const bits = [
            `${who}, ${whose}`,
            `${dateWords(d)} — ${t`part`} ${Math.min(summary.part, 9)}/9, ${days} ${t`day`}`,
            summary.size,
        ];
        if (summary.due) bits.push(summary.due);
        pregEcho.textContent = bits.join("  •  ");
    };

    partEl.addEventListener("input", () => { syncFromPart(); syncEcho(); });
    birthsEl.addEventListener("input", syncEcho);
    sexEl.addEventListener("input", syncEcho);

    const buttons = h("div", "nrn-t-picker-row");
    const setPreg = h("button", "nrn-t-picker-apply", cycle.pregnant ? t`Update` : t`Set carrying`);
    setPreg.type = "button";
    setPreg.disabled = !ready;
    const clearPreg = h("button", "nrn-t-picker-apply nrn-t-picker-clear", t`Clear the child`);
    clearPreg.type = "button";
    clearPreg.disabled = !ready;
    buttons.append(setPreg, clearPreg);

    /*
     * Призыв Фригг — схватки начинаются в следующем же ответе.
     *
     * Фригг звали в родах, это её час. Кнопка нужна затем, что иногда ролевая
     * подошла к родам, а движок ждёт своего дня: спорить с автором о том,
     * когда рожать, расширению не по чину.
     *
     * Отдельным видом и с оговоркой под ней: отменить призыв нечем, схватки
     * назад не отыгрываются.
     */
    const summon = h("button", "nrn-t-picker-apply nrn-t-picker-summon", t`Call upon Frigg`);
    summon.type = "button";
    summon.disabled = !cycle.canSummon;
    summon.title = cycle.canSummon
        ? t`Labour begins in the very next reply, whatever the scene is doing`
        : t`There is no child to bear yet`;
    buttons.append(summon);
    box.append(buttons);

    if (cycle.canSummon) {
        box.append(h("div", "nrn-t-picker-echo nrn-t-picker-warn",
            t`Frigg is called in labour. There is no taking it back: the pangs do not unhappen.`));
    }

    summon.addEventListener("click", () => {
        if (!cycle.canSummon) return;
        if (cycle.onSummonFrigg()) flash(summon, t`Frigg has heard`);
    });

    /*
     * Повитуха — единственное имя, которое задаёт автор, а не сцена.
     *
     * Модель раз за разом присылала одно и то же имя: оно стояло в промпте
     * образцом, и образец списывался. Но дело не только в образце. Кто примет
     * дитя — уговор ролевой, а не наблюдение: у героини может быть своя
     * служанка, которая с ней с первой главы, и угадать это неоткуда.
     *
     * Пусто — спрашиваем сцену, как раньше. Заполнено — у модели это поле
     * не спрашивается вовсе, а имя уезжает ей справкой: за кем пошлют, когда
     * придёт время.
     */
    box.append(h("div", "nrn-t-picker-sub", t`Midwife`));
    box.append(h("div", "nrn-t-picker-echo",
        t`Who will take the child when the time comes. Leave it empty and the scene decides; name someone and they will be sent for.`));

    const midwifeRow = h("div", "nrn-t-picker-row");
    const midwifeEl = h("input", "nrn-t-picker-text");
    midwifeEl.type = "text";
    midwifeEl.placeholder = t`Name, and how far off`;
    if (cycle.midwife) midwifeEl.value = cycle.midwife;

    const setMidwife = h("button", "nrn-t-picker-apply", t`Remember`);
    setMidwife.type = "button";
    midwifeRow.append(midwifeEl, setMidwife);
    box.append(midwifeRow);

    setMidwife.addEventListener("click", () => {
        if (cycle.onSetMidwife(midwifeEl.value)) {
            flash(setMidwife, midwifeEl.value.trim() ? t`Remembered` : t`Forgotten`);
        }
    });

    /*
     * Женское питьё — отвар, возвращающий кровь.
     *
     * Доступно всегда, и это не недосмотр. Кнопка, загорающаяся только у
     * беременных, сообщала бы игроку то, чего героиня знать не может: на малом
     * сроке она не знает, есть ли дитя, — она знает, что кровь не приходит.
     *
     * Траву не выбирают. Что дали на кухне, то и пьёт; список знает движок.
     */
    box.append(h("div", "nrn-t-picker-sub", t`Women's draught`));
    box.append(h("div", "nrn-t-picker-echo",
        t`A brew to bring the blood back. What herb she is given depends on the season, and she does not choose it.`));

    const drinkRow = h("div", "nrn-t-picker-row");
    const drink = h("button", "nrn-t-picker-apply nrn-t-picker-herb", t`Drink the draught`);
    drink.type = "button";
    drink.disabled = !ready;
    drink.title = t`She drinks whatever was given to her. Herbs of this age take their toll.`;
    drinkRow.append(drink);
    box.append(drinkRow);

    drink.addEventListener("click", () => {
        if (cycle.onDrinkHerb()) flash(drink, t`She drank it`);
    });

    setPreg.addEventListener("click", () => {
        const d = seed.read();
        const ok = cycle.onSetPregnancy({
            /* Дату отдаём, если она годная: тогда срок считается от неё, а не
               от круглой части. Часть остаётся запасным путём. */
            conceived: isValidDate(d) ? d : null,
            part: Number(partEl.value),
            known: knownEl.value === "known",
            father: fatherEl.value.trim() || null,
            births: Number(birthsEl.value),
            sex: sexEl.value === "any" ? null : sexEl.value,
        });
        if (ok) flash(setPreg, t`Done`);
    });
    clearPreg.addEventListener("click", () => {
        if (cycle.onSetPregnancy(null)) flash(clearPreg, t`Cleared`);
    });

    syncEcho();

    return box;
}

/**
 * Выбор даты сцены.
 *
 * Раньше дату называла модель, и это было единственное поле, которое она не
 * видела в сцене, а высчитывала. Теперь её ставят здесь: справочник уже умеет
 * выводить из даты день недели, вику, полугодие и фазу Луны, так что достаточно
 * трёх списков и кнопки — всё остальное подтянется само.
 *
 * Дальше дату везёт вперёд само расширение, перелистывая её по смене эйкты.
 * Руками сюда возвращаются только ради скачков через несколько суток.
 */
function datePicker(state, onApply) {
    const box = h("div", "nrn-t-picker");
    box.append(h("div", "nrn-t-picker-title", t`Scene date`));

    const row = h("div", "nrn-t-picker-row");
    const has = hasDate(state);

    const echo = h("div", "nrn-t-picker-echo");

    /* Живое эхо: что именно получится из выбранного. */
    const sync = () => {
        const now = fields.read();
        if (!isValidDate(now)) { echo.textContent = t`Not a date in this calendar`; return; }
        const { phase } = moonPhase(now.year, now.month, now.day);
        echo.textContent = [
            WEEKDAYS[weekdayOf(now.year, now.month, now.day)].norse,
            `vika ${vikaOf(now.year, now.month, now.day)}/${weeksInMisseri(now.year, now.month)}`,
            `í ${seasonOf(now.month).norse}`,
            `${phase.icon} ${phase.norse}`,
        ].join("  •  ");
    };

    const fields = dateFields(has ? state : { year: 1015, month: 1, day: 1 }, sync);
    row.append(...fields.nodes);

    const apply = h("button", "nrn-t-picker-apply", t`Set date`);
    apply.type = "button";
    row.append(apply);
    box.append(row);
    box.append(echo);

    apply.addEventListener("click", () => {
        const d = fields.read();
        if (!isValidDate(d)) return;
        if (onApply(d)) {
            box.classList.add("nrn-t-picker-done");
            apply.textContent = t`Date set`;
            setTimeout(() => {
                box.classList.remove("nrn-t-picker-done");
                apply.textContent = t`Set date`;
            }, 1500);
        }
    });
    sync();

    return box;
}

function eyktSection(body, state, prefs) {
    body.append(lead(t`A day is split into eight eykts of three hours each. The sun's position is the clock: at Hádegi it stands due south, at Miðnætti due north.`));

    const currentIdx = hasTime(state) ? eyktForHour(state.hour) : -1;

    const rows = EYKTIR.map((e, i) => {
        const end = (e.start + 3) % 24;
        return {
            current: i === currentIdx,
            cells: {
                num: String(i + 1),
                norse: h("span", "nrn-t-norse", e.norse),
                translit: e.translit + (e.alt ? ` (${e.alt})` : ""),
                ru: e.ru,
                hours: `${String(e.start).padStart(2, "0")}:00 – ${String(end).padStart(2, "0")}:00`,
                meaning: e.desc,
                sun: `${e.dir} · ${e.dirText.replace(/^Солнце /, "")}`,
            },
        };
    });

    const columns = ["num", "norse", "translit", "ru", "hours", "meaning", "sun"];
    body.append(chipsRow(columns, prefs), table(columns, rows, prefs));
}

/** Месяцы уже лежат в порядке древнеисландского года — он начинается с зимы. */
const YEAR_ORDER = MONTHS.map((_, i) => i + 1);

function monthSection(body, state, prefs) {
    body.append(lead(t`Every month is exactly 30 days. The year is split in two halves, not four: Vetr (winter) and Sumar (summer).`));

    const currentMonth = hasDate(state) && !isAuk(state.month) ? state.month : -1;
    const columns = ["norse", "translit", "ru", "modern", "meaning"];
    body.append(chipsRow(columns, prefs));

    for (const season of ["Vetr", "Sumar"]) {
        const label = season === "Vetr" ? `❄️ Vetr — ${t`winter`}` : `🌿 Sumar — ${t`summer`}`;
        body.append(h("div", "nrn-t-subhead", label));
        const rows = YEAR_ORDER
            .filter((num) => seasonOf(num).norse === season)
            .map((num) => {
                const m = MONTHS[num - 1];
                return {
                    current: num === currentMonth,
                    cells: {
                        norse: h("span", "nrn-t-norse", m.norse),
                        translit: m.translit,
                        ru: m.ru,
                        modern: m.modern,
                        meaning: m.gloss,
                    },
                };
            });
        body.append(table(columns, rows, prefs));
    }

    body.append(h("div", "nrn-t-note",
        t`Sumarauki (Auknætr) — four extra days in midsummer between Sólmánuðr and Heyannir, five in a leap year. Written in the block as "2 Auknætr 875".`));
}

/**
 * Праздники — по слоям достоверности.
 *
 * Разложены не по месяцам, а по тому, насколько им можно верить: сага,
 * догадка, церковь, нынешнее неоязычество. Так справочник отвечает на
 * главный вопрос — «а это правда было?» — прежде, чем на вопрос «когда».
 *
 * Даты показаны конкретным числом того года, что стоит в сцене, и рядом
 * день недели: по нему видно само правило. Первая суббота гормануда — это
 * и есть первое гормануда, и в столбце это читается без объяснений.
 */
function holidaySection(body, state, prefs) {
    body.append(lead(t`Feasts are pinned to a weekday within the month, not to a number — the first Saturday of Gormánuðr, the first Thursday of Harpa, the last Thursday of Sólmánuðr. That is how they were actually reckoned, and without it the dates would drift from year to year.`));

    /* Год берём из сцены: справочник показывает тот год, в котором играют.
       Даты в нём всё равно те же — год состоит из целых недель, — но так
       подсвеченная строка совпадает с тем, что стоит в панели. */
    const year = hasDate(state) ? state.year : 1015;

    const today = hasDate(state)
        ? holidaysOn(state.year, state.month, state.day, { tiers: ALL_TIERS, region: "all" })
        : [];
    const todayIds = new Set(today.map((x) => x.holiday.id));

    if (today.length) {
        const main = today[0];
        const count = main.days > 1 ? ` · ${t`day`} ${main.day}/${main.days}` : "";
        body.append(h("div", "nrn-t-picker-now-line",
            `${main.holiday.norse} — ${main.holiday.ru}${count}`));
    } else if (hasDate(state)) {
        const soon = nextHoliday(state.year, state.month, state.day, { tiers: ALL_TIERS, region: "all" });
        if (soon) {
            /* Склейку числа со словом делаем так же, как в эхе беременности:
               одним ключом «day», без подстановки внутрь перевода. */
            body.append(h("div", "nrn-t-picker-echo",
                `${t`Next`}: ${soon.holiday.norse} — ${soon.holiday.ru} · ${soon.days} ${t`day`}`));
        }
    }

    /* Постоянные колонки стоят первыми и рядом: имя и день. Остальное
       добирается облачками, как и в прочих таблицах справочника. */
    const columns = ["norse", "when", "ru", "weekday", "days", "region", "meaning", "source"];
    body.append(chipsRow(columns, prefs));

    const regionName = (id) => HOLIDAY_REGIONS.find((r) => r.id === id)?.ru ?? id;
    const monthName = (d) => (isAuk(d.month) ? "Auknætr" : MONTHS[d.month - 1].norse);

    /*
     * Срок праздника словами.
     *
     * Месяц называем дважды, когда конец пришёлся на другой: Alþingi
     * начинается в сольмануде и кончается уже в аукнэтр или в хейанире,
     * и «25 — 8 Sólmánuðr» было бы прямой неправдой.
     */
    const spanWords = (at, end) => {
        if (at.day === end.day && at.month === end.month) return `${at.day} ${monthName(at)}`;
        if (at.month === end.month) return `${at.day} — ${end.day} ${monthName(at)}`;
        return `${at.day} ${monthName(at)} — ${end.day} ${monthName(end)}`;
    };

    for (const tier of HOLIDAY_TIERS) {
        const inTier = HOLIDAYS.filter((x) => x.tier === tier.id);
        if (!inTier.length) continue;

        body.append(h("div", "nrn-t-subhead", tier.ru));
        body.append(h("div", "nrn-t-hint", tier.hint));

        const rows = inTier
            .map((holiday) => ({ holiday, at: holidayStart(holiday, year) }))
            /* Праздника, которого в этом году ещё нет, — Олавова дня до
               1031-го, — в таблице тоже нет: справочник показывает год
               сцены, а не вообще всё, что когда-нибудь появится. */
            .filter((x) => x.at)
            .sort((a, b) => serialOf(a.at.year, a.at.month, a.at.day)
                - serialOf(b.at.year, b.at.month, b.at.day))
            .map(({ holiday, at }) => {
                const end = holidayEnd(holiday, year);
                return {
                    current: todayIds.has(holiday.id),
                    cells: {
                        norse: h("span", "nrn-t-norse", holiday.norse),
                        ru: holiday.ru,
                        when: spanWords(at, end),
                        weekday: WEEKDAYS[weekdayOf(at.year, at.month, at.day)].norse,
                        days: holiday.days,
                        region: regionName(holiday.region),
                        meaning: holiday.gloss,
                        source: holiday.source,
                    },
                };
            });
        body.append(table(columns, rows, prefs));
    }

    body.append(h("div", "nrn-t-note",
        t`Whole layers are switched on and off in the extension settings, and so is the land the story is set in: feasts of all Scandinavia show everywhere, the Icelandic and Swedish ones only on their own soil. A feast listed here may therefore be missing from the panel — that is the setting, not an error.`));
    body.append(h("div", "nrn-t-note",
        t`Several feasts can fall on one day: the winter nights carry the great feast, the rite for the álfar and the sacrifice to the dísir at once. The panel names the chief one and keeps the rest in its hint — a saga outweighs a reconstruction, a long feast a single day.`));
}

/**
 * Устройство года: недели, вставки, с какого дня всё начинается.
 * Таблицы здесь нет — это связный рассказ, а не перечень вариантов.
 */
function vikaSection(body, state) {
    body.append(lead(t`The year is counted in whole weeks. Twelve months of thirty days give 360; four midsummer aukanætr bring that to ${COMMON_YEAR_DAYS} — exactly 52 weeks.`));

    body.append(h("div", "nrn-t-note",
        t`A year of ${COMMON_YEAR_DAYS} days falls about 1.24 days short of the sun, so once the shortfall reaches a week, a whole week — sumarauki — is inserted in midsummer. That happens every fifth or sixth year and makes the year ${COMMON_YEAR_DAYS + SUMARAUKI_DAYS} days, or 53 weeks.`));

    body.append(h("div", "nrn-t-subhead", t`Where the year begins`));
    body.append(h("div", "nrn-t-note",
        t`Because every year is a whole number of weeks, every year opens on the same weekday: Laugardagr, the first day of winter. Summer then always opens on Þórsdagr — sumardagrinn fyrsti, the first day of summer.`));

    if (hasDate(state) ) {
        const { year, month, day } = state;
        const now = h("div", "nrn-t-now");
        now.append(h("span", "nrn-t-now-label", t`In the scene now`));
        now.append(h("span", "nrn-t-now-value",
            `vika ${vikaOf(year, month, day)}/${weeksInMisseri(year, month)}  •  ` +
            `${t`day`} ${dayOfMisseri(year, month, day)}/${misseriLength(year, month)}  •  ` +
            (isSumaraukiYear(year) ? t`a sumarauki year` : t`an ordinary year`)));
        body.append(now);
    }
}

function weekdaySection(body, state, prefs) {
    body.append(lead(t`Six days carry the names of gods and heavenly bodies, and the seventh is bath day: Laugardagr is literally "washing day".`));

    const currentWd = hasDate(state) && !isAuk(state.month)
        ? weekdayOf(state.year, state.month, state.day)
        : -1;

    const rows = WEEKDAYS.map((w, i) => ({
        current: i === currentWd,
        cells: {
            norse: h("span", "nrn-t-norse", w.norse),
            en: w.en,
            ru: w.ru,
            meaning: w.desc,
            short: w.short,
        },
    }));

    const columns = ["norse", "en", "ru", "meaning", "short"];
    body.append(chipsRow(columns, prefs), table(columns, rows, prefs));
}

function moonSection(body, state, prefs) {
    body.append(lead(t`The cycle runs 29.53 days. The phase is counted from the date of the scene, not from real time.`));

    const currentPhase = hasDate(state)
        ? moonPhase(state.year, state.month, state.day).phase.norse
        : null;

    const rows = MOON_PHASES.map((p) => {
        // Иконка живёт внутри названия: отдельная безымянная колонка не имела бы
        // заголовка, а значит и переключателя.
        const name = h("span", "nrn-t-norse");
        name.append(h("span", "nrn-t-moon-icon", p.icon), document.createTextNode(p.norse));
        return {
            current: p.norse === currentPhase,
            cells: {
                norse: name,
                en: p.en,
                ru: p.ru,
                cycle: `${p.from} – ${p.to}`,
                meaning: p.desc,
            },
        };
    });

    const columns = ["norse", "en", "ru", "cycle", "meaning"];
    body.append(chipsRow(columns, prefs), table(columns, rows, prefs));
}

/*
 * Шпаргалка по блоку.
 *
 * Держать её в согласии с промптом обязательно: справочник читают, когда
 * что-то пошло не так, и разошедшийся образец уводит в сторону. Прежний
 * показывал поле date, которого модель уже не пишет, и говорил, что блок
 * прячут regex-скрипты, — тех скриптов нет с позапрошлой версии.
 */
function blockSection(body) {
    body.append(lead(t`This is what the model puts at the very end of every reply. The block is an HTML comment: the chat never shows it, and the extension cuts it out of the message once it has been read.`));

    const sample = [
        "<!-- [URD:",
        "eykt: хадеги",
        "weather: Мокрый снег, порывистый северный ветер",
        "location: Побережье фьорда, старая пристань",
        "mood: задумчивый, усталый",
        "user_attire: Шерстяное платье, меховой плащ",
        "char_attire: Волчьи шкуры, льняная рубаха",
        "thought: Она снова смотрит так, будто знает больше.",
        "char_state: продрог, ломит плечо",
        "user_state: устала, ноги сбиты",
        "advice: Отвар из дягиля и покой до утра",
        "] -->",
    ].join("\n");

    body.append(h("pre", "nrn-t-code", sample));
    body.append(h("div", "nrn-t-note",
        t`The date is not asked of the model at all — you set it above and the panel carries it forward. Everything else appears only when it is due: passed after a time skip, body when something happened to her, and the birth, standing and naming lines while they matter.`));
}

/** Откидной список с подписью — как в календарике даты, только для вида. */
function lookSelect(labelText, options, current, onPick) {
    const label = h("label", "nrn-t-look-label");
    label.append(h("span", "nrn-t-look-name", labelText));

    const select = h("select", "nrn-t-look-select");

    /* Список тем зависит от раскладки, а раскладка меняется в соседнем
       списке — поэтому строки не прибиты при сборке, а перестилаются. */
    const fill = (items, pick) => {
        select.replaceChildren();
        for (const opt of items) {
            const node = h("option", null, opt.label);
            node.value = opt.id;
            select.append(node);
        }
        select.value = pick;
    };

    fill(options, current);
    select.addEventListener("input", () => onPick(select.value));

    label.append(select);
    return { node: label, select, fill };
}

/**
 * Последний раздел — вид блока целиком в руки читателю.
 *
 * Здесь три вещи, и стоят они вместе не по случайности: раскладка, тема и
 * CSS этой темы — один и тот же вопрос «как это выглядит», заданный со
 * всё большей подробностью. Из «кубиков» таверны первые два списка убраны:
 * оформление выбирают глазами, а глазами блок виден отсюда — справочник
 * открыт поверх чата, и перекрашенный блок видно в ту же секунду.
 *
 * Поле показывает исходный CSS ВЫБРАННОЙ темы: не весь файл стилей, а тот
 * его кусок, где у темы заданы цвета. Весь файл в поле ввода читать нельзя,
 * да и незачем — раскладку правит разработчик, а цвет хочет править всякий.
 *
 * «Применить» запоминает правку в браузере и подкладывает её поверх наших
 * стилей; «Восстановить» забывает её и возвращает в поле то, что написано
 * в style.css. Правки у каждой темы свои, и смена темы в списке выше их не
 * теряет: окно перекрашивается на месте, а поле перечитывается под новую
 * тему — пересобирать справочник ради этого не нужно.
 */
function cssSection(body, state, prefs, extras) {
    const look = extras?.look;

    body.append(lead(t`Everything about how the block looks lives here: the layout, the theme and the CSS of that theme. Change a value in the field, press Apply, and the block repaints at once.`));

    if (!look) {
        body.append(h("div", "nrn-t-note", t`Editing is not available in this window.`));
        return;
    }

    /* --- раскладка и тема --- */

    const picks = h("div", "nrn-t-look-row");
    const skin = lookSelect(t`Layout`, look.skins, look.skin(), (id) => pickSkin(id));
    const theme = lookSelect(t`Theme`, look.themes(), look.theme(), (id) => pickTheme(id));
    picks.append(skin.node, theme.node);
    body.append(picks);

    /* --- CSS выбранной темы --- */

    const head = h("div", "nrn-t-css-head");
    const themeName = h("span", "nrn-t-css-theme", look.themeLabel(look.theme()));
    const badge = h("span", "nrn-t-css-badge", t`edited`);
    head.append(themeName, badge);
    body.append(head);

    const area = h("textarea", "nrn-t-css-area");
    area.value = look.read(look.theme());
    area.spellcheck = false;
    area.setAttribute("rows", "14");
    area.setAttribute("aria-label", t`Theme CSS`);
    body.append(area);

    const row = h("div", "nrn-t-css-row");
    const apply = h("button", "nrn-t-css-apply", t`Apply`);
    apply.type = "button";
    const restore = h("button", "nrn-t-css-restore", t`Restore`);
    restore.type = "button";
    restore.title = t`Forget your changes and load the original CSS of this theme`;
    const echo = h("div", "nrn-t-css-echo");
    row.append(apply, restore, echo);
    body.append(row);

    body.append(h("div", "nrn-t-note",
        t`Changes are kept in this browser only — they do not travel with the chat and are not sent anywhere. Each theme remembers its own.`));

    const syncBadge = () => badge.classList.toggle("nrn-t-hidden", !look.isEdited(look.theme()));
    syncBadge();

    /* Слово вместо тишины: нажатие должно быть слышно, а «Применить»
       ничего не двигает в самом окне — перекрашивается блок в чате. */
    const say = (words) => {
        echo.textContent = words;
        clearTimeout(echo.dataset.timer);
        echo.dataset.timer = setTimeout(() => { echo.textContent = ""; }, 2000);
    };

    /*
     * Смена темы перекрашивает окно на месте, а не пересобирает его.
     *
     * Пересборка увела бы читателя наверх: раздел этот — последний, и
     * после каждого выбора темы пришлось бы прокручивать окно заново.
     * Перекрасить достаточно корень справочника: подложку окна красит
     * setTheme, а всё остальное здесь наследует переменные от корня.
     */
    function repaint() {
        const root = body.closest(".nrn-timatal");
        if (root) root.dataset.theme = look.theme();
        themeName.textContent = look.themeLabel(look.theme());
        area.value = look.read(look.theme());
        syncBadge();
        echo.textContent = "";
    }

    function pickTheme(id) {
        look.setTheme(id);
        repaint();
    }

    /*
     * Раскладка меняет и список тем под собой.
     *
     * Перекрасы у раскладок разные — чужой цвет знает не те роли и красит
     * блок наполовину. Поэтому в списке остаются только родные, а сама
     * раскладка приходит с тем цветом, на котором её оставили: список
     * перестилается, поле CSS перечитывается под новую тему.
     */
    function pickSkin(id) {
        look.setSkin(id);
        theme.fill(look.themes(), look.theme());
        repaint();
    }

    apply.addEventListener("click", () => {
        const ok = look.apply(look.theme(), area.value);
        say(ok ? t`Applied` : t`Could not save: the browser refused to keep the changes`);
        syncBadge();
    });

    restore.addEventListener("click", () => {
        area.value = look.restore(look.theme());
        say(t`Original restored`);
        syncBadge();
    });
}

/* ── Уведомления ─────────────────────────────────────────────────────────
 *
 * Подписи видов — здесь, а не в notify.js: там модуль чистый и про i18n
 * ничего не знает, а `t` — тег шаблонной строки, динамическим ключом его не
 * позвать. Ключ вида общий, подпись у него одна на всё расширение.
 *
 * `needs` — от какой настройки расширения зависит вид. Женская линия
 * выключена — галочкам про цикл и ношение в списке делать нечего: они бы
 * ничего не включили, а спрашивать себя, почему уведомления молчат, читатель
 * стал бы всё равно.
 */
const NOTICE_LABELS = {
    day:    { label: () => t`The current day`,        hint: () => t`Eykt, date, weekday and the feast, if there is one`,   needs: null },
    eykt:   { label: () => t`Time of day`,            hint: () => t`When the eykt turns within the same day`,              needs: null },
    moon:   { label: () => t`Moon phases`,            hint: () => t`New moon, full moon and the turns between them`,       needs: null },
    season: { label: () => t`Turn of the year`,       hint: () => t`First day of winter and of summer, a new month, the inserted days`, needs: null },
    feast:  { label: () => t`Feasts`,                 hint: () => t`A feast begins, and a warning three days before it`,   needs: "holidays" },
    cycle:  { label: () => t`Cycle phases`,           hint: () => t`A new phase of the cycle begins`,                      needs: "body" },
    body:   { label: () => t`The womb and the child`, hint: () => t`The stage of the term, quickening, danger, labour, the draught, the days after`,     needs: "body" },
    marker: { label: () => t`A reply without a marker`, hint: () => t`The model forgot the infoblock and the panel stayed on the previous turn`, needs: null },
};

/** Строка с галочкой: подпись, пояснение под ней и сам переключатель. */
function switchRow(labelText, hintText, checked, onChange) {
    const row = h("label", "nrn-t-switch");

    const box = h("input", "nrn-t-switch-box");
    box.type = "checkbox";
    box.checked = !!checked;
    box.addEventListener("input", () => onChange(box.checked));

    const words = h("span", "nrn-t-switch-words");
    words.append(h("span", "nrn-t-switch-label", labelText));
    if (hintText) words.append(h("span", "nrn-t-switch-hint", hintText));

    row.append(box, words);
    return { node: row, box };
}

/**
 * Уведомления — единственный раздел, который не рассказывает, а решает.
 *
 * Своих всплывашек расширение не рисует: показывает их сама таверна, и это
 * решение, а не заготовка. У неё уже есть и место на экране, и настройки
 * длительности, и порядок — заводить рядом второй такой же механизм значило
 * бы поссорить их за один угол экрана.
 *
 * Заголовок раздела включает всё разом, список под ним говорит, о чём именно
 * говорить. Две вещи, а не одна: «выключить на вечер» и «мне не нужны
 * праздники» — разные желания, и галочки после обратного включения должны
 * остаться теми же.
 */
function notifySection(body, state, prefs, extras) {
    const notify = extras?.notify;

    body.append(lead(t`SillyTavern shows the notices; NORNIR only decides what is worth saying. Nothing is announced twice, and the first turn after a chat opens stays silent — there is nothing to compare it with yet.`));

    if (!notify) {
        body.append(h("div", "nrn-t-note", t`Notifications are not available in this window.`));
        return;
    }

    const list = h("div", "nrn-t-switch-list");

    /* Список гаснет вместе с выключателем: видно, что галочки на месте и
       никуда не делись, но сейчас они ничего не решают. */
    const syncList = () => {
        const on = notify.enabled();
        list.classList.toggle("nrn-t-off", !on);
        for (const box of list.querySelectorAll(".nrn-t-switch-box")) box.disabled = !on;
    };

    const master = switchRow(
        t`Turn notifications on`,
        t`Everything below is announced through SillyTavern's own notices`,
        notify.enabled(),
        (on) => { notify.setEnabled(on); syncList(); },
    );
    master.node.classList.add("nrn-t-switch-master");
    body.append(master.node);

    body.append(h("div", "nrn-t-subhead", t`Announce`));

    for (const kind of NOTICE_KINDS) {
        const def = NOTICE_LABELS[kind.id];
        if (!def) continue;
        if (def.needs === "body" && !notify.bodyTracking()) continue;
        if (def.needs === "holidays" && !notify.holidays()) continue;

        const row = switchRow(
            `${kind.icon}  ${def.label()}`,
            def.hint(),
            notify.isOn(kind.id),
            () => notify.toggle(kind.id),
        );
        list.append(row.node);
    }

    body.append(list);
    syncList();

    if (!notify.bodyTracking()) {
        body.append(h("div", "nrn-t-note",
            t`Notices about the cycle and the womb appear in this list once the woman's line is turned on in the extension settings.`));
    }
    if (!notify.holidays()) {
        body.append(h("div", "nrn-t-note",
            t`Notices about feasts appear in this list once feasts are turned on in the extension settings.`));
    }

    body.append(h("div", "nrn-t-note",
        t`Notices follow the scene, not the clock: they arrive when the marker moves the day, the phase or the state of the womb. A swipe or a rollback puts everything back the way it was.`));
}

/* ============================================================
 * 4. ASSEMBLY
 * ============================================================ */


/*
 * Разделы. Каждый — своя страница; на карте они разложены по двум ларям.
 *
 *  - «Книга времени» — знание о мире: эйкты, месяцы, вики, дни, Луна, пиры.
 *  - «Мастерская» — то, как расширение с этим знанием обходится: дата сцены,
 *    утроба, оповещения, блок маркера, оформление.
 *
 * `rune` и `norse` — то, чем клеймо подписано на карте: руна и древнее имя.
 * `sub` — русское словцо под ним, чтобы руны не приходилось разгадывать.
 */
const SECTIONS = [
    { id: "eykt",  group: "book", rune: "ᛖ", norse: "Eyktir",     sub: () => t`eykts`,
      title: () => t`Eykt — the eight parts of the day`, build: eyktSection },
    { id: "month", group: "book", rune: "ᛘ", norse: "Mánuðir",    sub: () => t`months`,
      title: () => t`Months — twelve of thirty days`, build: monthSection },
    { id: "vika",  group: "book", rune: "ᚡ", norse: "Vikur",      sub: () => t`weeks`,
      title: () => t`Vika — the year in whole weeks`, build: vikaSection },
    { id: "week",  group: "book", rune: "ᚹ", norse: "Dagar",      sub: () => t`weekdays`,
      title: () => t`Weekdays — named after the gods`, build: weekdaySection },
    { id: "moon",  group: "book", rune: "ᛗ", norse: "Tungl",      sub: () => t`moon phases`,
      title: () => t`Tungl — phases of the Moon`, build: moonSection },
    { id: "feast", group: "book", rune: "ᚠ", norse: "Blót",       sub: () => t`feasts`,
      title: () => t`Feasts — the year by its holidays`, build: holidaySection },

    { id: "date",  group: "tool", rune: "ᛞ", norse: "Dagsetning", sub: () => t`scene date`,
      title: () => t`The date of the scene`, build: dateSection },
    { id: "womb",  group: "tool", rune: "ᚢ", norse: "Kviðr",      sub: () => t`womb`,
      title: () => t`Womb`, build: wombSection },
    { id: "notify", group: "tool", rune: "ᚴ", norse: "Kall",      sub: () => t`notices`,
      title: () => t`Notifications`, build: notifySection },
    { id: "block", group: "tool", rune: "ᚱ", norse: "Merki",      sub: () => t`marker block`,
      title: () => t`The calendar block`, build: blockSection },
    { id: "css",   group: "tool", rune: "ᛚ", norse: "Ásýnd",      sub: () => t`look`,
      title: () => t`Look — layout, theme and CSS`, build: cssSection },
];

const GROUP_TITLES = {
    book: () => t`The book of time`,
    tool: () => t`The workshop`,
};

/** Все ключи разделов и колонок — index.js использует их для сброса вида. */
export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const COLUMN_KEYS = Object.keys(COLUMN_LABELS);

/* Дата сцены и утроба раньше стояли отдельными коробками над разделами;
   теперь у каждой своя страница, и обёртки ниже — весь их код. */
function dateSection(body, state, prefs, extras) {
    body.append(lead(t`This is the one thing the panel cannot read out of the reply: the day everything else is counted from. Set it once, and the day carries itself onward.`));
    if (extras?.onSetDate) body.append(datePicker(state, extras.onSetDate));
}

function wombSection(body, state, prefs, extras) {
    if (extras?.cycle) body.append(cyclePicker(extras.cycle));
}

/*
 * Строка «сейчас в сцене» одной строкой — она стоит и на карте, и в шапке
 * каждой страницы, поэтому собрана отдельно от коробки `nowBanner`.
 */
function nowText(state) {
    const banner = nowBanner(state);
    return banner ? banner.querySelector(".nrn-t-now-value").textContent : "";
}

/**
 * Какая страница открыта сейчас. Живёт вне сборки нарочно: окно
 * пересобирается после каждой правки даты или счёта, и без этого
 * пользователя выбрасывало бы обратно на карту посреди работы.
 */
let openId = null;

/** Клеймо раздела на карте. */
function tile(def) {
    const btn = h("button", "nrn-t-tile");
    btn.type = "button";
    btn.dataset.open = def.id;

    const top = h("span", "nrn-t-tile-top");
    top.append(
        h("span", "nrn-t-tile-rune", def.rune),
        h("span", "nrn-t-tile-name", def.norse),
    );
    btn.append(top, h("span", "nrn-t-tile-sub", def.sub()));
    return btn;
}

/** Подпись над решёткой клейм: слово и линейка до края. */
function groupHead(text) {
    const head = h("div", "nrn-t-group");
    head.append(h("span", "nrn-t-group-name", text), h("span", "nrn-t-group-rule"));
    return head;
}

/** Карта: заголовок, «сейчас», два ларя клейм. */
function buildHub(state, sections, prefs) {
    const hub = h("div", "nrn-t-hub");

    const header = h("div", "nrn-t-header");
    header.append(h("div", "nrn-t-runes", "ᛏᛁᛘᚨᛏᚨᛚ"));
    header.append(h("div", "nrn-t-title", "Tímatal"));
    const now = nowText(state);
    if (now) header.append(h("div", "nrn-t-now-line", now));
    else header.append(h("div", "nrn-t-subtitle", t`Norse reckoning of time`));
    hub.append(header);

    for (const group of ["book", "tool"]) {
        const defs = sections.filter((s) => s.group === group);
        if (!defs.length) continue;
        hub.append(groupHead(GROUP_TITLES[group]()));
        const grid = h("div", "nrn-t-tiles");
        for (const def of defs) grid.append(tile(def));
        hub.append(grid);
    }

    /* Сброс вида — единственная страховка на случай, когда из таблиц
       выключено всё подряд. Показывается, только если вид не исходный. */
    const reset = h("button", "nrn-t-reset");
    reset.type = "button";
    reset.title = t`Restore all columns`;
    reset.append(h("span", "nrn-t-reset-icon", "↺"), h("span", null, t`Reset view`));
    if (prefs.isDefaultView()) reset.classList.add("nrn-t-hidden");
    hub.append(reset);

    return hub;
}

/** Страница раздела: шапка с возвратом и содержимое во всю ширину. */
function buildPage(def, state, prefs, extras) {
    const page = h("div", "nrn-t-page");

    const bar = h("div", "nrn-t-topbar");
    const back = h("button", "nrn-t-back", `← ${t`Map`}`);
    back.type = "button";
    bar.append(back, h("span", "nrn-t-dot", "·"),
        h("span", "nrn-t-crumb", GROUP_TITLES[def.group]()));
    const now = nowText(state);
    if (now) bar.append(h("span", "nrn-t-topbar-now", now));
    page.append(bar);

    const scroll = h("div", "nrn-t-scroll");
    scroll.append(h("div", "nrn-t-page-title", def.title()));

    const body = h("div", "nrn-t-section-body");
    def.build(body, state, prefs, extras);
    scroll.append(body);

    page.append(scroll);
    return page;
}

/**
 * Собирает содержимое окна Tímatal.
 *
 * Окно живёт двумя видами: карта одиннадцати клейм и страница одного
 * раздела во всю ширину. Из-за этого содержимое перерисовывается изнутри —
 * `show()` ниже, — а не пересобирается снаружи на каждый щелчок.
 *
 * @param {object} state Состояние виджета (для подсветки текущей сцены)
 * @param {string} theme Тема оформления — та же, что у виджета
 * @param {object} prefs Настройки вида:
 *   isColumnVisible(key), toggleColumn(key), resetView(), isDefaultView()
 * @param {function|null} onSetDate Установка даты сцены из календарика
 * @param {object|null} cycle Ручная правка счёта тела
 * @param {object|null} look Вид блока: раскладка, тема и CSS темы —
 *   skins, themes() (родные перекрасы нынешней раскладки),
 *   skin(), theme(), setSkin(id), setTheme(id),
 *   themeLabel(id), read(theme), original(theme), isEdited(theme),
 *   apply(theme, text), restore(theme)
 * @param {object|null} notify Уведомления: enabled(), setEnabled(on),
 *   isOn(id), toggle(id), bodyTracking(), holidays()
 * @returns {HTMLElement} Корневой элемент для Popup
 */
export function buildReference(state, theme = "default", prefs, onSetDate = null, cycle = null, look = null, notify = null) {
    const root = h("div", "nrn-timatal nrn-themed");
    root.setAttribute("data-theme", theme || "default");

    const extras = { look, notify, onSetDate, cycle };

    /* Дата сцены и утроба показываются, только если их есть чем наполнить:
       клеймо, ведущее на пустую страницу, — обман. */
    const sections = SECTIONS.filter((def) => {
        if (def.id === "date") return !!onSetDate;
        if (def.id === "womb") return !!cycle;
        return true;
    });

    if (openId && !sections.some((s) => s.id === openId)) openId = null;

    function show() {
        const def = sections.find((s) => s.id === openId);
        root.replaceChildren(def
            ? buildPage(def, state, prefs, extras)
            : buildHub(state, sections, prefs));
        root.classList.toggle("nrn-t-on-page", !!def);
    }

    root.addEventListener("click", (e) => {
        const open = e.target.closest(".nrn-t-tile");
        if (open) {
            openId = open.dataset.open;
            show();
            return;
        }

        if (e.target.closest(".nrn-t-back")) {
            openId = null;
            show();
            return;
        }

        const chip = e.target.closest(".nrn-t-chip");
        if (chip) {
            applyColumn(root, chip.dataset.col, prefs.toggleColumn(chip.dataset.col));
            return;
        }

        if (e.target.closest(".nrn-t-reset")) {
            prefs.resetView();
            for (const key of COLUMN_KEYS) applyColumn(root, key, prefs.isColumnVisible(key));
            root.querySelector(".nrn-t-reset")?.classList.add("nrn-t-hidden");
        }
    });

    show();
    return root;
}
