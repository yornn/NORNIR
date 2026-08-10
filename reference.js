/*
 * Norse Calendar — Tímatal, мини-справочник по счёту времени.
 *
 * Tímatal (др.-исл. «счёт времени») — окно из меню «волшебной палочки»
 * рядом с полем ввода. Собирает в одном месте эйкты, месяцы, дни недели,
 * фазы Луны и шпаргалку по блоку <yorni>, чтобы не сверяться с заметками
 * посреди ролевой.
 *
 * Справочник настраивается под себя, и настройки запоминаются:
 *  - разделы сворачиваются по клику на заголовок (по умолчанию открыты
 *    только Эйкты — с телефона не приходится листать всё подряд);
 *  - колонки выбираются облачками над таблицей: затемнённое облачко —
 *    колонки нет, зажжённое — есть. Выбор общий для всех таблиц: включили
 *    «Транслит» — он появился и в эйктах, и в месяцах.
 *  - колонка с древнескандинавским написанием (а в эйктах ещё и номер)
 *    постоянная: это опора таблицы, её не выключить.
 *
 * Если в чате уже есть инфоблок, текущая эйкта, месяц, день недели и фаза
 * Луны подсвечиваются — видно не только «какие бывают», но и «где мы сейчас».
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Helpers ............ Мелкие конструкторы DOM
 * 2. Columns ............ Реестр колонок, облачки выбора и таблица
 * 3. Sections ........... Эйкты, месяцы, дни недели, Луна, формат блока
 * 4. Assembly ........... Сборка окна с аккордеоном
 */

import { t } from "../../../i18n.js";

import { phaseOf, pregnancySummary } from "./body.js";

import {
    AUKNAETR_DAYS,
    AUK_AFTER_MONTH,
    COMMON_YEAR_DAYS,
    EYKTIR,
    MONTHS_LORE,
    MOON_PHASES,
    SUMARAUKI_DAYS,
    WEEKDAYS_LORE,
    aukDays,
    dayOfYear,
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
    weeksInYear,
    yearLength,
} from "./parser.js";

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
};

/**
 * Постоянные колонки — опора таблицы, их не выключить и облачков у них нет.
 * Древнескандинавское написание есть везде, номер — только в эйктах; в CSS
 * они прижаты друг к другу, чтобы читались как одно целое.
 */
export const PERMANENT_COLUMNS = ["num", "norse"];

export const isPermanent = (key) => PERMANENT_COLUMNS.includes(key);

/** Ряд облачков: какие колонки показывать в таблицах этого раздела. */
function chipsRow(columns, prefs) {
    const row = h("div", "nct-chips-row");
    for (const key of columns) {
        if (isPermanent(key)) continue;
        const on = prefs.isColumnVisible(key);
        const chip = h("button", on ? "nct-chip nct-chip-on" : "nct-chip");
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
    const scroller = h("div", "nct-table-wrap");
    const tbl = h("table", "nct-table");

    const thead = h("thead");
    const headRow = h("tr");
    for (const key of columns) {
        const th = h("th", prefs.isColumnVisible(key) ? null : "nct-col-off");
        th.dataset.col = key;
        th.textContent = COLUMN_LABELS[key]();
        headRow.append(th);
    }
    thead.append(headRow);
    tbl.append(thead);

    const tbody = h("tbody");
    for (const row of rows) {
        const tr = h("tr", row.current ? "nct-current" : null);
        if (row.current) tr.title = t`Current state of the scene`;
        for (const key of columns) {
            const td = h("td", prefs.isColumnVisible(key) ? null : "nct-col-off");
            td.dataset.col = key;
            const cell = row.cells[key];
            if (cell instanceof Node) td.append(cell);
            else if (cell !== undefined && cell !== null) td.textContent = String(cell);
            tr.append(td);
        }
        // Маркер вешается на первую ячейку — она всегда постоянная, так что
        // подсветка текущей строки не пропадёт вместе с выключенной колонкой.
        if (row.current) tr.firstElementChild?.prepend(h("span", "nct-marker", "▸"));
        tbody.append(tr);
    }
    tbl.append(tbody);

    scroller.append(tbl);
    return scroller;
}

/** Применяет состояние колонки ко всем таблицам и облачкам окна. */
function applyColumn(root, key, visible) {
    for (const cell of root.querySelectorAll(`th[data-col="${key}"], td[data-col="${key}"]`)) {
        cell.classList.toggle("nct-col-off", !visible);
    }
    for (const chip of root.querySelectorAll(`.nct-chip[data-col="${key}"]`)) {
        chip.classList.toggle("nct-chip-on", visible);
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
            parts.push(`${day} ${MONTHS_LORE[month - 1].ru} ${year}`);
        }
        parts.push(WEEKDAYS_LORE[weekdayOf(year, month, day)].ru);
        parts.push(`vika ${vikaOf(year, month, day)}/${weeksInYear(year)}`);
        const { phase } = moonPhase(year, month, day);
        parts.push(`${phase.icon} ${phase.norse}`);
    }

    const banner = h("div", "nct-now");
    banner.append(h("span", "nct-now-label", t`In the scene now`));
    banner.append(h("span", "nct-now-value", parts.join("  •  ")));
    return banner;
}

