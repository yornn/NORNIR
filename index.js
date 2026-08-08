/*
 * Norse Calendar — расширение-инфоблок для SillyTavern.
 *
 * Модель работы: расширение инжектит в промпт инструкцию, модель отвечает
 * служебным блоком <yorni>...</yorni> с метаданными сцены, а виджет YORNIE
 * рендерит из него эйкту, положение солнца, дату, день недели и фазу Луны.
 *
 * Реальное время не используется — только данные из чата.
 * Лор и разбор блока живут в parser.js (его же импортирует test-parse.mjs).
 *
 * ОГЛАВЛЕНИЕ (STRUCTURE):
 *
 * 1. Imports & Constants  Импорты, имя расширения, настройки, скан-глубина
 * 2. Regex Scripts ...... Скрытие/вырезание блока <yorni> в чате и промпте
 * 3. Prompt ............. Инструкция <yorni> для модели
 * 4. State & Lookup ..... Состояние виджета и поиск блока в чате
 * 5. Render ............. Отрисовка виджета
 * 6. Widget Mounting .... Встраивание в DOM сообщения
 * 7. Widget Building .... Построение DOM-структуры виджета
 * 8. Tímatal ........... Мини-справочник в меню «волшебной палочки»
 * 9. Slash Commands ..... STscript-команды /norse-*
 * 10. Settings .......... Панель настроек SillyTavern
 * 11. Init .............. Точка входа, подписки на события
 */

/* ============================================================
 * 1. IMPORTS & CONSTANTS
 * ============================================================ */

import { extension_settings, getContext, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
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
    parseYorniTag,
    seasonOf,
    weekdayOf,
} from "./parser.js";

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
};

const SCAN_DEPTH = 25;

/** Настройки расширения (после loadSettings всегда заполнены). */
function settings() {
    return extension_settings[extensionName];
}

/* ============================================================
 * 2. REGEX SCRIPTS (SillyTavern)
 *
 * Два скрипта для обработки блока <yorni>:
 *  - display: скрывает блок из отрендеренного текста сообщения
 *  - prompt:  вырезает блок из контекста на глубине >= 1,
 *             оставляя последний (depth 0) как baseline
 *
 * markdownOnly и promptOnly в движке ST объединены через OR
 * (extensions/regex/engine.js), поэтому «только промпт» — это
 * promptOnly: true ПРИ markdownOnly: false.
 * ============================================================ */

const YORNI_FIND_REGEX = "/<yorni>[\\s\\S]*?<\\/yorni>/gim";

const YORNI_REGEX_SCRIPTS = [
    {
        id: "norse_calendar_yorni_display",
        scriptName: "Norse Calendar — скрыть <yorni> в чате",
        findRegex: YORNI_FIND_REGEX,
        replaceString: "",
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    },
    {
        id: "norse_calendar_yorni_prompt",
        scriptName: "Norse Calendar — вырезать <yorni> из контекста",
        findRegex: YORNI_FIND_REGEX,
        replaceString: "",
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: true,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: 1,
        maxDepth: null,
    },
];

/**
 * Регистрирует regex-скрипты, которых ещё нет.
 *
 * Существующие НЕ трогает: если пользователь отключил или отредактировал
 * скрипт в UI Regex, его выбор должен пережить перезагрузку страницы.
 * Для принудительного возврата к эталону есть restoreYorniRegexScripts().
 *
 * @returns {number} Сколько скриптов было добавлено
 */
function ensureYorniRegexScripts() {
    if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
    let added = 0;
    for (const script of YORNI_REGEX_SCRIPTS) {
        if (!extension_settings.regex.some((s) => s.id === script.id)) {
            extension_settings.regex.push({ ...script });
            added++;
        }
    }
    if (added > 0) saveSettingsDebounced();
    return added;
}

/** Принудительно возвращает оба скрипта к эталонному виду (кнопка в настройках). */
function restoreYorniRegexScripts() {
    if (!Array.isArray(extension_settings.regex)) extension_settings.regex = [];
    for (const script of YORNI_REGEX_SCRIPTS) {
        const idx = extension_settings.regex.findIndex((s) => s.id === script.id);
        if (idx === -1) {
            extension_settings.regex.push({ ...script });
        } else {
            extension_settings.regex[idx] = { ...script };
        }
    }
    saveSettingsDebounced();
}

/* ============================================================
 * 3. PROMPT (инструкция <yorni> для модели)
 * ============================================================ */

