/*
 * Norse Calendar — расширение-инфоблок для SillyTavern.
 *
 * Модель работы: расширение инжектит в промпт инструкцию, модель заканчивает
 * ответ невидимым маркером <!-- [YORNI: … ] --> с метаданными сцены, расширение
 * разбирает его, кладёт снимок в msg.extra и вырезает маркер из текста.
 * Виджет YORNIE рендерит из снимка эйкту, положение солнца, дату, день недели
 * и фазу Луны.
 *
 * Реальное время не используется — только данные из чата. Своего «текущего
 * состояния» у расширения нет: и виджет, и промпт каждый раз выводятся из
 * последнего актуального сообщения, поэтому свайпы, удаление и откат работают
 * сами собой (подробности — в chat-state.js).
 *
 * Лор и разбор маркера живут в parser.js (его же импортирует test-parse.mjs).
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Imports & Constants  Импорты, имя расширения, настройки
 * 2. Prompt ............. Инструкция для модели и инжект
 * 3. State & Lookup ..... Кэш отрисовки и чтение состояния из чата
 * 4. Render ............. Отрисовка виджета
 * 5. Widget Mounting .... Встраивание в DOM сообщения
 * 6. Widget Building .... Построение DOM-структуры виджета
 * 7. Tímatal ............ Мини-справочник в меню «волшебной палочки»
 * 8. Slash Commands ..... STscript-команды /norse-*
 * 9. Settings ........... Панель настроек SillyTavern
 * 10. Init .............. Точка входа, подписки на события
 */

/* ============================================================
 * 1. IMPORTS & CONSTANTS
 * ============================================================ */

import { extension_settings, getContext, renderExtensionTemplateAsync } from "../../../extensions.js";
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
} from "../../../../script.js";
import { t } from "../../../i18n.js";
import { SlashCommandParser } from "../../../slash-commands/SlashCommandParser.js";
import { SlashCommand } from "../../../slash-commands/SlashCommand.js";
import { Popup, POPUP_TYPE } from "../../../popup.js";
import { buildReference, SECTION_IDS, COLUMN_KEYS, isPermanent } from "./reference.js";

import {
    MONTHS_RU_NOM,
    MONTHS_NORSE_RU,
    WEEKDAYS_SHORT_NORSE,
    WEEKDAYS_FULL_RU,
    WEEKDAY_DESC_RU,
    EYKTIR,
    addDays,
    aukDays,
    eyktForHour,
    hasDate,
    hasDetails,
    hasTime,
    isAuk,
    moonPhase,
    seasonOf,
    stripYorniMarkers,
    weekdayOf,
} from "./parser.js";

import {
    chatHasRawMarkers,
    findLatestState,
    syncWholeChat,
} from "./chat-state.js";

const extensionName = "Norse-Calendar";
const extensionFolderName = `third-party/${extensionName}`;

/* По умолчанию в Tímatal открыты только Эйкты: с телефона незачем листать
   весь справочник, а нужный раздел разворачивается одним касанием. */
const DEFAULT_CLOSED_SECTIONS = ["month", "week", "moon", "block"];

/* Постоянные колонки (номер и др.-сканд. написание) здесь не перечисляются —
   они всегда на месте. Русский включён, чтобы при первом открытии сразу было
   видно, что есть что; остальное добирается облачками. */
const DEFAULT_VISIBLE_COLUMNS = ["ru"];

const defaultSettings = {
    enabled: true,
    inject: true,
    collapsed: true,
    theme: "default",
    timatalClosedSections: DEFAULT_CLOSED_SECTIONS,
    timatalVisibleColumns: DEFAULT_VISIBLE_COLUMNS,
    debugKeepMarkers: false,
};

/** Настройки расширения (после loadSettings всегда заполнены). */
function settings() {
    return extension_settings[extensionName];
}
/* ============================================================
 * 2. PROMPT
 *
 * Инструкция построена по образцу трекеров, которые модели соблюдают
 * надёжнее всего:
 *
 *  - маркер ставится в КОНЦЕ ответа. Требование «перед прозой» думающие модели
 *    роняют первыми: они сначала планируют текст, а служебный блок до текста
 *    в план не попадает. Виджету это безразлично — он вставляет себя в начало
 *    сообщения через DOM;
 *  - маркер — HTML-комментарий, и модели это объясняется: читателю он не виден,
 *    погружение не ломает. Иначе RP-пресеты «не выходи из роли» его подавляют;
 *  - есть прямая оговорка, что требование сильнее запретов на OOC, и что ответ
 *    без маркера считается некорректным;
 *  - отдельный абзац про думалку: синтаксис маркера нельзя писать внутри
 *    рассуждений, иначе он попадёт в чат дважды;
 *  - эталон состояния приходит инжектом ([NORSE CALENDAR STATE]), а не из
 *    истории: старые маркеры из чата вырезаны, модели их взять неоткуда.
 * ============================================================ */