function lead(text) {
    return h("div", "nct-lead", text);
}

/**
 * Тройка «день — месяц — год» лорного календаря.
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
        const el = h("select", `nct-picker-select ${cls}`);
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
    const months = MONTHS_LORE.map((m, i) => [i + 1, m.ru]);
    months.splice(AUK_AFTER_MONTH, 0, ["AUK", "Аукнэтр"]);

    const start = initial?.year != null ? initial : { year: 1015, month: 1, day: 1 };
    const dayEl = select("nct-picker-day", days, start.day);
    const monthEl = select("nct-picker-month", months, start.month);
    const yearEl = h("input", "nct-picker-year");
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
    const name = d.month === "AUK" ? "аукнэтр" : MONTHS_LORE[d.month - 1].ru.toLowerCase();
    return `${d.day} ${name} ${d.year}`;
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
 * @param {{summary: object|null, length: number, onSet: (day:number)=>boolean}} cycle
 */
function cyclePicker(cycle) {
    const box = h("div", "nct-picker");
    box.append(h("div", "nct-picker-title", t`Womb`));

    /* Кнопка мигает подтверждением и возвращает прежнюю надпись: окно
       не перерисовывается, и без отклика непонятно, нажалось ли вообще. */
    const flash = (button, label) => {
        const was = button.textContent;
        button.textContent = label;
        setTimeout(() => { button.textContent = was; }, 1500);
    };

    /* ── Что сейчас ── */
    const now = h("div", "nct-picker-now");
    if (cycle.view) {
        const line = [cycle.view.title, cycle.view.count].filter(Boolean).join(" · ");
        now.append(h("div", "nct-picker-now-line", line));
        now.append(h("div", "nct-picker-echo", cycle.view.status));
        if (cycle.view.extra) now.append(h("div", "nct-picker-echo", cycle.view.extra));
        if (cycle.father) now.append(h("div", "nct-picker-echo", `${t`Father`}: ${cycle.father}`));
    }
    box.append(now);

    /* ── День цикла ── */
    const dayRow = h("div", "nct-picker-row");
    dayRow.append(h("span", "nct-picker-label", t`Today is day`));
    const dayEl = h("select", "nct-picker-select");
    for (let d = 1; d <= cycle.length; d++) {
        const opt = h("option", null, String(d));
        opt.value = String(d);
        if (cycle.view?.state === "cycling" && cycle.view.count === `${d}/${cycle.length}`) opt.selected = true;
        dayEl.append(opt);
    }
    const setDay = h("button", "nct-picker-apply", t`Set day`);
    setDay.type = "button";
    dayRow.append(dayEl, setDay);
    box.append(dayRow);

    const echo = h("div", "nct-picker-echo");
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
    box.append(h("div", "nct-picker-sub", t`Carrying`));

    const termRow = h("div", "nct-picker-row");
    termRow.append(h("span", "nct-picker-label", t`part`));

    const partEl = h("select", "nct-picker-select");
    for (let p = 1; p <= 9; p++) {
        const opt = h("option", null, `${p}/9`);
        opt.value = String(p);
        if (cycle.part === p) opt.selected = true;
        partEl.append(opt);
    }

    const knownEl = h("select", "nct-picker-select");
    for (const [value, label] of [["known", t`she knows`], ["unknown", t`she does not know`]]) {
        const opt = h("option", null, label);
        opt.value = value;
        if ((value === "known") === !!cycle.known) opt.selected = true;
        knownEl.append(opt);
    }

    const fatherEl = h("input", "nct-picker-text");
    fatherEl.type = "text";
    fatherEl.placeholder = t`Father, if named`;
    if (cycle.father) fatherEl.value = cycle.father;

    termRow.append(partEl, knownEl, fatherEl);
    box.append(termRow);

    /* ── Плод и пол ── */
    const broodRow = h("div", "nct-picker-row");
    broodRow.append(h("span", "nct-picker-label", t`bearing`));

    const birthsEl = h("select", "nct-picker-select");
    for (const [value, label] of [[1, t`one child`], [2, t`twins`], [3, t`triplets`]]) {
        const opt = h("option", null, label);
        opt.value = String(value);
        if (Number(cycle.births ?? 1) === value) opt.selected = true;
        birthsEl.append(opt);
    }

    const sexEl = h("select", "nct-picker-select");
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
    const seedRow = h("div", "nct-picker-row");
    seedRow.append(h("span", "nct-picker-label", t`conceived`));

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

    const pregEcho = h("div", "nct-picker-echo");
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
        if (!isValidDate(d) || !today) { pregEcho.textContent = t`Not a date in this calendar`; return; }
        const days = serialOf(today.year, today.month, today.day) - serialOf(d.year, d.month, d.day);
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

    const buttons = h("div", "nct-picker-row");
    const setPreg = h("button", "nct-picker-apply", cycle.pregnant ? t`Update` : t`Set carrying`);
    setPreg.type = "button";
    const clearPreg = h("button", "nct-picker-apply nct-picker-clear", t`Clear the child`);
    clearPreg.type = "button";
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
    const summon = h("button", "nct-picker-apply nct-picker-summon", t`Call upon Frigg`);
    summon.type = "button";
    summon.disabled = !cycle.canSummon;
    summon.title = cycle.canSummon
        ? t`Labour begins in the very next reply, whatever the scene is doing`
        : t`There is no child to bear yet`;
    buttons.append(summon);
    box.append(buttons);

    if (cycle.canSummon) {
        box.append(h("div", "nct-picker-echo nct-picker-warn",
            t`Frigg is called in labour. There is no taking it back: the pangs do not unhappen.`));
    }

    summon.addEventListener("click", () => {
        if (!cycle.canSummon) return;
        if (cycle.onSummonFrigg()) flash(summon, t`Frigg has heard`);
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
    box.append(h("div", "nct-picker-sub", t`Women's draught`));
    box.append(h("div", "nct-picker-echo",
        t`A brew to bring the blood back. What herb she is given depends on the season, and she does not choose it.`));

    const drinkRow = h("div", "nct-picker-row");
    const drink = h("button", "nct-picker-apply nct-picker-herb", t`Drink the draught`);
    drink.type = "button";
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
    const box = h("div", "nct-picker");
    box.append(h("div", "nct-picker-title", t`Scene date`));

    const row = h("div", "nct-picker-row");
    const has = hasDate(state);

    const echo = h("div", "nct-picker-echo");

    /* Живое эхо: что именно получится из выбранного. */
    const sync = () => {
        const now = fields.read();
        if (!isValidDate(now)) { echo.textContent = t`Not a date in this calendar`; return; }
        const { phase } = moonPhase(now.year, now.month, now.day);
        echo.textContent = [
            WEEKDAYS_LORE[weekdayOf(now.year, now.month, now.day)].norse,
            `vika ${vikaOf(now.year, now.month, now.day)}/${weeksInYear(now.year)}`,
            `í ${seasonOf(now.month).norse}`,
            `${phase.icon} ${phase.norse}`,
        ].join("  •  ");
    };

    const fields = dateFields(has ? state : { year: 1015, month: 1, day: 1 }, sync);
    row.append(...fields.nodes);

    const apply = h("button", "nct-picker-apply", t`Set date`);
    apply.type = "button";
    row.append(apply);
    box.append(row);
    box.append(echo);

    apply.addEventListener("click", () => {
        const d = fields.read();
        if (!isValidDate(d)) return;
        if (onApply(d)) {
            box.classList.add("nct-picker-done");
            apply.textContent = t`Date set`;
            setTimeout(() => {
                box.classList.remove("nct-picker-done");
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
                norse: h("span", "nct-norse", e.norse),
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

/** Месяцы уже лежат в порядке лорного года — он начинается с зимы. */
const YEAR_ORDER = MONTHS_LORE.map((_, i) => i + 1);

function monthSection(body, state, prefs) {
    body.append(lead(t`Every month is exactly 30 days. The year is split in two halves, not four: Vetr (winter) and Sumar (summer).`));

    const currentMonth = hasDate(state) && !isAuk(state.month) ? state.month : -1;
    const columns = ["norse", "translit", "ru", "modern", "meaning"];
    body.append(chipsRow(columns, prefs));

    for (const season of ["Vetr", "Sumar"]) {
        const label = season === "Vetr" ? `❄️ Vetr — ${t`winter`}` : `🌿 Sumar — ${t`summer`}`;
        body.append(h("div", "nct-subhead", label));
        const rows = YEAR_ORDER
            .filter((num) => seasonOf(num).norse === season)
            .map((num) => {
                const m = MONTHS_LORE[num - 1];
                return {
                    current: num === currentMonth,
                    cells: {
                        norse: h("span", "nct-norse", m.norse),
                        translit: m.translit,
                        ru: m.ru,
                        modern: m.modern,
                        meaning: m.gloss,
                    },
                };
            });
        body.append(table(columns, rows, prefs));
    }

    body.append(h("div", "nct-note",
        t`Sumarauki (Auknætr) — four extra days in midsummer between Sólmánuður and Heyannir, five in a leap year. Written in the block as "2 Auknætr 875".`));
}

/**
 * Устройство года: недели, вставки, с какого дня всё начинается.
 * Таблицы здесь нет — это связный рассказ, а не перечень вариантов.
 */
function vikaSection(body, state) {
    body.append(lead(t`The year is counted in whole weeks. Twelve months of thirty days give 360; four midsummer aukanætr bring that to ${COMMON_YEAR_DAYS} — exactly 52 weeks.`));

    body.append(h("div", "nct-note",
        t`A year of ${COMMON_YEAR_DAYS} days falls about 1.24 days short of the sun, so once the shortfall reaches a week, a whole week — sumarauki — is inserted in midsummer. That happens every fifth or sixth year and makes the year ${COMMON_YEAR_DAYS + SUMARAUKI_DAYS} days, or 53 weeks.`));

    body.append(h("div", "nct-subhead", t`Where the year begins`));
    body.append(h("div", "nct-note",
        t`Because every year is a whole number of weeks, every year opens on the same weekday: Laugardagr, the first day of winter. Summer then always opens on Þórsdagr — sumardagurinn fyrsti, the first day of summer.`));

    if (hasDate(state) ) {
        const { year, month, day } = state;
        const now = h("div", "nct-now");
        now.append(h("span", "nct-now-label", t`In the scene now`));
        now.append(h("span", "nct-now-value",
            `vika ${vikaOf(year, month, day)}/${weeksInYear(year)}  •  ` +
            `${t`day`} ${dayOfYear(year, month, day)}/${yearLength(year)}  •  ` +
            (isSumaraukiYear(year) ? t`a sumarauki year` : t`an ordinary year`)));
        body.append(now);
    }
}

function weekdaySection(body, state, prefs) {
    body.append(lead(t`Six days carry the names of gods and heavenly bodies, and the seventh is bath day: Laugardagr is literally "washing day".`));

    const currentWd = hasDate(state) && !isAuk(state.month)
        ? weekdayOf(state.year, state.month, state.day)
        : -1;

    const rows = WEEKDAYS_LORE.map((w, i) => ({
        current: i === currentWd,
        cells: {
            norse: h("span", "nct-norse", w.norse),
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
        const name = h("span", "nct-norse");
        name.append(h("span", "nct-moon-icon", p.icon), document.createTextNode(p.norse));
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
        "<!-- [YORNI:",
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

    body.append(h("pre", "nct-code", sample));
    body.append(h("div", "nct-note",
        t`The date is not asked of the model at all — you set it above and the panel carries it forward. Everything else appears only when it is due: passed after a time skip, body when something happened to her, and the birth, standing and naming lines while they matter.`));
}

/* ============================================================
 * 4. ASSEMBLY
 * ============================================================ */

const SECTIONS = [
    { id: "eykt",  icon: "🧭", title: () => t`Eykt — the eight parts of the day`, build: eyktSection },
    { id: "month", icon: "🌿", title: () => t`Months — twelve of thirty days`,    build: monthSection },
    { id: "vika",  icon: "🗓", title: () => t`Vika — the year in whole weeks`,     build: vikaSection },
    { id: "week",  icon: "🪓", title: () => t`Weekdays — named after the gods`,   build: weekdaySection },
    { id: "moon",  icon: "🌕", title: () => t`Tungl — phases of the Moon`,        build: moonSection },
    { id: "block", icon: "ᚱ",  title: () => t`The calendar block`,                build: blockSection },
];

/** Все ключи разделов и колонок — index.js использует их для сброса вида. */
export const SECTION_IDS = SECTIONS.map((s) => s.id);
export const COLUMN_KEYS = Object.keys(COLUMN_LABELS);

function buildSection(def, state, prefs) {
    const section = h("div", "nct-section");
    section.dataset.section = def.id;

    const closed = prefs.isSectionClosed(def.id);
    section.classList.toggle("nct-closed", closed);

    const head = h("button", "nct-section-toggle");
    head.type = "button";
    head.dataset.section = def.id;
    head.setAttribute("aria-expanded", String(!closed));
    head.append(
        h("span", "nct-chevron", "▾"),
        h("span", "nct-section-icon", def.icon),
        h("span", "nct-section-title", def.title()),
    );

    const body = h("div", "nct-section-body");
    def.build(body, state, prefs);

    section.append(head, body);
    return section;
}

/**
 * Собирает содержимое окна Tímatal.
 *
 * @param {object} state Состояние виджета (для подсветки текущей сцены)
 * @param {string} theme Тема оформления — та же, что у виджета
 * @param {object} prefs Настройки вида:
 *   isSectionClosed(id), toggleSection(id), isColumnVisible(key),
 *   toggleColumn(key), resetView(), isDefaultView()
 * @returns {HTMLElement} Корневой элемент для Popup
 */
export function buildReference(state, theme = "default", prefs, onSetDate = null, cycle = null) {
    const root = h("div", "norse-timatal nc-themed");
    root.setAttribute("data-theme", theme || "default");

    const header = h("div", "nct-header");
    header.append(h("div", "nct-runes", "ᛏᛁᛘᚨᛏᚨᛚ"));
    header.append(h("div", "nct-title", "Tímatal"));
    header.append(h("div", "nct-subtitle", t`Norse reckoning of time`));

    // Кнопка сброса — единственная страховка на случай, когда спрятано всё
    // подряд. Показывается только если вид отличается от исходного.
    const reset = h("button", "nct-reset");
    reset.type = "button";
    reset.title = t`Restore all sections and columns`;
    reset.append(h("span", "nct-reset-icon", "↺"), h("span", null, t`Reset view`));
    header.append(reset);
    root.append(header);

    const banner = nowBanner(state);
    if (banner) root.append(banner);

    if (onSetDate) root.append(datePicker(state, onSetDate));
    if (cycle) root.append(cyclePicker(cycle));

    const hint = h("div", "nct-hint", t`Tap a heading to fold a section. Pick the chips to add columns.`);
    root.append(hint);

    for (const def of SECTIONS) root.append(buildSection(def, state, prefs));

    function syncReset() {
        reset.classList.toggle("nct-hidden", prefs.isDefaultView());
    }
    syncReset();

    root.addEventListener("click", (e) => {
        const toggle = e.target.closest(".nct-section-toggle");
        if (toggle) {
            const id = toggle.dataset.section;
            const closed = prefs.toggleSection(id);
            const section = root.querySelector(`.nct-section[data-section="${id}"]`);
            section.classList.toggle("nct-closed", closed);
            toggle.setAttribute("aria-expanded", String(!closed));
            syncReset();
            return;
        }

        const chip = e.target.closest(".nct-chip");
        if (chip) {
            const key = chip.dataset.col;
            applyColumn(root, key, prefs.toggleColumn(key));
            syncReset();
            return;
        }

        if (e.target.closest(".nct-reset")) {
            prefs.resetView();
            for (const key of COLUMN_KEYS) applyColumn(root, key, prefs.isColumnVisible(key));
            for (const def of SECTIONS) {
                const closed = prefs.isSectionClosed(def.id);
                root.querySelector(`.nct-section[data-section="${def.id}"]`)
                    .classList.toggle("nct-closed", closed);
                root.querySelector(`.nct-section-toggle[data-section="${def.id}"]`)
                    .setAttribute("aria-expanded", String(!closed));
            }
            syncReset();
        }
    });

    return root;
}