const YORNI_PROMPT = [
    "[Norse Calendar — System Metadata Instruction]",
    "At the VERY BEGINNING of every response, before writing any narrative prose, output exactly one metadata block enclosed strictly within <yorni> and </yorni> tags.",
    "",
    "STRICT CONTINUITY & STATE TRACKING (CRITICAL):",
    "- Look at the MOST RECENT <yorni> block in the chat history as your baseline state.",
    "- DO NOT jump backward in time, reset dates, or hallucinate unrelated months. Time moves strictly forward or stays the same.",
    "- If a scene continues seamlessly, keep the same date and advance the eykt/time logically.",
    "- Dynamically update attire, location, weather, and mood based on the CURRENT events in the RP.",
    "",
    "Use the following key-value format inside the tag (write all field values in Russian):",
    "<yorni>",
    "eykt: <Current Eykt>",
    "date: <Day VikingMonth Year>",
    "weather: <Current weather>",
    "location: <Current precise location>",
    "mood: <{{char}}'s current mood(s)>",
    "user_attire: <{{user}}'s current attire>",
    "char_attire: <{{char}}'s current attire>",
    "thought: <{{char}}'s inner thought about {{user}}>",
    "</yorni>",
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
    "CRITICAL MANDATES:",
    "1. Place the <yorni> block at the VERY TOP of your output before any narrative text.",
    "2. Inherit state strictly from the previous turn — continuous story progression only.",
    "3. Fill all field values in Russian.",
    "4. Never mention or react to the <yorni> tags inside the actual roleplay content.",
    "",
    "EXAMPLE OUTPUT:",
    "<yorni>",
    "eykt: дагмал",
    "date: 4 хаустмануд 1014",
    "weather: Прохладный воздух, сильный северный ветер",
    "location: Деревня, Длинный дом",
    "mood: весёлый, азартный, воодушевлённый",
    "user_attire: Шерстяное платье, меховой плащ",
    "char_attire: Волчьи шкуры, льняная рубаха",
    "thought: Сегодня отличный день для доброй драки!",
    "</yorni>",
].join("\n");

/**
 * Инжектит инструкцию в промпт.
 *
 * Значение живёт в extension_prompts до следующей перезаписи, поэтому
 * достаточно выставить его на GENERATION_STARTED — до того, как Generate()
 * соберёт контекст через doChatInject().
 */
function injectNorsePrompt() {
    const context = getContext();
    if (!context || typeof context.setExtensionPrompt !== "function") return;
    const value = settings()?.inject ? YORNI_PROMPT : "";
    context.setExtensionPrompt(extensionName, value, 1, 0);
}

/* ============================================================
 * 4. STATE & LOOKUP
 * ============================================================ */

const state = {
    year: null,
    month: null,
    day: null,
    hour: null,
    minute: null,
    weather: null,
    location: null,
    userAttire: null,
    charMood: null,
    charAttire: null,
    thought: null,
};

let lastRenderKey = "";
let refreshTimer = null;
const hintTimers = {};

/** Скан сообщений персонажа с конца в поисках блока <yorni>. */
function findLoreDateTime() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== "string") continue;
        if (msg.is_user) continue;
        const fromTag = parseYorniTag(msg.mes);
        if (fromTag) return fromTag;
        if (chat.length - 1 - i >= SCAN_DEPTH) break;
    }
    return null;
}

function applyLore(lore) {
    state.year = lore.year;
    state.month = lore.month;
    state.day = lore.day;
    state.hour = lore.hour;
    state.minute = lore.minute;
    state.weather = lore.weather;
    state.location = lore.location;
    state.userAttire = lore.userAttire;
    state.charMood = lore.charMood;
    state.charAttire = lore.charAttire;
    state.thought = lore.thought;
}

function resetState() {
    for (const key of Object.keys(state)) state[key] = null;
}

function refresh() {
    const lore = findLoreDateTime();
    if (lore) {
        applyLore(lore);
    } else {
        resetState();
    }
    mountWidget();
    renderAll(true);
}

function refreshDebounced() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 200);
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
    const all = document.querySelectorAll("#chat .mes");
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].getAttribute("is_user") === "false") return all[i];
    }
    return null;
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

    $("#nc_regex_restore").on("click", () => {
        restoreYorniRegexScripts();
        toastr.success(t`Norse Calendar regex scripts restored. Reload the page to see them in the list.`);
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
    ensureYorniRegexScripts();

    injectNorsePrompt();
    eventSource.on(event_types.GENERATION_STARTED, injectNorsePrompt);

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

    // MutationObserver: перемонтирует виджет при rebuild .mes_text
    try {
        const chatEl = document.getElementById("chat");
        if (chatEl) {
            let pending = false;
            const reinsert = () => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    try {
                        if (!settings().enabled) return;
                        const lastBot = lastBotMessageEl();
                        if (!lastBot) return;
                        if (lastBot.querySelector(".edit_textarea")) return;
                        if (lastBot.querySelector("#norse-calendar-widget")) return;
                        mountWidget();
                        renderAll(true);
                    } catch (e) { /* ignore */ }
                });
            };
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.target && (m.target.classList?.contains("mes_text") || m.target.classList?.contains("mes"))) {
                        reinsert();
                        return;
                    }
                    for (const n of m.removedNodes || []) {
                        if (n.id === "norse-calendar-widget" || n.querySelector?.("#norse-calendar-widget")) {
                            reinsert();
                            return;
                        }
                    }
                }
            });
            observer.observe(chatEl, { childList: true, subtree: true });
        }
    } catch (e) { /* ignore */ }

    console.log(`[${extensionName}] loaded`);
});