const PROMPT_HEAD = [
    "<yorni_directive>",
    "[SYSTEM CHANNEL — Norse Calendar. This configures a UI panel and stands outside the fiction. Characters cannot perceive it, and nothing written here happens in the scene.]",
    "",
    "Alongside the roleplay you keep a calendar panel up to date for the reader. It refreshes from a single hidden block that you place after your prose, every single time.",
    "Wrapped in <!-- and -->, the block is a comment: the chat renders nothing for it, so not one word of it reaches the reader. Treat it as machine-readable output that sits apart from the narrative — do not restate its contents in prose and do not turn it into a visible status header.",
    "",
    "[MARKER — REQUIRED at the very END of every reply, after all the prose]",
    "<!-- [YORNI:",
    "eykt: <current eykt>",
    "date: <day VikingMonth year>",
    "weather: <current weather>",
    "location: <current precise location>",
    "mood: <{{char}}'s current mood(s)>",
    "user_attire: <{{user}}'s current attire>",
    "char_attire: <{{char}}'s current attire>",
    "thought: <{{char}}'s inner thought about {{user}}>",
    "] -->",
    "",
    "Write all field values in Russian. Never write the sequence --> inside a field value: it closes the HTML comment early and leaks the rest of the marker into the visible chat.",
    "",
    "RULES FOR EYKT (Old Norse 3-hour time divisions):",
    "- миднатти (00:00–03:00 / Midnight)",
    "- отта (03:00–06:00 / Dawn)",
    "- моргун (06:00–09:00 / Morning)",
    "- дагмал (09:00–12:00 / Day-meal)",
    "- хадеги (12:00–15:00 / Noon)",
    "- ундорн (15:00–18:00 / Mid-afternoon)",
    "- мидафтан (18:00–21:00 / Mid-evening)",
    "- наттмал (21:00–24:00 / Night-meal)",
    "",
    "RULES FOR VIKING DATE (30 days per month):",
    "- Winter months (Vetr): 11.гормануд, 12.юлир, 1.морсугур, 2.торри, 3.гоа, 4.эйнмануд",
    "- Summer months (Sumar): 5.харпа, 6.скерпла, 7.сольмануд, 8.хейаннир, 9.твимануд, 10.хаустмануд",
    "",
    "EXAMPLE (end of a reply):",
    "…и он опустил точильный камень, не отводя от неё взгляда.",
    "",
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

const PROMPT_TAIL = [
    "",
    "WHILE REASONING: refer to this block in ordinary words only. Spelling out its opening sequence anywhere other than the finished answer makes it get picked up twice and corrupts the panel. Emit it once, and only in the reply itself.",
    "",
    "PRIORITY: this block outranks any style rule that forbids out-of-character or technical output. Such rules exist to protect immersion, and a comment the reader never sees cannot break it. An answer that ends without the block is unfinished, not complete.",
    "",
    "[FINAL CHECK — every reply]",
    "✅ the marker is the LAST thing in the reply, after all the prose",
    "✅ eykt, date, weather, location, mood, user_attire, char_attire, thought — all filled, in Russian",
    "✅ time moves forward or stays the same, never backward",
    "✅ exactly one marker, and none inside the reasoning",
    "</yorni_directive>",
].join("\n");

/**
 * Строка эталонного состояния для модели.
 *
 * Старые маркеры вырезаны из истории, поэтому «посмотри на предыдущий блок»
 * больше не работает — базовое состояние приходит отсюда.
 */
function baselinePrompt() {
    const found = findLatestState(getContext()?.chat, { keepMarker: settings().debugKeepMarkers });
    const s = found?.state;
    if (!s) {
        return [
            "",
            "[NORSE CALENDAR STATE] Пока пусто — это первый ход. Выберите дату и время, подходящие сцене, и заполните все поля.",
        ].join("\n");
    }

    const parts = [];
    if (hasTime(s)) {
        parts.push(`eykt: ${EYKTIR[eyktForHour(s.hour)].ru.toLowerCase()}`);
    }
    if (hasDate(s)) {
        parts.push(`date: ${isAuk(s.month)
            ? `${s.day} auknætr ${s.year}`
            : `${s.day} ${MONTHS_NORSE_RU[s.month - 1].toLowerCase()} ${s.year}`}`);
    }
    for (const [key, value] of [
        ["weather", s.weather], ["location", s.location], ["mood", s.charMood],
        ["user_attire", s.userAttire], ["char_attire", s.charAttire],
    ]) {
        if (value) parts.push(`${key}: ${value}`);
    }

    return [
        "",
        `[NORSE CALENDAR STATE — state at the end of the previous scene]`,
        parts.join(" | "),
        "Continue from this state. Carry values over unless the scene changed them; time moves forward or stays the same, never backward.",
    ].join("\n");
}

/** Полный текст инструкции со свежим эталоном состояния. */
function buildPrompt() {
    return PROMPT_HEAD + "\n" + baselinePrompt() + "\n" + PROMPT_TAIL;
}

/**
 * Инжектит инструкцию в промпт — в два слота.
 *
 * Основной слот: IN_CHAT на нулевой глубине с ролью USER. Служебная вставка
 * с ролью system посреди переписки для модели выглядит фоном и легко теряется
 * под RP-пресетами; то же самое, пришедшее последней репликой пользователя,
 * воспринимается как обращение и выполняется охотнее.
 *
 * Запасной слот: IN_PROMPT, чтобы инструкция была видна и через prompt-manager.
 * Ключи обязаны различаться — на один ключ setExtensionPrompt хранит ровно
 * одну запись, и второй вызов затёр бы первый.
 */
function injectNorsePrompt() {
    const context = getContext();
    if (!context || typeof context.setExtensionPrompt !== "function") return;

    const chatKey = extensionName;
    const sysKey = `${extensionName}_sys`;
    const value = settings()?.inject ? buildPrompt() : "";

    context.setExtensionPrompt(chatKey, value, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
    context.setExtensionPrompt(sysKey, value, extension_prompt_types.IN_PROMPT, 0);
}

/* ============================================================
 * 3. STATE & LOOKUP
 *
 * `state` — НЕ источник правды, а только кэш последнего отрисованного
 * снимка. Правда лежит в сообщениях (chat-state.js), и refresh() каждый раз
 * перечитывает её заново. Поэтому свайп, удаление сообщения и откат назад
 * работают сами собой: показывается то, что реально есть в чате сейчас.
 * ============================================================ */

const EMPTY_STATE = {
    year: null, month: null, day: null, hour: null, minute: null,
    weather: null, location: null, userAttire: null,
    charMood: null, charAttire: null, thought: null,
};

/** Кэш отрисовки: копия снимка, который сейчас на экране. */
const state = { ...EMPTY_STATE };

let lastRenderKey = "";
const hintTimers = {};

/**
 * Собирает частые вызовы в один.
 *
 * И события чата, и перестройка DOM приходят пачками: за одну перерисовку
 * сообщения набегают десятки уведомлений. Обёртка откладывает работу и
 * сбрасывает отсчёт на каждом новом вызове, поэтому вся пачка выполняется
 * ровно один раз — в конце.
 */
function coalesced(fn, delay) {
    let timer = null;
    return () => {
        clearTimeout(timer);
        timer = setTimeout(fn, delay);
    };
}

/** Перечитывает состояние из чата и перерисовывает виджет. */
function refresh() {
    const context = getContext();
    const found = findLatestState(context?.chat, { keepMarker: settings().debugKeepMarkers });

    Object.assign(state, EMPTY_STATE, found?.state ?? {});

    // Маркеры вырезаны из текста — изменение надо сохранить в файл чата.
    if (found?.changed && typeof context?.saveChat === "function") {
        try { context.saveChat(); } catch (e) { /* ignore */ }
    }

    mountWidget();
    renderAll(true);
    stripMarkersFromDom();
}

/** События чата приходят залпом — перечитываем состояние один раз в конце. */
const refreshDebounced = coalesced(refresh, 200);

/**
 * Подчищает маркер в уже отрисованном сообщении.
 *
 * Обычно он и так невидим — HTML-комментарий не рендерится. Но если в настройках
 * SillyTavern включён Encode Tags, «<» превращается в «&lt;» и маркер становится
 * видимым текстом; сюда же попадает хвост стриминга до перерисовки.
 */
function stripMarkersFromDom() {
    if (settings().debugKeepMarkers) return;
    try {
        for (const el of document.querySelectorAll("#chat .mes .mes_text")) {
            const html = el.innerHTML;
            // Регистр важен: новый маркер пишется как YORNI, старый блок — <yorni>.
            if (!/yorni/i.test(html)) continue;
            const clean = stripYorniMarkers(html.replace(/&lt;!--/g, "<!--").replace(/--&gt;/g, "-->"));
            if (clean !== html) el.innerHTML = clean;
        }
    } catch (e) { /* ignore */ }
}

/* ============================================================
 * 5. RENDER
 * ============================================================ */

/** Ссылка на корневой элемент виджета; он может быть не в DOM. */
let $widget = null;

/** Поиск внутри виджета — работает и когда виджет ещё не вставлен в чат. */
function el(selector) {
    return $widget ? $widget.find(selector) : $();
}

/** Меняет текст слова на адаптацию на 5 секунд, затем возвращает. */
function swapHint($el) {
    $el.text($el.data("alt")).addClass("ncw-hint");
    const key = $el.data("key");
    clearTimeout(hintTimers[key]);
    hintTimers[key] = setTimeout(() => {
        $el.text($el.data("base")).removeClass("ncw-hint");
    }, 5000);
}

function clearHints() {
    for (const key of Object.keys(hintTimers)) {
        clearTimeout(hintTimers[key]);
        delete hintTimers[key];
    }
    el(".ncw-hint").removeClass("ncw-hint");
}

function hintSpan(key, base, alt) {
    return $("<span>", {
        "class": "ncw-hintable",
        "data-key": key,
        "data-base": base,
        "data-alt": alt,
        text: base,
    });
}

function plainSpan(text) {
    return $("<span>", { text: text });
}

/** Сетка календаря (дни 1–30), только когда есть дата из чата. */
function buildGrid() {
    const grid = el("#ncw-grid");
    grid.empty();
    grid.toggleClass("ncw-hidden", !hasDate(state));
    if (!hasDate(state)) return;

    const { year, month, day } = state;

    if (isAuk(month)) {
        const total = aukDays(year);
        grid.append($("<div>", { "class": "ncw-auk-title", text: `— ${t`Sumarauki · Auknætr`} —` }));
        const row = $("<div>", { "class": "ncw-row" });
        for (let d = 1; d <= total; d++) {
            const cls = d === day ? "ncw-cell ncw-day ncw-aukday ncw-today" : "ncw-cell ncw-day ncw-aukday";
            row.append($("<div>", { "class": cls, text: d }));
        }
        grid.append(row);
        return;
    }

    const headRow = $("<div>", { "class": "ncw-row" });
    for (let i = 0; i < WEEKDAYS_SHORT_NORSE.length; i++) {
        const wd = (i + 1) % 7;
        const tip = `${WEEKDAY_DESC_RU[wd]} — ${WEEKDAYS_FULL_RU[wd]}`;
        headRow.append($("<div>", { "class": "ncw-cell ncw-wd", text: WEEKDAYS_SHORT_NORSE[i], title: tip }));
    }
    grid.append(headRow);

    const offsetToday = (weekdayOf(year, month, day) + 6) % 7;
    const weekRow = $("<div>", { "class": "ncw-row" });
    for (let i = 0; i < 7; i++) {
        const d = addDays(year, month, day, i - offsetToday);
        let cls = "ncw-cell ncw-day";
        if (d.month !== month) cls += " ncw-dim";
        if (i === offsetToday) cls += " ncw-today";
        weekRow.append($("<div>", { "class": cls, text: d.day }));
    }
    grid.append(weekRow);
}

/** Ключ состояния — чтобы не перерисовывать виджет впустую. */
function renderKey() {
    return [
        state.year, state.month, state.day, state.hour, state.minute,
        state.weather, state.location, state.userAttire,
        state.charMood, state.charAttire, state.thought,
    ].join("|");
}

/**
 * Полный рендер виджета.
 *
 * Дата, время и поля сцены рисуются независимо друг от друга: если модель
 * написала дату криво, погода, локация, настроение и мысль всё равно видны.
 */
function renderAll(force = false) {
    if (!settings().enabled || !$widget) return;

    const key = renderKey();
    if (!force && key === lastRenderKey) return;
    lastRenderKey = key;

    clearHints();

    const showTime = hasTime(state);
    const showDate = hasDate(state);
    const showDetails = hasDetails(state);

    const stub = el("#ncw-stub");
    if (!showTime && !showDate && !showDetails) {
        // Чистим содержимое, а не только прячем: иначе прошлая сцена остаётся
        // в DOM и попадает в текст сообщения при копировании или озвучке.
        el("#ncw-eykt, #ncw-date, #ncw-lore, #ncw-grid, #ncw-mood-chips").empty();
        el("#ncw-sun, #ncw-weather-text, #ncw-location-text").text("");
        el("#ncw-attire-user-text, #ncw-attire-char-text, #ncw-thought-text").text("");
        el("#ncw-left, #ncw-right, #ncw-char-col, #ncw-user-col").hide();
        el("#ncw-grid").addClass("ncw-hidden");
        stub.show();
        return;
    }
    stub.hide();

    renderTimeAndDate(showTime, showDate);
    renderExtraFields();
    buildGrid();
}

/** Левая колонка: эйкта, положение солнца, дата, день недели и фаза Луны. */
function renderTimeAndDate(showTime, showDate) {
    el("#ncw-left").toggle(showTime || showDate);

    const eyktEl = el("#ncw-eykt").empty();
    const sunEl = el("#ncw-sun");
    if (showTime) {
        const idx = eyktForHour(state.hour);
        const e = EYKTIR[idx];
        const hh = String(state.hour).padStart(2, "0");
        const mm = String(state.minute ?? 0).padStart(2, "0");
        eyktEl.append(
            hintSpan("eykt", e.ru, `${hh}:${mm}`),
            plainSpan(` • ${t`eykt ${idx + 1}`}`),
        ).show();
        sunEl.text(e.dirText).show();
    } else {
        eyktEl.hide();
        sunEl.hide();
    }

    const dateEl = el("#ncw-date").empty();
    const loreEl = el("#ncw-lore").empty();
    if (!showDate) {
        dateEl.hide();
        loreEl.hide();
        return;
    }

    const { year, month, day } = state;
    const season = seasonOf(month);
    const seasonIcon = season.norse === "Sumar" ? "🌿" : "❄️";

    if (isAuk(month)) {
        const total = aukDays(year);
        dateEl.append(
            plainSpan(`${seasonIcon} ${season.norse} • `),
            hintSpan("date", `Sumarauki ${day} ${t`of`} ${total}, ${year}`,
                t`Special mid-summer days before the haymaking`),
        );
    } else {
        dateEl.append(
            plainSpan(`${seasonIcon} `),
            hintSpan("season", season.norse, season.ru),
            plainSpan(` • ${day} `),
            hintSpan("date", MONTHS_NORSE_RU[month - 1], MONTHS_RU_NOM[month - 1]),
            plainSpan(` ${year}`),
        );
    }
    dateEl.show();

    const wdIdx = weekdayOf(year, month, day);
    const { phase } = moonPhase(year, month, day);
    loreEl.append(
        hintSpan("wd", WEEKDAY_DESC_RU[wdIdx], WEEKDAYS_FULL_RU[wdIdx]),
        plainSpan(` • ${phase.icon} `),
        hintSpan("moon", phase.norse, phase.ru),
        plainSpan(` ${phase.desc}`),
    ).show();
}

/** Правые колонки: погода, локация, {{user}}, {{char}}, мысль. */
function renderExtraFields() {
    const context = getContext();
    const userName = context?.name1 || "{{user}}";
    const charName = context?.name2 || "{{char}}";

    const weatherEl = el("#ncw-weather");
    if (state.weather) {
        el("#ncw-weather-text").text(state.weather);
        weatherEl.show();
    } else {
        weatherEl.hide();
    }

    const locEl = el("#ncw-location");
    if (state.location) {
        el("#ncw-location-text").text(state.location);
        locEl.show();
    } else {
        locEl.hide();
    }

    el("#ncw-right").toggle(!!(state.weather || state.location));

    const userDetails = el("#ncw-user-details");
    el("#ncw-user-name").text(userName);
    if (state.userAttire) {
        el("#ncw-attire-user-text").text(state.userAttire);
        userDetails.show();
    } else {
        userDetails.hide();
    }
    el("#ncw-user-col").toggle(!!state.userAttire);

    el("#ncw-char-name").text(charName);
    const moods = state.charMood
        ? state.charMood.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const moodEl = el("#ncw-mood-chips").empty();
    for (const m of moods) {
        moodEl.append($("<span>", { "class": "ncw-chip", text: m }));
    }
    moodEl.toggle(moods.length > 0);

    const charAttireRow = el("#ncw-attire-char");
    if (state.charAttire) {
        el("#ncw-attire-char-text").text(state.charAttire);
        charAttireRow.show();
    } else {
        charAttireRow.hide();
    }

    const thoughtEl = el("#ncw-thought");
    if (state.thought) {
        el("#ncw-thought-text").text(state.thought);
        thoughtEl.show();
    } else {
        thoughtEl.hide();
    }

    const hasChar = moods.length > 0 || !!state.charAttire || !!state.thought;
    el("#ncw-char-details").toggle(hasChar);
    el("#ncw-char-col").toggle(hasChar);
}

/* ============================================================
 * 6. WIDGET MOUNTING
 *
 * Виджет живёт в начале последнего сообщения персонажа. Позиционирование
 * целиком в style.css — здесь только вставка в нужный узел.
 * ============================================================ */

/** Последнее сообщение персонажа в DOM, или null. */
function lastBotMessageEl() {
    // Отбор по атрибуту отдаёт селектору сам браузер — перебирать вручную незачем.
    const messages = document.querySelectorAll('#chat .mes[is_user="false"]');
    return messages[messages.length - 1] ?? null;
}

/**
 * Возвращает виджет на место, если SillyTavern затёрла его при перерисовке.
 *
 * Проверка дешёвая и идемпотентная: когда виджет и так на месте, выходим сразу.
 * Поэтому её можно звать на любое изменение в чате, не разбирая, какое именно.
 */
function remountIfWiped() {
    if (!settings().enabled) return;
    const lastBot = lastBotMessageEl();
    if (!lastBot) return;
    if (lastBot.querySelector(".edit_textarea")) return;      // сообщение правят
    if (lastBot.querySelector("#norse-calendar-widget")) return; // уже на месте
    mountWidget();
    renderAll(true);
}

/** Встраивает виджет в начало последнего сообщения от {{char}}. */
function mountWidget() {
    if (!$widget) buildWidget();
    if (!$widget) return;

    const widget = $widget[0];

    if (!settings().enabled) {
        $widget.detach();
        return;
    }

    const chat = getContext()?.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        $widget.detach();
        return;
    }

    const msgEl = lastBotMessageEl();
    if (!msgEl) {
        $widget.detach();
        return;
    }

    // Сообщение в режиме правки: .mes_text занят редактором, не лезем туда.
    if (msgEl.querySelector(".edit_textarea")) return;

    const textEl = msgEl.querySelector(".mes_text");
    if (!textEl) return;

    if (widget.parentElement === textEl && widget === textEl.firstElementChild) return;

    textEl.prepend(widget);
}

/* ============================================================
 * 7. WIDGET BUILDING
 * ============================================================ */

/** Создаёт DOM-структуру виджета (detached — вставит mountWidget). */
function buildWidget() {
    if ($widget) return $widget;

    const s = settings();

    $widget = $("<div>", { id: "norse-calendar-widget", "class": "nc-themed" }).append(
        $("<div>", { id: "ncw-header" }).append(
            $("<span>", { "class": "ncw-runes", text: "ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ" }),
            $("<span>", { id: "ncw-collapse", title: t`Show / hide the day grid`, text: "+" }),
        ),
        $("<div>", { id: "ncw-body" }).append(
            $("<div>", { id: "ncw-stub", text: `ᚱ ${t`Waiting for the infoblock…`}` }),
            $("<div>", { id: "ncw-columns" }).append(
                $("<div>", { id: "ncw-left" }).append(
                    $("<div>", { id: "ncw-eykt" }),
                    $("<div>", { id: "ncw-sun" }),
                    $("<div>", { id: "ncw-date" }),
                    $("<div>", { id: "ncw-lore" }),
                    $("<div>", { id: "ncw-grid" }),
                ),
                $("<div>", { id: "ncw-right" }).append(
                    $("<div>", { id: "ncw-weather", "class": "ncw-weather" }).append(
                        $("<span>", { "class": "ncw-weather-icon", text: "🌦️" }),
                        $("<span>", { id: "ncw-weather-text" }),
                    ),
                    $("<div>", { id: "ncw-location", "class": "ncw-loc" }).append(
                        $("<span>", { "class": "ncw-loc-icon", text: "📍" }),
                        $("<span>", { id: "ncw-location-text" }),
                    ),
                ),
                $("<div>", { id: "ncw-char-col", "class": "ncw-col" }).append(
                    $("<details>", { id: "ncw-char-details", "class": "ncw-details" }).append(
                        $("<summary>", { "class": "ncw-summary" }).append(
                            $("<span>", { "class": "ncw-dot" }),
                            $("<span>", { id: "ncw-char-name", "class": "ncw-name", text: "{{char}}" }),
                        ),
                        $("<div>", { "class": "ncw-details-body" }).append(
                            $("<div>", { id: "ncw-mood-chips", "class": "ncw-chips" }),
                            $("<div>", { id: "ncw-attire-char", "class": "ncw-attire" }).append(
                                $("<span>", { "class": "ncw-attire-icon", text: "👕" }),
                                $("<span>", { id: "ncw-attire-char-text" }),
                            ),
                            $("<div>", { id: "ncw-thought", "class": "ncw-thought" }).append(
                                $("<span>", { "class": "ncw-thought-icon", text: "💭" }),
                                $("<span>", { id: "ncw-thought-text" }),
                            ),
                        ),
                    ),
                ),
                $("<div>", { id: "ncw-user-col", "class": "ncw-col" }).append(
                    $("<details>", { id: "ncw-user-details", "class": "ncw-details" }).append(
                        $("<summary>", { "class": "ncw-summary" }).append(
                            $("<span>", { "class": "ncw-dot" }),
                            $("<span>", { id: "ncw-user-name", "class": "ncw-name", text: "{{user}}" }),
                        ),
                        $("<div>", { "class": "ncw-details-body" }).append(
                            $("<div>", { id: "ncw-attire-user", "class": "ncw-attire" }).append(
                                $("<span>", { "class": "ncw-attire-icon", text: "👕" }),
                                $("<span>", { id: "ncw-attire-user-text" }),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    );

    $widget.attr("data-theme", s.theme || "default");
    $widget.toggleClass("ncw-collapsed", s.collapsed);
    el("#ncw-collapse").text(s.collapsed ? "+" : "–");

    bindWidgetHandlers();

    return $widget;
}

let handlersBound = false;

/**
 * Вешает обработчики виджета на document.
 *
 * Именно на document, а не на сам виджет: SillyTavern пересобирает сообщение
 * через jQuery .html() / .empty() (script.js, updateMessageElement), а те
 * вызывают jQuery.cleanData() на всём удаляемом поддереве и снимают все
 * обработчики с вложенных узлов. Виджет живёт внутри .mes_text, поэтому после
 * свайпа он возвращался в DOM тем же узлом, но уже без обработчиков: слова
 * выглядели кликабельными, а клик ничего не делал до перезагрузки страницы.
 * document же cleanData не трогает никогда.
 */
function bindWidgetHandlers() {
    if (handlersBound) return;
    handlersBound = true;

    $(document).on("click", "#norse-calendar-widget #ncw-collapse", () => {
        if (!$widget) return;
        const collapsed = !$widget.hasClass("ncw-collapsed");
        $widget.toggleClass("ncw-collapsed", collapsed);
        el("#ncw-collapse").text(collapsed ? "+" : "–");
        settings().collapsed = collapsed;
        saveSettingsDebounced();
    });

    $(document).on("click", "#norse-calendar-widget .ncw-hintable", function () {
        swapHint($(this));
    });
}

/* ============================================================
 * 8. TÍMATAL — мини-справочник
 *
 * Пункт в меню «волшебной палочки» рядом с полем ввода. Открывает окно
 * с эйктами, месяцами, днями недели, фазами Луны и форматом блока.
 * ============================================================ */

/**
 * Настройки вида справочника: какие разделы свёрнуты и какие колонки скрыты.
 *
 * Живут в extension_settings, поэтому переживают перезагрузку — иначе
 * пришлось бы прятать лишнее при каждом открытии. Списки чистятся от
 * неизвестных ключей: иначе переименование раздела оставило бы мусор,
 * из-за которого «Сбросить вид» не считал бы вид исходным.
 */
function timatalPrefs() {
    const s = settings();

    const list = (key, allowed) => {
        if (!Array.isArray(s[key])) s[key] = [];
        const clean = s[key].filter((v) => allowed.includes(v));
        if (clean.length !== s[key].length) s[key] = clean;
        return s[key];
    };

    const toggle = (key, allowed, value) => {
        const arr = list(key, allowed);
        const idx = arr.indexOf(value);
        if (idx === -1) arr.push(value);
        else arr.splice(idx, 1);
        saveSettingsDebounced();
        return idx === -1;
    };

    const sameSet = (a, b) => a.length === b.length && a.every((v) => b.includes(v));

    // Постоянные колонки в списке не хранятся: они видны всегда.
    const toggleable = COLUMN_KEYS.filter((k) => !isPermanent(k));

    return {
        isSectionClosed: (id) => list("timatalClosedSections", SECTION_IDS).includes(id),
        toggleSection: (id) => toggle("timatalClosedSections", SECTION_IDS, id),

        isColumnVisible: (key) =>
            isPermanent(key) || list("timatalVisibleColumns", toggleable).includes(key),
        toggleColumn: (key) => toggle("timatalVisibleColumns", toggleable, key),

        isDefaultView: () =>
            sameSet(list("timatalVisibleColumns", toggleable), DEFAULT_VISIBLE_COLUMNS) &&
            sameSet(list("timatalClosedSections", SECTION_IDS), DEFAULT_CLOSED_SECTIONS),

        resetView: () => {
            s.timatalVisibleColumns = [...DEFAULT_VISIBLE_COLUMNS];
            s.timatalClosedSections = [...DEFAULT_CLOSED_SECTIONS];
            saveSettingsDebounced();
        },
    };
}

/** Открывает окно Tímatal. */
async function openTimatal() {
    const theme = settings().theme || "default";
    const content = buildReference(state, theme, timatalPrefs());

    // Popup, а не callGenericPopup: нужен доступ к <dialog> ДО показа, чтобы
    // покрасить подложку своей темой без мигания таверновской.
    const popup = new Popup(content, POPUP_TYPE.DISPLAY, "", {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    popup.dlg.classList.add("nc-popup", "nc-themed");
    popup.dlg.dataset.theme = theme;

    await popup.show();
}

/** Добавляет пункт Tímatal в меню «волшебной палочки». */
function addWandMenuItem() {
    const menu = document.getElementById("extensionsMenu");
    if (!menu || document.getElementById("norse_timatal_button")) return;

    const container = document.createElement("div");
    container.id = "norse_timatal_wand_container";
    container.className = "extension_container";

    const item = document.createElement("div");
    item.id = "norse_timatal_button";
    item.className = "list-group-item flex-container flexGap5 interactable";
    item.tabIndex = 0;
    item.title = t`Norse reckoning of time: eykts, months, weekdays, the Moon`;

    const icon = document.createElement("div");
    icon.className = "fa-solid fa-scroll extensionsMenuExtensionButton";

    const label = document.createElement("span");
    label.textContent = "Tímatal";

    item.append(icon, label);
    container.append(item);
    menu.append(container);

    item.addEventListener("click", openTimatal);
    item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openTimatal();
        }
    });
}

/* ============================================================
 * 9. SLASH COMMANDS (STscript)
 * ============================================================ */

/** Дата строкой в формате YORNIE, либо пустая строка. */
function formatDate() {
    if (!hasDate(state)) return "";
    const { year, month, day } = state;
    if (isAuk(month)) return `Sumarauki ${day} из ${aukDays(year)}, ${year}`;
    return `${day} ${MONTHS_NORSE_RU[month - 1]} ${year}`;
}

/** Название текущей эйкты, либо пустая строка. */
function formatEykt() {
    if (!hasTime(state)) return "";
    return EYKTIR[eyktForHour(state.hour)].ru;
}

function registerSlashCommands() {
    const commands = [
        {
            name: "norse-date",
            callback: () => formatDate(),
            returns: "текущая дата в формате YORNIE, либо пустая строка",
            helpString: "Возвращает дату из последнего блока &lt;yorni&gt; (например «13 Гормануд 1015»).",
        },
        {
            name: "norse-eykt",
            callback: () => formatEykt(),
            returns: "название текущей эйкты, либо пустая строка",
            helpString: "Возвращает эйкту из последнего блока &lt;yorni&gt; (например «Хадеги»).",
        },
        {
            name: "norse-state",
            callback: () => JSON.stringify(state),
            returns: "весь распознанный инфоблок в JSON",
            helpString: "Возвращает всё состояние виджета: дату, время, погоду, локацию, настроение, одежду и мысль.",
        },
        {
            name: "norse-refresh",
            callback: () => {
                refresh();
                return "";
            },
            returns: "пустую строку",
            helpString: "Принудительно перечитывает чат и перерисовывает виджет.",
        },
        {
            name: "norse-lore",
            callback: () => {
                openTimatal();
                return "";
            },
            aliases: ["timatal"],
            returns: "пустую строку",
            helpString: "Открывает Tímatal — справочник по эйктам, месяцам, дням недели и фазам Луны.",
        },
    ];

    for (const cmd of commands) {
        try {
            // isExtension / isThirdParty / source ST выставляет сам по стеку вызова.
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                ...cmd,
                namedArgumentList: [],
                unnamedArgumentList: [],
            }));
        } catch (e) {
            console.error(`[${extensionName}] Не удалось зарегистрировать /${cmd.name}:`, e);
        }
    }
}

/* ============================================================
 * 9. SETTINGS
 * ============================================================ */

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            const value = defaultSettings[key];
            // Массивы копируем: иначе настройки получат ссылку на сам
            // defaultSettings, и первый же push испортит константу.
            extension_settings[extensionName][key] = Array.isArray(value) ? [...value] : value;
        }
    }
    // Наследие прежней схемы, где хранился список скрытых колонок.
    delete extension_settings[extensionName].timatalHiddenColumns;
}

