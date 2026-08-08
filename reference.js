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

import {
    EYKTIR,
    MONTHS_LORE,
    MOON_PHASES,
    WEEKDAYS_LORE,
    aukDays,
    eyktForHour,
    hasDate,
    hasTime,
    isAuk,
    moonPhase,
    seasonOf,
    weekdayOf,
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
            // В Auknætr дни недели не считаются — только сама дата и Луна.
            parts.push(`Sumarauki ${day}/${aukDays(year)}, ${year}`);
        } else {
            parts.push(`${day} ${MONTHS_LORE[month - 1].ru} ${year}`);
            parts.push(WEEKDAYS_LORE[weekdayOf(year, month, day)].ru);
        }
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

/**
 * Порядок месяцев в лорном году: он начинается с зимы, с Gormánaður (11),
 * а не с января. Принадлежность к сезону берётся из seasonOf(), здесь — только
 * порядок показа.
 */
const YEAR_ORDER = [11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

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

function blockSection(body) {
    body.append(lead(t`This is what the model returns at the top of every reply. The widget reads it; the raw block is hidden from the chat by the regex scripts.`));

    const sample = [
        "<!-- [YORNI:",
        "eykt: хадеги",
        "date: 13 гормануд 1015",
        "weather: Мокрый снег, порывистый северный ветер",
        "location: Побережье фьорда, старая пристань",
        "mood: задумчивый, усталый",
        "user_attire: Шерстяное платье, меховой плащ",
        "char_attire: Волчьи шкуры, льняная рубаха",
        "thought: Она снова смотрит так, будто знает больше.",
        "] -->",
    ].join("\n");

    body.append(h("pre", "nct-code", sample));
    body.append(h("div", "nct-note",
        t`The date field is read loosely: "12 Góa 875", "875-03-12", "12.03.875" and "14 Gormánaður — Гормануд — Ноябрь 875" all work. If the date cannot be read, the remaining fields still reach the widget.`));
}

/* ============================================================
 * 4. ASSEMBLY
 * ============================================================ */

const SECTIONS = [
    { id: "eykt",  icon: "🧭", title: () => t`Eykt — the eight parts of the day`, build: eyktSection },
    { id: "month", icon: "🌿", title: () => t`Months — twelve of thirty days`,    build: monthSection },
    { id: "week",  icon: "🪓", title: () => t`Weekdays — named after the gods`,   build: weekdaySection },
    { id: "moon",  icon: "🌕", title: () => t`Tungl — phases of the Moon`,        build: moonSection },
    { id: "block", icon: "ᚱ",  title: () => t`The <yorni> block`,                 build: blockSection },
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
export function buildReference(state, theme = "default", prefs) {
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