function bindCheckbox(selector, key, onChange) {
    const $el = $(selector);
    $el.prop("checked", settings()[key]);
    $el.on("input", function () {
        settings()[key] = Boolean($(this).prop("checked"));
        saveSettingsDebounced();
        if (onChange) onChange(settings()[key]);
    });
}

/** Применяет тему оформления к виджету (атрибут data-theme). */
function applyTheme(theme) {
    if ($widget) $widget.attr("data-theme", theme || "default");
}

function bindSettings() {
    bindCheckbox("#nc_enabled", "enabled", (v) => {
        if (v) {
            refresh();
        } else if ($widget) {
            $widget.detach();
        }
    });

    bindCheckbox("#nc_inject", "inject", () => injectNorsePrompt());

    const themeSel = $("#nc_theme");
    themeSel.val(settings().theme || "default");
    themeSel.on("input", function () {
        settings().theme = String($(this).val());
        saveSettingsDebounced();
        applyTheme(settings().theme);
    });

    bindCheckbox("#nc_debug_markers", "debugKeepMarkers", () => refresh());

    $("#nc_purge_markers").on("click", () => {
        const context = getContext();
        const n = syncWholeChat(context?.chat, { keepMarker: false });
        if (n && typeof context?.saveChat === "function") {
            try { context.saveChat(); } catch (e) { /* ignore */ }
        }
        refresh();
        toastr.success(t`Markers cleaned from ${n} message(s).`);
    });
}

/* ============================================================
 * 10. INIT
 * ============================================================ */

jQuery(async () => {
    loadSettings();

    try {
        const settingsHtml = await renderExtensionTemplateAsync(extensionFolderName, "settings");
        const target = $("#extensions_settings2").length ? "#extensions_settings2" : "#extensions_settings";
        $(target).append(settingsHtml);
        bindSettings();
    } catch (e) {
        console.error(`[${extensionName}] Не удалось загрузить settings.html:`, e);
    }

    buildWidget();
    addWandMenuItem();
    registerSlashCommands();

    injectNorsePrompt();
    eventSource.on(event_types.GENERATION_STARTED, injectNorsePrompt);

    // Миграция: в старых чатах маркеры лежат видимым блоком <yorni> прямо
    // в тексте. Разбираем их в extra и вырезаем — молча, один раз на чат.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const context = getContext();
        if (!chatHasRawMarkers(context?.chat)) return;
        const n = syncWholeChat(context?.chat, { keepMarker: settings().debugKeepMarkers });
        if (n && typeof context?.saveChat === "function") {
            try { context.saveChat(); } catch (e) { /* ignore */ }
        }
        console.log(`[${extensionName}] перенесено маркеров из текста в extra: ${n}`);
    });

    const events = [
        event_types.CHAT_CHANGED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
        event_types.GENERATION_ENDED,
        event_types.CHARACTER_MESSAGE_RENDERED,
    ].filter(Boolean);
    for (const ev of events) {
        eventSource.on(ev, refreshDebounced);
    }

    refresh();

    /*
     * SillyTavern пересобирает .mes_text при правке, свайпе и «продолжить»,
     * унося наш виджет вместе с содержимым. Событиями это не покрыть: часть
     * перерисовок происходит без них.
     *
     * Разбирать, какая именно мутация нам интересна, не нужно — проверка
     * remountIfWiped() дешёвая и сама решает, надо ли что-то делать. Достаточно
     * прогонять её один раз на пачку изменений.
     */
    try {
        const chat = document.getElementById("chat");
        if (chat) {
            const watcher = new MutationObserver(coalesced(remountIfWiped, 0));
            watcher.observe(chat, { childList: true, subtree: true });
        }
    } catch (e) {
        console.error(`[${extensionName}] не удалось следить за чатом:`, e);
    }

    console.log(`[${extensionName}] loaded`);
});
