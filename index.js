/*
 * NORNIR — расширение-инфоблок для SillyTavern.
 *
 * Модель работы: расширение инжектит в промпт инструкцию, модель заканчивает
 * ответ невидимым маркером <!-- [URD: … ] --> с метаданными сцены, расширение
 * разбирает его, кладёт снимок в msg.extra и вырезает маркер из текста.
 * Виджет рендерит из снимка эйкту, положение солнца, дату, день недели
 * и фазу Луны.
 *
 * Реальное время не используется — только данные из чата. Своего «текущего
 * состояния» у расширения нет: и виджет, и промпт каждый раз выводятся из
 * последнего актуального сообщения, поэтому свайпы, удаление и откат работают
 * сами собой (подробности — в chat-state.js).
 *
 * Чат читается ОДНИМ вызовом readChat() на такт, и результат кэшируется до
 * следующего refresh() или инжекта. Раньше дату, тело и снимок брали разными
 * функциями, каждая шла по истории сама, и делали они это с разными
 * настройками — см. комментарий к readState().
 *
 * Календарные таблицы и разбор маркера живут в parser.js, счёт цикла и беременности —
 * в body.js, праздники — в holidays.js, счёт уведомлений — в notify.js. Ни один
 * из них не зависит от SillyTavern, и все покрыты тестами в test-*.mjs.
 *
 * Своей системы уведомлений расширение не заводит: всплывашки показывает сама
 * таверна (toastr), а notify.js только решает, о чём стоит подать голос.
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
 * 8. Slash Commands ..... STscript-команды /nornir-*
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
import { buildReference, COLUMN_KEYS, isPermanent } from "./reference.js";

import {
    AUK_AFTER_MONTH,
    MONTHS,
    WEEKDAYS,
    EYKTIR,
    addDays,
    aukDays,
    eyktForHour,
    isSumaraukiYear,
    vikaOf,
    vikaFirstDay,
    weeksInMisseri,
    dayOfMisseri,
    misseriLength,
    hasDate,
    hasDetails,
    hasTime,
    isAuk,
    moonPhase,
    seasonOf,
    stripUrd,
    weekdayOf,
} from "./parser.js";

import {
    chatHasRawMarkers,
    cycleAnchor,
    pregnancyAnchor,
    readChat,
    setSceneDate,
    syncWholeChat,
} from "./chat-state.js";

import { CYCLE_DEFAULT, bodyView, pregnancyTerm } from "./body.js";

import { DEFAULT_TIERS, HOLIDAY_TIERS, holidayView, markWeek } from "./holidays.js";

import { DEFAULT_NOTICES, NOTICE_IDS, noticesBetween, watchSnapshot } from "./notify.js";

const extensionName = "NORNIR";
const extensionFolderName = `third-party/${extensionName}`;

/* Постоянные колонки (номер и др.-сканд. написание) здесь не перечисляются —
   они всегда на месте. Русский включён, чтобы при первом открытии сразу было
   видно, что есть что; остальное добирается облачками. */
const DEFAULT_VISIBLE_COLUMNS = ["ru"];

const defaultSettings = {
    enabled: true,
    inject: true,
    theme: "thread-dark",
    /*
     * Раскладка и цвет — две разные настройки.
     *
     * skin решает, КАК стоит блок: «thread» — «Дом и его нити», «loom» —
     * её отдельный список, где идёт правка вёрстки. theme решает, КАКОГО
     * ОН ЦВЕТА. Разметка при этом одна: лишнее в каждой раскладке
     * спрятано стилями, а не пересобрано.
     */
    skin: "thread",
    /* Последний цвет КАЖДОЙ раскладки. theme выше — цвет нынешней, он и
       красит блок; здесь лежат отложенные, чтобы возврат к раскладке не
       начинался с её первой темы. */
    skinThemes: { thread: "thread-dark", loom: "loom-dark" },
    /* Какой лист разворота открыт. Нить Фрейи первой не по алфавиту:
       ради неё расширение и писалось. */
    activeTab: "freyja",
    timatalVisibleColumns: DEFAULT_VISIBLE_COLUMNS,
    calendarHints: false,
    /* Праздники: сам показ, слои достоверности и край света. Слои списком,
       а не четырьмя флагами, — их включают пластами, и добавить пятый слой
       не должно значить добавить пятую настройку. */
    holidays: true,
    holidayTiers: [...DEFAULT_TIERS],
    holidayRegion: "all",
    /* Уведомления. Выключены целиком, пока их не попросят: всплывашка поверх
       чата — вещь навязчивая, и включать её должен читатель, а не мы. Виды
       списком по той же причине, что и слои праздников. */
    notify: false,
    notifyKinds: [...DEFAULT_NOTICES],
    bodyTracking: false,
    debugKeepMarkers: false,
};

/** Настройки расширения (после loadSettings всегда заполнены). */
function settings() {
    return extension_settings[extensionName];
}
/* ============================================================
 * 2. PROMPT
 *
 * ВНИМАНИЕ: этот текст проверяется в живой ролевой, и менять его «на глаз»
 * нельзя. Один раз так уже сделали, и пришлось откатывать дословно.
 *
 * ── Устройство ───────────────────────────────────────────────────────────
 *
 * Два потока, и они идут в разные стороны:
 *
 *   вниз  — <norse_time>, <norse_body>, <norse_scene>:
 *           панель рассказывает модели, что есть. Ничего не спрашивает.
 *   вверх — <norse_calendar>: модель отдаёт панели то, что показала сцена.
 *
 * Разделять их обязательно. Всё, что лежит ВНУТРИ <norse_calendar>, модель
 * читает как поле для заполнения, а не как факт сцены: дата, положенная туда,
 * превращалась в «дата такая-то, записал». Поэтому справки живут снаружи,
 * другим тоном и без единой стрелки — их не записывают, их ЗНАЮТ.
 *
 * Что уходит вниз, решает одно правило: показываем то, что героиня знает
 * о себе сама, плюс то, что видно окружающим. Числа счёта — день цикла, часть
 * ношения — не показываем никогда: в этом веке их взять неоткуда, и модель
 * принимается считать вслух.
 *
 * О теле вниз идёт одна строка, и то не всегда: идёт кровь или героиня носит
 * (body.js, bodyView). Женская линия прежде была втрое больше этого промпта —
 * зачатие, приметы, роды, дитя — и мешала ролевой больше, чем помогала.
 * Та версия лежит в ветке testik.
 *
 * ── Маркер на тему ───────────────────────────────────────────────────────
 *
 * Наверх едет не один общий блок, а по маркеру на тему, одной строкой:
 *
 *   <!-- NRN PLACE | weather: Мокрый снег | location: старая пристань -->
 *
 * Общий блок из двадцати строк стоил двух классов ошибок разом. Условное поле
 * в нём выглядело ровно так же, как обязательное, — отсюда midwife и faderni
 * в обычный ход и выпадающие advice и char_state. Теперь у условной темы нет
 * маркера вовсе, и само его отсутствие есть ответ.
 *
 * Второе, ради чего это делалось: у каждой темы своя мера и свой тон, и сказать
 * их можно только рядом с самой темой. В общем блоке «три-пять слов» читалось
 * особенностью одного поля, а не мерой, которую держат все.
 *
 * Цена признаётся честно: синтаксиса в ответе стало больше, а чем чаще он
 * мелькает, тем охотнее думающая модель выписывает его в рассуждениях. Против
 * этого здесь два приёма. Первый — обёртка `<!--` … `-->` названа ровно ДВА
 * раза на весь промпт: в шапке и в примере. В блоках тем стоит только полезная
 * нагрузка, после стрелки. Второй — запреты положительные: названный запретный
 * токен модель начинает выписывать именно там, где его запретили, и это здесь
 * проверено на живых прогонах, а не выведено из общих соображений.
 *
 * Старый формат `<!-- [URD: … ] -->` парсер по-прежнему понимает: в живых
 * чатах его полно, и терять на нём историю нельзя.
 *
 * ── Раскладка блока темы ─────────────────────────────────────────────────
 *
 * Сперва правила полей, потом строка, которую тема отдаёт, после «→».
 * Определение и вывод стоят вплотную: раньше список полей лежал ТРИЖДЫ —
 * определения, шаблон, пример, — и связать копии модель могла только по имени
 * поля. Копий теперь две: правила со стрелкой и один заполненный пример.
 *
 * Обязательность живёт в заголовке блока («every reply» / «only when …»),
 * порядок маркеров в ответе совпадает с порядком блоков, а пример показывает
 * ровно те темы, что требуются каждый ход.
 *
 * ── Рамки полей ──────────────────────────────────────────────────────────
 *
 * У каждого поля сказано, о чём оно, сколько слов и чего в нём быть не должно.
 * Приём не новый: у char_state «три-пять слов» стояло с самого начала, потому
 * что без этого выходил второй thought. Теперь так у всех.
 *
 * ── Язык ─────────────────────────────────────────────────────────────────
 *
 * Инструкции — по-английски, значения — по-русски, и сказано это один раз,
 * в шапке. Английские инструкции плотнее и не подмешиваются в русскую прозу;
 * значения обязаны быть русскими, потому что едут прямо в панель.
 *
 * ── История, чтобы не ходить по кругу ────────────────────────────────────
 *
 * Этот блок один раз переписали целиком: сократили вчетверо, выкинули пример,
 * чек-лист и абзац про думалку. Рассуждения были стройные. На практике вышло
 * наоборот: поехала думалка, модель начала писать в рассуждениях черновик
 * прозы и расписывать блок по полям. Пришлось откатывать дословно.
 *
 * Мораль не в том, что короткий промпт хуже длинного, а в том, что здесь
 * теория ничего не стоит: единственное доказательство — прогон в живой
 * ролевой. Поэтому меняем ОДНУ вещь за раз и каждую проверяем отдельно.
 * ============================================================ */

/* Заглавие канала и все правила, которые действуют на каждую тему ниже.
   Абзац про HTML-комментарий проверен в живой ролевой и переписыванию
   не подлежит: без него RP-пресеты «не выходи из роли» маркеры подавляют. */
const BLOCK_HEADER = [
    "<norse_calendar>",
    "[SYSTEM CHANNEL — NORNIR. A panel reads this, not the people in the story: nothing written here happens in the scene, and no one in it can perceive it. It stands apart from the rules that govern the prose — those guard what the reader sees, and the reader sees none of this.]",
    "",
    "Alongside the roleplay you keep a calendar panel up to date for the reader. It refreshes from a handful of hidden markers that you place after your prose, every single time.",
    "Wrapped in <!-- and -->, each marker is a comment: the chat renders nothing for it, so not one word reaches the reader. Treat them as machine-readable output that sits apart from the narrative — do not restate their contents in prose.",
    "",
    /* Форма маркера названа здесь ОДИН раз. В блоках тем стоит только начинка,
       после стрелки; обёртка повторяется лишь в примере. */
    "Every marker has the same shape — one line, one topic, its fields divided by |:",
    "<!-- NRN TOPIC | field: value | field: value -->",
    "Each part below is one topic. It first gives the rules for its fields, then shows what it contributes, marked with →. What follows the arrow is the inside of the marker; wrap it as shown above and give it a line of its own.",
    /* Оговорка о рассуждениях — сразу за описанием формы, но после того, как
       «as shown above» нашло свою схему: механику ищет collectNrnFields()
       (parser.js), он гонит NRN_TOPIC_RE по ВСЕМУ тексту сообщения. */
    "The opening sequence is what the panel looks for, and it looks through the whole answer. Written out anywhere but the finished reply — in a draft, in reasoning, in an aside about what you are about to do — it is found there just the same, and a topic you only weighed and then chose not to report stands on the board as though the scene had shown it. Until you write the real one, speak of these markers in ordinary words.",
    "A part headed «only when …» contributes nothing until its case comes up: no marker at all, not an empty one. A field with nothing to report is simply left out of its marker.",
    "",
    /* Главная строка всей перестройки. Любое число, посчитанное моделью,
       она считает вслух в рассуждениях — и в каждом свайпе по-своему. */
    "Report what the scene shows. Never work anything out: days, dates and counts are the panel's own reckoning, and it hands them to you in <norse_time>.",
    /* Прежний абсолютный запрет накрывал и те поля, которые без домысла
       не заполнить вовсе. Разводим их явно. */
    "Two fields are yours to judge rather than observe — thought and advice. Everything else is reporting.",
    "",
    "[HOW TO WRITE THE VALUES — every field, every topic]",
    "Language: Russian. Plain words and punctuation, no HTML, no angle brackets, no markup. Topic names and field names stay exactly as written here, in Latin letters.",
    "Length: every field gives its own budget in words. Hold to it. These are notes, not prose — a line that runs long stops summarising the scene and starts competing with it.",
    /* Сеттинг общим правилом: иначе анахронизм ловится только в advice, где
       он назван прямо, а лезет он всюду — «стресс» в нрав, «часы» в сон. */
    "Age and tongue: everything here belongs to the eleventh century and to these people. Name what someone of that age would name — weather by what it does to a body, clothes by cloth and cut, ailments by what is felt rather than by what causes them. No word that had to wait for a later age: no clock hours or minutes, no nerves, no stress, no hormones, no infection, no depression, no vitamins. If a thing has no word in that world, say it in what they had.",
    "Voice: flat and plain, the way a person notices a thing about themselves without remarking on it. No metaphors, no literary turns, no drama. The prose above is where the writing happens; these are the notes underneath it.",
    "",
];

/* Таблица эйкт живёт в <norse_time>: там она читается как устройство мира,
   а не как ещё одно требование трекера. Здесь остаётся одна строка. */
const BLOCK_TIME = [
    "[TIME — every reply]",
    "eykt — which of the eight the scene stands in. One word, the name only. The date is not yours: the panel keeps it and moves it along.",
    "→ NRN TIME | eykt: <the eykt this scene stands in>",
    "",
];

const BLOCK_PLACE = [
    "[PLACE — every reply]",
    "weather — what the sky and the air are doing. Two to six words. What a person standing outside would feel and see: wind, wet, cold, light. Not a forecast, not a mood, not a description of the landscape.",
    "location — where the scene stands, as precisely as the prose allows. Two to six words. Name the place, and the part of it the prose gave. Not what happens there, not who is there.",
    "→ NRN PLACE | weather: <the sky and the air> | location: <where the scene stands>",
    "",
];

/*
 * Одежда — самый короткий блок в промпте, и намеренно.
 *
 * Здесь у нас нет своего знания, и учить модели нечему: во что одеты, она
 * только что написала сама. Хуже того, у пользователя стоит расширение
 * гардероба, которое диктует одежду своим блоком, — и наши рамки заставляли
 * модель переписывать чужие данные под нашу мерку. Два расширения тянули одну
 * строку в разные стороны.
 *
 * Осталось то, чего без вопроса не узнать: во что одеты СЕЙЧАС.
 */
const BLOCK_DRESS = [
    "[DRESS — every reply]",
    "What each of them is wearing at this point in the scene.",
    "user — {{user}}'s clothing.",
    "char — {{char}}'s clothing.",
    "→ NRN DRESS | user: <{{user}}'s clothing> | char: <{{char}}'s clothing>",
    "",
];

const BLOCK_MIND = [
    "[MIND — every reply]",
    "mood — {{char}}'s mood right now. One to four words, the feeling itself. The reason for it belongs in the prose, not here.",
    "thought — one thing {{char}} thinks about {{user}} and does not say aloud. One sentence, in {{char}}'s own voice. One thought, not a train of them; something withheld, not a summary of the scene.",
    "→ NRN MIND | mood: <{{char}}'s mood> | thought: <the unspoken thought>",
    "",
];

/* Состояние тела пишет модель, а не таблица: «продрог у брода» она видит
   в сцене, а расширение — нет. Три-пять слов, иначе выйдет второй thought. */
const BLOCK_FLESH = [
    "[FLESH — every reply]",
    "How the two of them fare in the body, right now, from what the scene showed: tired, cold, aching, hungry, hale, hurt. Three to five words each. What the body is doing — mood and thought already carry what the mind makes of it. If the scene did nothing to them, say plainly that nothing ails them.",
    "char — {{char}}'s body.",
    "user — {{user}}'s body.",
    "→ NRN FLESH | char: <{{char}}'s body, 3-5 words> | user: <{{user}}'s body, 3-5 words>",
    "",
];

/* Совет — поле, где анахронизм проскакивает легче всего, поэтому век назван
   в нём отдельно, помимо общего правила в шапке. */
const BLOCK_ADVICE = [
    "[COUNSEL — every reply]",
    "advice — what a wise woman of this age would tell {{user}} right now. One short sentence, spoken to her. Look both at what she is doing in the scene and at how her body fares: chopping wood while heavy with child earns a word about resting. Her remedies are the ones this age had — brewed herbs, rest, warmth, food, the bath-house, staying off heavy work, sending for someone who knows. Nothing from later ages: no medicines, no physicians, no measured hours of sleep, no counting of days.",
    "→ NRN COUNSEL | advice: <a word of counsel fit for the age>",
    "",
];

/* Пропуск времени — своя тема, а не второе поле в TIME: поле условное,
   а стояло среди обязательных, и заполнялось в обычный ход. */
const BLOCK_SKIP = [
    "[SKIP — only when the story jumps ahead]",
    "passed — how much time went by, as a plain amount of days, weeks, months, moons or years. Never a date, never a clock time, never the day it now is. On an ordinary turn there is no such marker.",
    "→ NRN SKIP | passed: <the length of the skip>",
    "",
];

/*
 * Блока [DATE] здесь нет, и это самая крупная правка за всю отладку.
 *
 * Дата была единственным полем, которое модель не наблюдала в сцене,
 * а ВЫЧИСЛЯЛА: переводила современный месяц в древнеисландский, спорила сама
 * с собой, сольмануд это июль или сентябрь, и делала это вслух — по-разному
 * в каждом свайпе. Теперь дату ставит пользователь через Tímatal, расширение
 * везёт её вперёд, а модели она приезжает готовой строкой в <norse_time>.
 */

/*
 * Заполненный пример.
 *
 * Он единственный на весь промпт, и он остаётся: схема с <плейсхолдерами>
 * показывает форму, но ни одного значения, и тогда модель сочиняет их
 * в рассуждениях. Один раз пример уже выкидывали — и вернули.
 *
 * Зато примеры ИЗ ПРАВИЛ убраны все до единого. Разница между ними такая:
 * образец в конце показывает, как выглядит заполненный ответ целиком, а
 * образец внутри правила читается как ответ на само правило — и списывается.
 *
 * Регистр общий: всё со строчной, кроме имён. Иначе панель показывает вперемешку
 * «Мокрый снег» и «продрог» — заглавная буква приезжает не из смысла, а из того,
 * с чего начиналась строка примера.
 *
 * Пример — ровно обычный ход: шесть тем, которые пишутся каждый раз. Второго
 * примера не ставим: лишний образец модель репетирует целиком.
 */
const BLOCK_EXAMPLE = [
    "EXAMPLE (the end of an ordinary reply):",
    "…и он опустил точильный камень, не отводя от неё взгляда.",
    "",
    "<!-- NRN TIME | eykt: хадеги -->",
    "<!-- NRN PLACE | weather: мокрый снег, порывистый северный ветер | location: побережье фьорда, старая пристань -->",
    "<!-- NRN DRESS | user: шерстяное платье, меховой плащ | char: волчьи шкуры, льняная рубаха -->",
    "<!-- NRN MIND | mood: задумчивый, усталый | thought: она снова смотрит так, будто знает больше -->",
    "<!-- NRN FLESH | char: продрог, ломит плечо | user: устала, ноги сбиты -->",
    "<!-- NRN COUNSEL | advice: отвар из дягиля и покой до утра -->",
    "",
    /* Без этой строки пример читается как полный список: раз в образце нет
       SKIP, значит его не бывает вовсе. */
    "Nothing skipped ahead in that scene, so there is no SKIP marker — that is the ordinary turn, not an omission.",
    "",
];

/**
 * Требования трекера — одним куском.
 *
 * Собирается на каждый запрос, хотя от состояния больше не зависит: так
 * buildPrompt() остаётся единственной точкой сборки, и порядок частей виден
 * в одном месте.
 */
function promptHead() {
    return [
        ...BLOCK_HEADER,
        ...BLOCK_TIME,
        ...BLOCK_PLACE,
        ...BLOCK_DRESS,
        ...BLOCK_MIND,
        ...BLOCK_FLESH,
        ...BLOCK_ADVICE,
        ...BLOCK_SKIP,
        ...BLOCK_EXAMPLE,
        ...BLOCK_CLOSE,
    ].join("\n");
}

/*
 * Чем кончается канал — следствия, а не команды.
 *
 * Здесь стоял чек-лист с галочками, а перед ним два отдельных правила,
 * WHILE REASONING и PRIORITY. Оба говорили о том, что объявлено четырьмя
 * сотнями строк выше, и уехали к своим объявлениям в BLOCK_HEADER. Список
 * требований сменил режим: модель узнаёт не что от неё требуется, а что
 * случится с панелью, — и достраивает требование сама.
 *
 * Каждая строка — утверждение о движке, и сверена с кодом:
 *   пустая строка  — refresh() кладёт EMPTY_STATE под снимок, так что
 *                    пропущенное поле гаснет, а не держится от прошлого хода;
 *   ответ без маркеров — readChat() ищет назад первый снимок, и вся панель
 *                    остаётся от прошлой сцены;
 *   дважды       — collectNrnFields(): fields[name] перезаписывается, побеждает
 *                    последнее значение каждого поля, раннее пропадает;
 *   длинное поле — обрезки в панели нет вовсе;
 *   эйкта назад  — resolveDates(): eykt < lastEykt читается как перевал через
 *                    полночь и двигает день вперёд.
 */
const BLOCK_CLOSE = [
    "[WHAT THE PANEL DOES WITH SILENCE]",
    "A topic headed «every reply» that does not come leaves its line blank: the reader is shown a scene with no weather over it and no counsel under it, and nothing says why. An answer that ends without any markers at all fares worse — the whole board keeps the last scene's word over this one until the next answer comes.",
    "Written twice, a topic does not add up: each field keeps the last value given for it, and the earlier one goes without a word.",
    "A field written past its budget is not trimmed. It is shown whole, and crowds out the line it shares.",
    "An eykt earlier than the one the last scene stood in is read as midnight passed — a new day, not a correction.",
    "The markers close the answer: they come after the story, each on a line of its own, with nothing following them.",
    "</norse_calendar>",
];

/**
 * Чем кончилась прошлая сцена — отдельным блоком, рядом с временем и телом.
 *
 * Старые маркеры вырезаны из истории, поэтому «посмотри на предыдущий блок»
 * больше не работает: точка отсчёта приходит отсюда.
 *
 * Стоял этот блок внутри <norse_calendar>, последним перед ответом, сразу за
 * заполненным примером маркера — и написан теми же «ключ: значение». То есть
 * последним, что модель читала, были два набора заполненных полей подряд.
 * Ровно эту ошибку тут уже разбирали для даты (см. timeContext ниже): всё, что
 * лежит внутри директивы трекера, читается как поле для заполнения, а не как
 * факт сцены. Теперь это <norse_scene> — справка, как <norse_time>, и стоит
 * она среди справок, а не в требованиях.
 *
 * Имена полей нарочно человеческие, а не машинные: копировать отсюда в блок
 * нечего, потому что копировать нечего дословно.
 */
function sceneContext() {
    const s = readState().state;
    if (!s) {
        return [
            "<norse_scene>",
            "The story has not started yet — there is nothing to carry over. Set every line of the block from the scene you are about to write.",
            "</norse_scene>",
            "",
        ].join("\n");
    }

    const carried = [];
    if (hasTime(s)) carried.push(`время — ${EYKTIR[eyktForHour(s.hour)].ru.toLowerCase()}`);
    for (const [label, value] of [
        ["погода", s.weather], ["место", s.location], ["настроение {{char}}", s.charMood],
        ["одежда {{user}}", s.userAttire], ["одежда {{char}}", s.charAttire],
    ]) {
        if (value) carried.push(`${label} — ${value}`);
    }
    if (!carried.length) {
        return [
            "<norse_scene>",
            "The last scene left nothing to carry over. Set every line of the block from the scene you are about to write.",
            "</norse_scene>",
            "",
        ].join("\n");
    }

    const out = [
        "<norse_scene>",
        "How the last scene stood when it ended:",
        carried.join("; ") + ".",
    ];
    if (settings().calendarHints) out.push(reckoningLine(s));
    out.push(
        "Carry these over unless your scene changes them. Time moves forward or stays the same, never backward.",
        "</norse_scene>",
        "",
    );
    return out.join("\n");
}

/**
 * Устройство времени в этом мире и сегодняшний день — отдельным блоком.
 *
 * Раньше дата ехала внутри <norse_calendar>, и это была ошибка. Всё, что
 * лежит внутри директивы трекера, модель считает требованием и добросовестно
 * отчитывается: «дата такая-то, записал». Ей же не нужно её записывать — ей
 * нужно её ЗНАТЬ, как персонаж знает, какой нынче месяц.
 *
 * Поэтому здесь другой тег, другой тон и ни одного поля. Это справка о мире,
 * рядом с которой стоит сегодняшнее число. Заодно тут объясняются эйкты и
 * месяцы: незнакомое слово «сольмануд» без пояснения думалка разбирает вслух,
 * а с пояснением просто читает.
 */
function timeContext() {
    const out = [
        "<norse_time>",
        "This story keeps time the Norse way, and so do the people in it.",
        "",
        "The year runs twelve months of thirty days, winter first: гормануд, юлир, морсуг, торри, гои, эйнмануд, then харпа, скерпла, сольмануд, хейаннир, твимануд, хаустмануд. Four аукнэтр stand at midsummer, between сольмануд and хейаннир. The half-years are Vetr and Sumar; a week is a vika.",
    /* Год перещёлкивает посреди осени, а не в январе, — и это единственное
       место, где модель ошибалась молча: хейаннир 1015 у неё переходил
       в гормануд 1015. Строка стоит десяток токенов и снимает весь класс. */
        "The year turns with the winter: the first day of гормануд opens a new one. So хейаннир 1015 is followed, three months on, by гормануд 1016 — not 1015. These people count years in winters, not from midwinter as we do.",
        "The day runs eight eyktir of three hours: миднэтти, отта, моргун, дагмал, хадеги, ундорн, мидафтан, наттмал. Хадеги is noon and the sun stands due south; наттмал is the late evening.",
    ];

    const d = sceneDate();
    if (d) {
        const name = isAuk(d.month) ? "аукнэтр" : MONTHS[d.month - 1].ru.toLowerCase();
        const weekday = WEEKDAYS[weekdayOf(d.year, d.month, d.day)].ru.toLowerCase();
        const { phase } = moonPhase(d.year, d.month, d.day);
        out.push(
            "",
            `Today is ${d.day} ${name} ${d.year} — ${weekday}, ${seasonOf(d.month).ru.toLowerCase()}, ${phase.ru.toLowerCase()}. Written in numbers, ${numericDate(d)}.`,
            "The panel keeps this count and moves it along with the scene. Take the day as given and let the characters speak of it as people of their time would.",
            "When the story skips ahead, say how much time went by in the SKIP marker and the panel will move the date; working the new date out yourself is not needed.",
        );

        /*
         * Праздник — не украшение даты, а обстоятельство сцены.
         *
         * Без этой строки модель знала день, луну и погоду, но не знала, что
         * на дворе третьи сутки Йоля, — и писала будний вечер у очага в тот
         * день, когда усадьба должна стоять на ушах. Считает праздник панель,
         * как и всё прочее: у модели его не спрашиваем.
         *
         * Одно имя и день праздника, без пояснения и без советов, как его
         * играть: что это за праздник, модель знает и так, а пояснение
         * стоило абзаца на каждый ход. Соседние праздники тех же суток
         * остаются панели — в промпт идёт главный.
         */
        const feast = holidaySummary();
        if (feast) {
            const which = feast.days > 1
                ? ` This is day ${feast.day} of ${feast.days}${feast.first ? ", the first" : feast.last ? ", the last" : ""}.`
                : "";
            out.push("", `A feast stands on this day: ${feast.norse} — ${feast.ru}.${which}`);
        }
    } else {
        out.push(
            "",
            "The day of the story is set by {{user}} in the Tímatal panel, and is not set yet. Let the scene stay vague about the date.",
        );
    }

    out.push("</norse_time>", "");
    return out.join("\n");
}

/** Дата, действующая сейчас, — из чата или из метаданных. */
function sceneDate() {
    const d = readState().date;
    return d && d.year != null ? d : null;
}

/** Какие слои праздников и какой край света выбраны в настройках. */
function holidayOpts() {
    return {
        tiers: settings().holidayTiers ?? DEFAULT_TIERS,
        region: settings().holidayRegion ?? "all",
    };
}

/**
 * Праздник этого дня — одной точкой сборки на панель и на промпт.
 *
 * Считается заново на каждый спрос: перебор двух десятков строк таблицы
 * дешевле любого кэша, а кэш пришлось бы сбрасывать и на смене даты, и на
 * смене настроек.
 */
function holidaySummary() {
    if (!settings().holidays) return null;
    const d = sceneDate();
    if (!d) return null;
    /* Аукнэтр не пропускаем: Alþingi начинается в сольмануде и перешагивает
       через них целиком, а панель в эти четверо суток молчала бы. */
    const view = holidayView(d.year, d.month, d.day, holidayOpts());
    return view?.none ? null : view;
}

/**
 * Ручная запись о теле — в метаданных чата, рядом с датой начала.
 *
 * На сообщении она не держится: свайп подставляет копию extra из swipe_info,
 * перегенерация заводит свою, удаление уносит целиком. Дата начала лежит
 * в метаданных с самого начала и работает исправно — ручное состояние тела
 * такой же авторский акт, ему туда же.
 */
const META_BODY = "nornirManualBody";

function manualBody() {
    return getContext()?.chatMetadata?.[META_BODY] ?? null;
}

function setManualBody(record) {
    const context = getContext();
    if (typeof context?.updateChatMetadata !== "function") return false;
    context.updateChatMetadata({ [META_BODY]: record });
    context.saveMetadataDebounced?.();
    forgetChat();
    return true;
}

/** Всё, от чего зависит чтение чата: и вырезание маркеров, и счёт тела. */
function readOptions() {
    return {
        keepMarker: settings().debugKeepMarkers,
        manualBody: manualBody(),
    };
}

/*
 * Кэш на один такт.
 *
 * Чтение чата — единственная дорогая операция в расширении: проход по всей
 * истории с разбором маркеров. Раньше за одну перерисовку панели он случался
 * до десяти раз, потому что дату, тело и снимок брали разными функциями, и
 * каждая шла по чату сама. Хуже цены было то, что шли они с РАЗНЫМИ
 * настройками и писали в msg.extra разное — чат считался изменённым и
 * сохранялся на каждой перерисовке.
 *
 * Теперь чтение одно на такт. Такт открывают refresh() и injectPrompt();
 * всё, что внутри, берёт готовое. Сбрасывать кэш надо после любой записи
 * в чат или метаданные — для этого forgetChat().
 */
let chatRead = null;

function forgetChat() {
    chatRead = null;
}

/** Прочитанный чат: снимок сцены, дата, тело, сказанное однажды. */
function readState() {
    if (!chatRead) {
        chatRead = readChat(getContext()?.chat, chatStartDate(), readOptions());
    }
    return chatRead;
}

/**
 * Сводка по телу на текущий день, либо null.
 *
 * Считается один раз на такт и кладётся рядом с прочитанным чатом: её просят
 * и промпт, и отрисовка, и Tímatal.
 */
function bodySummary() {
    if (!settings().bodyTracking) return null;
    const read = readState();
    if (read.view !== undefined) return read.view;

    const date = sceneDate();
    read.view = date && read.body ? bodyView(read.body, date) : null;
    return read.view;
}

/** Строка про тело для промпта — обычными словами, без цифр и латиницы. */
function bodyPhrase() {
    return bodySummary()?.phrase ?? null;
}

/**
 * Что Tímatal показывает и умеет про тело.
 *
 * Возвращаем null только когда отслеживание выключено настройкой: тогда блока
 * в справочнике нет, потому что нет и самого счёта.
 *
 * А вот без даты сцены блок остаётся. Считать без неё действительно не от
 * чего, поэтому наружу едет `today: null`, а справочник по нему гасит кнопки
 * и говорит, чего не хватает.
 */
function cycleControls(repaint = () => {}) {
    if (!settings().bodyTracking) return null;
    const today = sceneDate();
    const body = readState().body;

    /* Записали — сразу перерисовали панель и пересобрали инжект. Без второго
       модель до следующего хода жила бы со старой строкой о теле. */
    const done = (record) => {
        if (!record || !setManualBody(record)) return false;
        refresh();
        injectPrompt();
        repaint();
        return true;
    };

    const carried = body?.pregnancy
        ? pregnancyTerm(body.pregnancy.conceived, today)
        : null;

    return {
        view: bodySummary(),
        length: CYCLE_DEFAULT,
        pregnant: !!body?.pregnancy,
        /* Поля формы заполняем текущим положением дел: открыла Tímatal —
           видишь то же, что в панели, и правишь от него, а не с нуля. */
        today,
        part: carried ? Math.min(carried.part, 9) : null,
        conceived: body?.pregnancy?.conceived ?? null,
        onSetDay: (day) => done(cycleAnchor(today, day)),
        onSetPregnancy: (setup) => done(pregnancyAnchor(today, setup)),
    };
}

/**
 * Та же дата в DD.MM.YYYY — не для нас, а для соседей по промпту.
 *
 * Наш маркер принимает древнеисландскую дату, но рядом живут трекеры, которым нужен
 * числовой формат. Модель, зная только «5 сольмануд 1015», переводит его
 * сама — и делает это вслух, посреди рассуждений: «сольмануд седьмой месяц,
 * значит 05.07». В прогонах пользователя один и тот же день превращался то
 * в 05.07.1015, то в 05.06.1015, то в 05.09.1015 — три разных ответа на один
 * вопрос, и каждый со своим абзацем размышлений.
 *
 * Номер известен нам из MONTHS, так что арифметику делаем здесь.
 * Аукнэтр в григорианский месяц не ложится вовсе — отдаём номер сольмануда,
 * после которого эти дни и стоят.
 */
function numericDate(s) {
    const month = isAuk(s.month) ? MONTHS[AUK_AFTER_MONTH - 1] : MONTHS[s.month - 1];
    const dd = String(s.day).padStart(2, "0");
    const mm = String(month.modernNum).padStart(2, "0");
    return `${dd}.${mm}.${s.year}`;
}

/**
 * Необязательная строка с тем, что панель посчитала сама.
 *
 * Ради неё персонаж может сказать «на девятой неделе зимы» или «при растущей
 * луне», не выдумывая цифру. Модель эти значения не присылает — иначе на один
 * факт стало бы два источника правды, и разошлись бы они на первой арифметике.
 *
 * Выключено по умолчанию, и это не осторожность ради осторожности. Первая
 * версия строки писалась скандинавской латиницей («mánadagr, vika 9/52, vetr,
 * tungl vaxandi») и с оговоркой «never part of the marker». Непрозрачные токены
 * думающая модель молча не принимает — она разбирает вслух, что такое vika,
 * а названный запретный токен выписывает именно там, где его запретили.
 * Поэтому здесь обычные русские слова, без жаргона и без единого запрета.
 */
/** «зимы» / «лета» — полугодие в родительном, для счёта недель. */
function seasonGenitive(month) {
    return seasonOf(month).norse === "Vetr" ? "зимы" : "лета";
}

function reckoningLine(s) {
    const bits = [];
    if (hasDate(s)) {
        const { year, month, day } = s;
        bits.push(WEEKDAYS[weekdayOf(year, month, day)].ru.toLowerCase());
        /* «9-я неделя зимы», а не «неделя 9 из 52»: вики считали внутри
           полугодия, и персонаж скажет именно так. Полугодие тут же и названо,
           поэтому отдельной строкой про зиму или лето больше не нужно. */
        bits.push(`${vikaOf(year, month, day)}-я неделя ${seasonGenitive(month)}`);
        /* ru уже самодостаточно: «Растущая луна», «Новолуние» — без приставок. */
        bits.push(moonPhase(year, month, day).phase.ru.toLowerCase());
    }
    return `Панель считает по календарю: ${bits.join(", ")}.`;
}

/**
 * Полный текст инструкции.
 *
 * Порядок не случайный: сперва три справки о мире — время, тело, чем кончилась
 * прошлая сцена, — и только потом требования трекера. Раньше справка о сцене
 * стояла последней, внутри тега трекера и сразу после примера маркера; теперь
 * последним перед ответом идёт проза BLOCK_CLOSE, а не второй набор
 * заполненных полей.
 */
function buildPrompt() {
    return timeContext() + bodyContext() + sceneContext() + promptHead();
}

/**
 * Что с телом героини — отдельным блоком, рядом с устройством времени.
 *
 * Раньше эта строка стояла последней в общем блоке состояния, между погодой
 * и одеждой. Формально модель её получала — и всё-таки пролистывала: у
 * пользователя первый ответ на восьмой луне не заметил живота вовсе, а
 * соседние свайпы кричали о нём в голос.
 *
 * Причина та же, из-за которой отсюда уехала дата: в блоке трекера всё
 * читается как поля для заполнения, а не как факты сцены. Восьмая луна — это
 * не поле, это то, что видит каждый встречный.
 *
 * Строка здесь одна, и то не всегда: идёт кровь или героиня носит. Приметы,
 * фазы и пояснения остались панели — модели они мешали больше, чем помогали.
 * Упомянуть кровь или живот к слову сцена может сама; требовать этого блок
 * не станет.
 */
function bodyContext() {
    const phrase = bodyPhrase();
    if (!phrase) return "";
    return [
        "<norse_body>",
        "This is what {{user}}'s body is doing. It is not a form to fill in and nothing here is asked of you — it is what she carries into the scene, the way anyone knows their own body on waking.",
        phrase,
        "</norse_body>",
        "",
    ].join("\n");
}

/**
 * Инжектит инструкцию в промпт — в один слот.
 *
 * Слот: IN_CHAT на нулевой глубине с ролью SYSTEM.
 *
 * Роль была USER: служебная вставка с ролью system посреди переписки для модели
 * выглядит фоном и легко теряется под RP-пресетами, а то же самое, пришедшее
 * последней репликой пользователя, воспринимается как обращение. Расплата
 * обнаружилась в логах: наш блок вставал в чат ВТОРОЙ репликой пользователя
 * подряд, после его настоящего сообщения. Модель принималась разбирать, кто
 * что сказал, — «did the user split it into two messages?», — и на это уходил
 * целый абзац рассуждений. Дальше по инерции она пересказывала вслух и всё
 * остальное, вплоть до черновика прозы.
 *
 * Роль system такой развилки не создаёт: это заметка на полях, а не второй
 * голос пользователя. Если маркер начнёт теряться — это первое место, куда
 * смотреть, и откат сюда ровно в одно слово.
 *
 * Второго слота больше нет, и это первая из правок большой перестройки.
 *
 * Был он IN_PROMPT и получал ТОТ ЖЕ текст, что и основной: модель читала всю
 * инструкцию дважды за ход — сперва через prompt-manager, потом в конце чата.
 * В просмотрщике таверны это и видно двумя одинаковыми кусками подряд.
 *
 * Убрано по двум причинам. Первая — цена: инструкция весит около трёх тысяч
 * токенов, и половина уходила ни на что. Вторая важнее: повторённое требование
 * выписать блок — это ровно то, из-за чего блок приезжает дважды, а с этим
 * здесь борются в трёх местах сразу.
 *
 * Один раз слот уже удаляли и вернули — тогда справедливо: правка шла в куче
 * с полутора десятками других, и доказать, что дело не в ней, было нечем.
 * Теперь она идёт одна и первой.
 *
 * Если блок начнёт теряться — сюда смотреть вторым делом, после роли SYSTEM.
 *
 * `sysKey` в вызовах остался нарочно, с пустой строкой: слот таверны живёт
 * дольше расширения, и без этой записи в нём висел бы текст, положенный туда
 * прошлой версией, — до перезагрузки страницы. Пустая строка его гасит.
 */
function injectPrompt() {
    const context = getContext();
    if (!context || typeof context.setExtensionPrompt !== "function") return;

    /* Инжект собирается перед генерацией, то есть после того, как чат уже
       мог измениться. Открываем свой такт чтения, а не берём чужой. */
    forgetChat();

    const chatKey = extensionName;
    const sysKey = `${extensionName}_sys`;

    /* Слот один на всю таверну и переживает смену чата. Значит упасть на
       сборке нельзя: без записи в нём останется инфоблок ПРОШЛОЙ ролевой,
       и модель получит чужую сцену как свою. Поэтому отказ — это пустая
       строка, а не пропущенный вызов: отсутствие инфоблока модель переживёт,
       чужой инфоблок — нет. */
    let value = "";
    try {
        value = settings()?.inject ? buildPrompt() : "";
    } catch (e) {
        panelFailed("injectPrompt()", e);
    }

    context.setExtensionPrompt(chatKey, value, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    /* Гасим слот прошлых версий: см. оговорку про sysKey выше. */
    context.setExtensionPrompt(sysKey, "", extension_prompt_types.IN_PROMPT, 0);
}

/* ============================================================
 * 3. STATE & LOOKUP
 *
 * `state` — НЕ источник правды, а только кэш последнего отрисованного
 * снимка. Правда лежит в сообщениях (chat-state.js), и refresh() каждый раз
 * перечитывает её заново. Поэтому свайп, удаление сообщения и откат назад
 * работают сами собой: показывается то, что реально есть в чате сейчас.
 * ============================================================ */

/*
 * Пустой снимок — эталон сброса, и в нём обязано быть КАЖДОЕ поле, которое
 * панель когда-либо читает. Раньше здесь стояли только дата, время и пять
 * полей сцены; совет, состояния тел и всё, сказанное про дитя, в списке
 * отсутствовали — и после перехода на чат без маркеров оставались на экране
 * от прошлой истории.
 */
const EMPTY_STATE = {
    year: null, month: null, day: null, hour: null, minute: null,
    weather: null, location: null, userAttire: null,
    charMood: null, charAttire: null, thought: null,
    charState: null, userState: null, advice: null,
};

/** Кэш отрисовки: копия снимка, который сейчас на экране. */
const state = { ...EMPTY_STATE };

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
/**
 * Дата, с которой начинается чат.
 *
 * Живёт в метаданных чата, а не на сообщении: её выставляют в Tímatal ДО
 * первого хода, когда цепляться ещё не за что. Метаданные ST переоткрывает
 * вместе с чатом, так что у каждой истории она своя.
 *
 * Ручные поправки посреди игры — по-прежнему якоря на сообщениях: те откат
 * переживать не должны, а начало чата должно.
 */
const META_START = "nornirStartDate";

function chatStartDate() {
    const d = getContext()?.chatMetadata?.[META_START];
    return d && d.year != null ? d : null;
}

function setChatStartDate(date) {
    const context = getContext();
    if (typeof context?.updateChatMetadata !== "function") return false;
    context.updateChatMetadata({ [META_START]: { year: date.year, month: date.month, day: date.day } });
    context.saveMetadataDebounced?.();
    forgetChat();
    return true;
}

/* ── Отказ читается вслух ───────────────────────────────────────────────
 *
 * Всё, что панель рисует и шлёт модели, стоит на одном чтении чата. Стоит
 * readChat() бросить исключение — а бросить его может одна битая запись
 * в extra, — и раньше замолкало сразу всё, беззвучно, в промис.
 *
 * Тише всего было именно там, где громче всего надо: refresh() падал ДО
 * Object.assign(state, EMPTY_STATE), поэтому в панели оставалась прошлая
 * отрисовка — в новом чате буквально данные предыдущего, — а injectPrompt()
 * не доходил до setExtensionPrompt, и модель час получала чужой инфоблок.
 * Со стороны это выглядит как «расширение подвисло», и искать причину идут
 * куда угодно, только не в консоль.
 *
 * Отсюда два правила. Первое: отказ называет себя — в консоль с меткой
 * расширения, в панель словами, один раз всплывашкой (и снова, если сломается
 * заново после починки). Второе: показываем и шлём ПУСТО, а не прошлое.
 *
 * Ловить исключения здесь — не способ жить с багом: он всё равно лежит
 * в консоли и всё равно требует правки. Это способ не потерять его молча.
 */
let panelBroken = false;

function panelFailed(where, e) {
    console.error(`[${extensionName}] ${where}: чтение чата не удалось`, e);
    if (panelBroken) return;
    panelBroken = true;
    /* Эта функция — последняя в цепочке, и падать ей нельзя ни при каких
       условиях: её зовут ИЗ catch, и брошенное отсюда исключение вернуло бы
       ровно ту немоту, ради которой всё и затевалось. */
    try {
        toastr?.error?.(t`NORNIR could not read this chat. The infoblock is off until it is fixed — details in the browser console (F12).`);
    } catch { /* всплывашки нет — хватит и консоли */ }
}

/** Пустая панель со словами об отказе — вместо сцены из прошлого чата. */
function showFailure() {
    try {
        Object.assign(state, EMPTY_STATE);
        mountWidget();
        renderAll();
        el("#nrn-stub").text(`ᚱ ${t`the infoblock is broken`}`).show();
    } catch (e) {
        console.error(`[${extensionName}] и показать отказ не удалось:`, e);
    }
}

function refresh() {
    try {
        readAndRender();
        panelBroken = false;
    } catch (e) {
        panelFailed("refresh()", e);
        showFailure();
    }
}

function readAndRender() {
    forgetChat();
    const context = getContext();
    const read = readState();

    Object.assign(state, EMPTY_STATE, read.state ?? {});

    /* Дату показываем и до первого маркера: пользователь выставил её в Tímatal
       и вправе сразу видеть, что она принялась. */
    if (state.year == null && read.date) Object.assign(state, read.date);

    // Маркеры вырезаны из текста — изменение надо сохранить в файл чата.
    if (read.changed && typeof context?.saveChat === "function") {
        try { context.saveChat(); } catch (e) {
            console.error(`[${extensionName}] не удалось сохранить чат:`, e);
        }
    }

    mountWidget();
    renderAll();
    stripMarkersFromDom();
    notifyTick();
}

/* ── Уведомления ────────────────────────────────────────────────────────
 *
 * Своих всплывашек расширение не рисует: их показывает таверна (toastr).
 * Здесь только слепок наблюдаемого и его сравнение с прошлым тактом —
 * счёт живёт в notify.js и ничего не знает ни про DOM, ни про ST.
 *
 * Слепок держится в памяти вкладки и НЕ сохраняется. Это нарочно: после
 * перезагрузки страницы сравнивать не с чем, и первый такт молчит — иначе
 * каждый вход в чат встречал бы читателя пачкой уведомлений о том, что и
 * так нарисовано в панели. По той же причине слепок забывается при смене
 * чата: там своя дата и своё тело.
 */
let lastWatch = null;

function forgetWatch() {
    lastWatch = null;
}

/**
 * Пришёл ли последний ответ без маркера.
 *
 * Ищем последнее НЕ пользовательское сообщение и смотрим, оно ли дало панели
 * снимок. Если снимок взят раньше — значит модель маркер не поставила, и
 * панель показывает прошлый ход. Молчим, когда инжект выключен: там маркера
 * никто и не ждёт.
 */
function markerStale() {
    if (!settings().inject) return false;
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return false;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== "string" || msg.is_user) continue;
        return readState().index !== i;
    }
    return false;
}

function notifyTick() {
    if (!settings().notify) {
        /* Выключили посреди игры — забываем прошлое. Иначе после обратного
           включения прилетело бы всё, что накопилось за время молчания. */
        forgetWatch();
        return;
    }

    const snap = watchSnapshot({
        scene: state,
        view: bodySummary(),
        holidays: !!settings().holidays,
        holidayOpts: holidayOpts(),
        stale: markerStale(),
    });

    const kinds = settings().notifyKinds ?? DEFAULT_NOTICES;
    const notices = noticesBetween(lastWatch, snap, kinds);
    lastWatch = snap;

    for (const note of notices) showNotice(note);
}

/** Отдаёт уведомление таверне. Своей системы у нас нет и не заводим. */
function showNotice(note) {
    const say = toastr?.[note.level] ?? toastr?.info;
    if (typeof say !== "function") return;
    const title = [note.icon, note.title].filter(Boolean).join(" ");
    try {
        say(note.text, title, { timeOut: 7000, extendedTimeOut: 2000, escapeHtml: true });
    } catch (e) {
        console.error(`[${extensionName}] не удалось показать уведомление:`, e);
    }
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
            /*
             * Ищем начало маркера, а не просто слово «urd».
             *
             * Прежняя проверка срабатывала на любое вхождение в любом регистре —
             * в том числе на слово посреди прозы. А дальше шло переприсвоение
             * innerHTML, которое сносит обработчики и узлы соседних расширений
             * внутри сообщения. Теперь нужен именно открывающий комментарий,
             * хоть сырой, хоть экранированный таверной.
             */
            if (!MARKER_IN_DOM_RE.test(html)) continue;
            const clean = stripUrd(html.replace(/&lt;!--/g, "<!--").replace(/--&gt;/g, "-->"));
            if (clean !== html) el.innerHTML = clean;
        }
    } catch (e) {
        console.error(`[${extensionName}] не удалось подчистить маркер в сообщении:`, e);
    }
}

/* Начало маркера в уже отрисованном HTML: сырое и экранированное Encode Tags.
   Регистр не важен, «urd» само по себе — важно. */
const MARKER_IN_DOM_RE = /(?:<|&lt;)!--\s*\[URD:/i;

/* ============================================================
 * 4. RENDER
 * ============================================================ */

/** Ссылка на корневой элемент виджета; он может быть не в DOM. */
let $widget = null;

/** Поиск внутри виджета — работает и когда виджет ещё не вставлен в чат. */
function el(selector) {
    return $widget ? $widget.find(selector) : $();
}

/** Меняет текст слова на адаптацию на 5 секунд, затем возвращает. */
function swapHint($el) {
    $el.text($el.data("alt")).addClass("nrn-hint");
    const key = $el.data("key");
    clearTimeout(hintTimers[key]);
    hintTimers[key] = setTimeout(() => {
        $el.text($el.data("base")).removeClass("nrn-hint");
    }, 5000);
}

function clearHints() {
    for (const key of Object.keys(hintTimers)) {
        clearTimeout(hintTimers[key]);
        delete hintTimers[key];
    }
    el(".nrn-hint").removeClass("nrn-hint");
}

function hintSpan(key, base, alt) {
    return $("<span>", {
        "class": "nrn-hintable",
        "data-key": key,
        "data-base": base,
        "data-alt": alt,
        text: base,
    });
}

function plainSpan(text) {
    return $("<span>", { text: text });
}

/**
 * Знак поля — квадратный SVG из папки `icons/`, подложенный маской.
 *
 * Пустой элемент нарочно: файл подставляет CSS по `data-icon`, а цвет знак
 * берёт из строки, в которой стоит. Отсюда два даровых свойства — он сам
 * попадает в тему и сам краснеет вместе с `.nrn-alarm`, — и ни одного пути
 * к файлу в коде: из JS папку расширения видно только через
 * `renderExtensionTemplateAsync`, а CSS считает `url()` от себя, как уже
 * делает `@font-face`.
 *
 * Имени нет в CSS — покажется `_fallback.svg`, и вёрстка этого не заметит.
 * Поэтому иконки можно доносить в папку по одной, а не все разом.
 */
function icon(name, extraClass) {
    return $("<span>", {
        "class": extraClass ? `nrn-icon ${extraClass}` : "nrn-icon",
        "data-icon": name,
        "aria-hidden": "true",
    });
}

/**
 * Строка факта: знак, подпись и значение.
 *
 * Заведена ради дозора и примет. Раньше это были два текстовых узла, куда
 * через « · » сваливалось до одиннадцати разнородных фактов — повитуха,
 * обереги, отцовство и шевеления дитяти в одной серой строке. Читать такое
 * с одного взгляда, ради чего панель и висит, было нельзя.
 */
function factRow(iconName, label, value, hint) {
    const row = $("<div>", { "class": "nrn-fact" }).append(icon(iconName));
    /* Без двоеточия: подпись стоит своим столбцом, и двоеточие в нём —
       знак препинания посреди пустого места. Те подписи, что панель
       дописывает стилями («тело», «одежда», приметы), его и не носили. */
    if (label) row.append($("<span>", { "class": "nrn-fact-label", text: label }));
    row.append(hint
        ? hintSpan(`fact-${label ?? iconName}`, value, hint).addClass("nrn-fact-value")
        : $("<span>", { "class": "nrn-fact-value", text: value }));
    return row;
}

/**
 * Праздник — строкой над календариком.
 *
 * Стоит именно там, где на него смотрят: прямо над неделей, в которой он
 * и покрашен. Многодневный называет свой день вслух («день 2 из 3»), а
 * прочие праздники тех же суток уходят в облачко: в зимние ночи их разом
 * трое, и вываливать все три в строку значило бы утопить главный.
 */
/**
 * Толкование праздника для блока — только имя по-русски.
 *
 * Раньше сюда сваливались толкование, источник и слой достоверности разом,
 * и «Vetrnætr» подменялось абзацем в пять строк. Блок висит в чате и живёт
 * с одного взгляда; развёрнутое место у праздника одно — Tímatal, там ему
 * и полагается быть. Если русского имени нет, берём первую фразу толкования
 * и обрезаем: короткая подсказка лучше никакой.
 */
const FEAST_HINT_MAX = 46;

function feastHint(holiday) {
    if (holiday.ru) return holiday.ru;
    const first = String(holiday.gloss ?? "").split(/(?<=[.!?])\s/)[0].trim();
    if (!first) return holiday.norse;
    return first.length > FEAST_HINT_MAX
        ? `${first.slice(0, FEAST_HINT_MAX).trimEnd()}…`
        : first;
}

function renderFeast() {
    const row = el("#nrn-feast").empty();
    const feast = holidaySummary();
    if (!feast) { row.hide(); return; }

    row.attr("data-tier", feast.tier).append(
        icon("cal-feast"),
        hintSpan("feast", feast.norse, feastHint(feast)),
    );
    if (feast.count) row.append(plainSpan(` · ${feast.count}`));
    if (feast.others.length) {
        /* Прочие праздники этих же суток — тоже только именами: в зимние
           ночи их разом трое, и три толкования подряд утопили бы главный. */
        row.append(hintSpan("feast-more", ` +${feast.others.length}`,
            feast.others.map((o) => o.ru || o.norse).join(", ")));
    }
    row.show();
}

/** Сетка календаря (дни 1–30), только когда есть дата из чата. */
function buildGrid() {
    const grid = el("#nrn-grid");
    grid.empty();
    grid.toggleClass("nrn-hidden", !hasDate(state));
    if (!hasDate(state)) return;

    const { year, month, day } = state;

    if (isAuk(month)) {
        const total = aukDays(year);
        grid.append(
            $("<div>", { "class": "nrn-auk-title" }).append(
                icon("cal-auknaetr"),
                plainSpan(t`Sumarauki · Auknætr`),
            ),
        );
        const row = $("<div>", { "class": "nrn-row" });
        for (let d = 1; d <= total; d++) {
            const cls = d === day ? "nrn-cell nrn-day nrn-aukday nrn-today" : "nrn-cell nrn-day nrn-aukday";
            row.append($("<div>", { "class": cls, text: d }));
        }
        grid.append(row);
        return;
    }

    /*
     * Полоса идёт от первого дня вики, а вика — от первого дня полугодия.
     * Значит зимой она открывается Laugardagr, а летом Þórsdagr, и заголовок
     * колонок разворачивается вслед за ней. Иначе подпись «vika N» врала бы
     * про крайние клетки всё лето: летние вики считаются от четверга.
     */
    const first = vikaFirstDay(year, month, day);
    const days = Array.from({ length: 7 },
        (_, i) => addDays(first.year, first.month, first.day, i));

    const headRow = $("<div>", { "class": "nrn-row" });
    for (const d of days) {
        const wd = WEEKDAYS[weekdayOf(d.year, d.month, d.day)];
        const tip = `${wd.desc} — ${wd.ru}`;
        headRow.append($("<div>", { "class": "nrn-cell nrn-wd", text: wd.short, title: tip }));
    }
    grid.append(headRow);

    /* Последняя вика полугодия короче семи дней — зимой их пять, летом два.
       Хвост показываем приглушённым: он уже принадлежит другой половине года,
       и полоса не должна прыгать в ширине от недели к неделе. */
    const vika = vikaOf(year, month, day);
    const offsetToday = days.findIndex((d) => d.month === month && d.day === day);

    /* Праздничные дни красятся все подряд, а не только первый: трое суток
       зимних ночей — это трое суток, и по полосе это должно быть видно
       одним взглядом. Края помечаем отдельно, чтобы CSS скруглил ленту
       с началом и концом, а середину оставил сплошной. */
    const feasts = settings().holidays ? markWeek(days, holidayOpts()) : days.map(() => null);

    const weekRow = $("<div>", { "class": "nrn-row" });
    for (let i = 0; i < 7; i++) {
        const d = days[i];
        let cls = "nrn-cell nrn-day";
        /* Гасим и чужой месяц, и день, уехавший за край полугодия: вика там
           уже кончилась, хотя клетка в полосе ещё есть. */
        const sameVika = !isAuk(d.month) && !isAuk(month)
            && vikaOf(d.year, d.month, d.day) === vika
            && seasonOf(d.month).norse === seasonOf(month).norse;
        if (d.month !== month || !sameVika) cls += " nrn-dim";
        if (i === offsetToday) cls += " nrn-today";
        if (feasts[i]) {
            cls += " nrn-feast-day";
            if (feasts[i].first) cls += " nrn-feast-first";
            if (feasts[i].last) cls += " nrn-feast-last";
        }
        const cell = $("<div>", { "class": cls, text: d.day });
        if (feasts[i]) {
            cell.attr("data-tier", feasts[i].holiday.tier);
            cell.attr("title", `${feasts[i].holiday.norse} — ${feasts[i].holiday.ru}`);
        }
        weekRow.append(cell);
    }
    grid.append(weekRow);
}

/**
 * Полный рендер виджета.
 *
 * Дата, время и поля сцены рисуются независимо друг от друга: если модель
 * написала дату криво, погода, локация, настроение и мысль всё равно видны.
 *
 * Проверки «а изменилось ли что-нибудь» здесь нет намеренно. Она была, и была
 * бесполезной: оба вызывающих просили полную перерисовку, а ключ считался по
 * одиннадцати полям из двадцати с лишним — то есть даже пригодись он, совет и
 * состояние тела он бы проспал.
 */
function renderAll() {
    if (!settings().enabled || !$widget) return;

    clearHints();

    const showTime = hasTime(state);
    const showDate = hasDate(state);
    const showDetails = hasDetails(state);

    const stub = el("#nrn-stub");
    if (!showTime && !showDate && !showDetails) {
        // Чистим содержимое, а не только прячем: иначе прошлая сцена остаётся
        // в DOM и попадает в текст сообщения при копировании или озвучке.
        el("#nrn-eykt-name, #nrn-week, #nrn-date, #nrn-moon, #nrn-feast, #nrn-grid, #nrn-mood-chips").empty();
        el("#nrn-sun, #nrn-eykt-num, #nrn-weather-value, #nrn-location-value").text("");
        const arc = el("#nrn-weather-text").find("textPath")[0];
        if (arc) arc.textContent = "";
        el("#nrn-attire-user-text, #nrn-attire-char-text, #nrn-thought-text, #nrn-cycle-text, #nrn-cycle-status, #nrn-cycle-extra, #nrn-char-state-text, #nrn-user-state-text, #nrn-advice-text").text("");
        el("#nrn-beam, #nrn-wood, #nrn-book").hide();
        el("#nrn-grid").addClass("nrn-hidden");
        /* Текст ставим заново, а не только показываем: showFailure() пишет
           поверх него свой, и после починки надпись обязана вернуться. */
        stub.text(`ᚱ ${t`Waiting for the infoblock…`}`).show();
        return;
    }
    stub.hide();
    /* Балку и книгу показываем целиком: что в них пусто, решают сами
       надписи и страницы — каждая своим toggle. */
    el("#nrn-beam, #nrn-book").show();

    renderTimeAndDate(showTime, showDate);
    renderExtraFields();
    renderFeast();
    buildGrid();
}

/** Левый столбец: эйкта, положение солнца, дата, день недели и Луна. */
function renderTimeAndDate(showTime, showDate) {
    el("#nrn-wood").toggle(showTime || showDate);

    const timeLine = el("#nrn-time-line");
    const vegvisir = el("#nrn-vegvisir");
    const sunEl = el("#nrn-sun");
    if (showTime) {
        const idx = eyktForHour(state.hour);
        const e = EYKTIR[idx];
        const hh = String(state.hour).padStart(2, "0");
        const mm = String(state.minute ?? 0).padStart(2, "0");

        el("#nrn-eykt-name").empty().append(hintSpan("eykt", e.ru, `${hh}:${mm}`));
        el("#nrn-eykt-num").text(t`eykt ${idx + 1} of 8`);
        timeLine.show();

        /* Вегвизир знает свою эйкту одним числом: по нему CSS и зажигает
           нужный луч. Считать углы в JS незачем. */
        vegvisir.attr("data-eykt", idx).show();

        /* Восемь эйкт — восемь румбов, ровно по кругу: знак солнца рисуется
           один, стрелкой на север, а поворот докручивает CSS по `data-dir`.
           Восьми файлов на одну и ту же стрелку заводить незачем. */
        sunEl.empty().append(
            icon("time-sun").attr("data-dir", idx),
            plainSpan(e.dirText),
        ).show();
    } else {
        timeLine.hide();
        vegvisir.hide();
        sunEl.hide();
    }

    const weekEl = el("#nrn-week").empty();
    const dateEl = el("#nrn-date").empty();
    const moonEl = el("#nrn-moon").empty();
    if (!showDate) {
        weekEl.hide();
        dateEl.hide();
        moonEl.hide();
        return;
    }

    const { year, month, day } = state;
    const season = seasonOf(month);

    /* Строка 1 — где мы в неделе: «Frjádagr · vika 48».
       Точек-разделителей больше нет: факты разводит знак перед каждым,
       а не серая точка между ними. */
    const wd = WEEKDAYS[weekdayOf(year, month, day)];
    const vika = vikaOf(year, month, day);
    weekEl.append(
        icon("cal-weekday"),
        hintSpan("wd", wd.norse, wd.ru),
        icon("cal-vika"),
        /* Подсказка показывает день внутри полугодия, а не сквозной по году:
           вика теперь считается оттуда же, и два разных счёта рядом сбивали бы
           с толку. Полугодие названо строкой ниже, у даты. */
        hintSpan("vika", `vika ${vika}/${weeksInMisseri(year, month)}`,
            `${t`day`} ${dayOfMisseri(year, month, day)}/${misseriLength(year, month)}`),
    ).show();

    /* Строка 2 — сама дата: «7 Ýlir · í Vetr · 998».
       Полугодие переехало сюда из строки недели: год, месяц и сезон — это
       один вопрос «когда», а день недели с викой — другой. */
    if (isAuk(month)) {
        const total = aukDays(year);
        const label = isSumaraukiYear(year) ? "Sumarauki" : "Auknætr";
        dateEl.append(
            icon("cal-auknaetr"),
            hintSpan("date", `${label} ${day}/${total}`,
                t`Special mid-summer days before the haymaking`),
        );
    } else {
        dateEl.append(
            icon("cal-date"),
            plainSpan(`${day} `),
            hintSpan("date", MONTHS[month - 1].norse, MONTHS[month - 1].modern),
        );
    }
    dateEl.append(
        icon(season.norse === "Sumar" ? "season-sumar" : "season-vetr"),
        hintSpan("season", `í ${season.norse}`, season.ru),
        plainSpan(` ${year}`),
    );
    dateEl.show();

    /* Строка 3 — Луна */
    const { phase } = moonPhase(year, month, day);
    moonEl.append(
        icon(phase.iconName),
        hintSpan("moon", phase.norse, phase.ru),
        plainSpan(` ${phase.desc}`),
    ).show();

}

/**
 * Цикл — в колонке {{user}}, рядом с её одеждой.
 *
 * Слева живёт время сцены, и телу героини там не место. Колонка {{user}} до
 * сих пор держала одну строчку про одежду, тогда как у {{char}} их три.
 *
 * Видно то, что важно с одного взгляда: день и примета. Подсказки короткие и
 * практические — что происходит с телом, а не откуда взялось слово. Этимология
 * и оговорки про реконструкцию живут в Tímatal, там им и место.
 */
/** Строка с текстом: есть значение — показываем, нет — прячем целиком. */
function textRow(rowSelector, textSelector, value) {
    const row = el(rowSelector);
    if (value) {
        el(textSelector).text(value);
        row.show();
    } else {
        row.hide();
    }
}

/**
 * Совет — то, что сказала бы знающая женщина этого века.
 *
 * Пишет его модель: она одна видит, что героиня прямо сейчас рубит дрова.
 */
function renderAdvice() {
    textRow("#nrn-advice", "#nrn-advice-text", state.advice || null);
}

/**
 * Нить Фрейи — напоминалка: где героиня в счёте цикла или ношения.
 *
 * Две строки и ещё одна при ношении: фаза со счётом, слова о ней и когда
 * ждать. Обе первые кликабельны — по клику пояснение. Что показывать, решено
 * в bodyView(): здесь только раскладка, иначе панель и промпт разъедутся.
 */
function renderCycle() {
    const row = el("#nrn-cycle");
    const s = bodySummary();
    if (!s) { row.hide(); return; }

    el("#nrn-cycle-text").empty().append(
        icon(s.icon),
        hintSpan("cyclePhase", s.title, s.titleHint),
        ...(s.count ? [plainSpan(` · ${s.count}`)] : []),
    );
    el("#nrn-cycle-status").empty().append(hintSpan("cycleStatus", s.status, s.statusHint));

    const extra = el("#nrn-cycle-extra").empty();
    if (s.extra) extra.append(factRow(s.extraIcon, null, s.extra)).show(); else extra.hide();

    row.show();
}

/**
 * Погода и место — две надписи сцены.
 *
 * Раскладку здесь не спрашиваем: рендер кладёт слова по местам, а как эти
 * места стоят — дело стилей. Пустая строка прячется целиком, чтобы под
 * ней не оставалось её ярлыка.
 */
function renderScene() {
    el("#nrn-weather-value").text(state.weather || "");
    el("#nrn-weather-text").toggle(!!state.weather);

    el("#nrn-location-value").text(state.location || "");
    el("#nrn-location-text").toggle(!!state.location);
}

/**
 * Страницы книги: {{user}}, нить Фрейи, {{char}}.
 *
 * Рисуем все три всегда, а показываем одну — ту, чья фигурка выбрана.
 * Прятать по «есть ли что показать» тут нельзя: фигурка должна открывать
 * страницу и тогда, когда сцена о человеке смолчала, иначе нажатие выглядит
 * сломанным. Пустая страница говорит об этом словами.
 */
function renderExtraFields() {
    const context = getContext();
    const userName = context?.name1 || "{{user}}";
    const charName = context?.name2 || "{{char}}";

    renderScene();

    /*
     * Имена — на самих фигурках, подсказкой под курсором.
     *
     * Подписей под ними больше нет: фигурку узнают в лицо, а имя нужно
     * ровно в ту секунду, когда на неё наводят. Держим его и в aria-label,
     * иначе для чтения с экрана кнопка осталась бы безымянной.
     */
    figureLabel("#nrn-fig-user", userName);
    figureLabel("#nrn-fig-char", charName);

    /* --- страница {{user}} --- */
    textRow("#nrn-attire-user", "#nrn-attire-user-text", state.userAttire);
    textRow("#nrn-user-state", "#nrn-user-state-text", state.userState);
    leafEmpty("#nrn-user-empty", !!(state.userAttire || state.userState),
        "Сцена о ней ничего не сказала.");

    /* --- лист нити Фрейи --- */
    renderCycle();
    renderAdvice();
    const hasBody = !!bodySummary();
    const hasAdvice = !!state.advice;
    leafEmpty("#nrn-freyja-empty", hasBody || hasAdvice,
        settings().bodyTracking ? "Счёт тела ещё не начат." : "Счёт тела выключен в настройках.");

    /* --- страница {{char}} --- */
    const moods = state.charMood
        ? state.charMood.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const moodEl = el("#nrn-mood-chips").empty();
    for (const m of moods) {
        moodEl.append($("<span>", { "class": "nrn-chip", text: m }));
    }
    moodEl.toggle(moods.length > 0);

    textRow("#nrn-attire-char", "#nrn-attire-char-text", state.charAttire);
    textRow("#nrn-char-state", "#nrn-char-state-text", state.charState);
    textRow("#nrn-thought", "#nrn-thought-text", state.thought);
    leafEmpty("#nrn-char-empty",
        moods.length > 0 || !!state.charAttire || !!state.thought || !!state.charState,
        "Сцена о нём ничего не сказала.");

    applyTab();
}

/** Слово вместо пустого листа: кнопка нажалась, а показать нечего. */
function leafEmpty(selector, hasContent, words) {
    el(selector).text(hasContent ? "" : words).toggle(!hasContent);
}

/**
 * Имя створки — в подпись, в подсказку под курсором и в aria-label.
 *
 * Пишем во все три места разом: рендеру не положено знать, какая раскладка
 * выбрана и что из этого она показывает.
 */
function figureLabel(selector, name) {
    const fig = el(selector);
    fig.attr({ "aria-label": name, title: name });
    fig.find(".nrn-fig-name").text(name);
}

/* --- фигурки: какая страница открыта --- */

const TABS = ["user", "freyja", "char"];

/*
 * В раскладке «Дом и его нити» разделов свои три, и это не те же три.
 *
 * Нить Фрейи там не отдельная вкладка: она идёт внутри вкладки героини,
 * под её одеждой. И обе можно закрыть разом: пустая строка — законное
 * состояние, а не сбой.
 *
 * Третьей створкой здесь стояли дети; их сняли вместе со всей линией
 * дитяти, и выбор «kids», оставшийся в настройках, сводится к героине.
 */
const THREAD_TABS = ["user", "char", ""];

function tabsForSkin() {
    return currentSkin() === "thread" ? THREAD_TABS : TABS;
}

/**
 * Выбранный лист живёт в настройках, а не в переменной.
 *
 * Виджет пересобирается на каждом ходу и на каждом свайпе, а SillyTavern
 * вдобавок затирает его при перерисовке сообщения. Держи выбор в памяти
 * модуля — и он слетал бы на нить Фрейи посреди разговора о {{char}}.
 */
function activeTab() {
    const tab = settings().activeTab;
    const tabs = tabsForSkin();
    if (tabs.includes(tab)) return tab;
    /* Выбор один на все раскладки, а списки у них разные. Чужую вкладку
       сводим к своей главной, а не гасим: сменил раскладку — книга открыта,
       а не пуста. */
    return currentSkin() === "thread" ? "user" : "freyja";
}

function applyTab() {
    const tab = activeTab();
    el("#nrn-page").attr("data-tab", tab);
    /* Створка детей — такая же кнопка со своей вкладкой, только заголовок
       у неё свой; берём все кнопки с вкладкой, а не одни фигурки. */
    el("button[data-tab]").each(function () {
        const fig = $(this);
        const on = fig.attr("data-tab") === tab;
        fig.toggleClass("nrn-fig-on", on).attr("aria-pressed", on ? "true" : "false");
    });
}

/* ============================================================
 * 5. WIDGET MOUNTING
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
    if (lastBot.querySelector("#nrn-widget")) return; // уже на месте
    mountWidget();
    renderAll();
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
 * 6. WIDGET BUILDING
 * ============================================================ */

/** Элемент SVG. Через $("<svg>") их не создать: нужен createElementNS. */
function svgEl(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value);
    return node;
}

/**
 * Вегвизир — знак восьми лучей, и в нём горит луч нынешней эйкты.
 *
 * Знак собран вёрсткой целиком: восемь ставов вокруг общей середины, у
 * каждого своё завершение и свои поперечины, как на исландских ставах.
 * Внешнего кольца нет вовсе — оно спорило бы с рамкой панели.
 *
 * Система координат своя: середина знака — 0,0, остриё смотрит вверх,
 * древко идёт до -104. Углы не считаем: восемь эйкт — восемь румбов, и
 * каждый следующий луч довёрнут на 45°.
 */
const VEGVISIR_RAYS = 8;

/* Завершения восьми лучей — по одному на эйкту. */
const VEGVISIR_ARMS = [
    /* 0 — трезубец с двумя поперечинами (север) */
    `<path d="M-17 -78 L-17 -104 M17 -78 L17 -104 M0 -88 L0 -110" />
     <path d="M-17 -78 L17 -78" />
     <path d="M-13 -58 L13 -58" />`,
    /* 1 — кольцо и крюк */
    `<circle cx="0" cy="-96" r="9" />
     <path d="M-9 -96 C-22 -96 -22 -78 -9 -78" />
     <path d="M-12 -62 L12 -62" />`,
    /* 2 — гребень из трёх перекладин */
    `<path d="M-15 -100 L15 -100" />
     <path d="M-15 -86 L15 -86" />
     <path d="M-15 -72 L15 -72" />`,
    /* 3 — вилка с раздвоенным концом */
    `<path d="M0 -104 L-16 -88 M0 -104 L16 -88" />
     <path d="M-11 -74 L11 -74" />
     <path d="M-11 -58 L11 -58" />`,
    /* 4 — короб на ножках (юг) */
    `<path d="M-19 -78 L-19 -100 L19 -100 L19 -78" />
     <path d="M-8 -100 L-8 -86 M8 -100 L8 -86" />
     <path d="M-13 -64 L13 -64" />`,
    /* 5 — косой крест */
    `<path d="M-16 -104 L16 -80 M16 -104 L-16 -80" />
     <path d="M-12 -66 L12 -66" />`,
    /* 6 — скоба с обратными концами */
    `<path d="M-17 -100 L17 -100 M-17 -100 L-17 -84 M17 -100 L17 -84" />
     <path d="M-10 -78 L10 -78" />
     <path d="M-10 -62 L10 -62" />`,
    /* 7 — два крюка */
    `<path d="M0 -102 C-16 -102 -18 -86 -8 -84" />
     <path d="M0 -102 C16 -102 18 -86 8 -84" />
     <path d="M-12 -66 L12 -66" />`,
];

function vegvisirOverlay() {
    const svg = svgEl("svg", {
        "class": "nrn-vegvisir-svg",
        viewBox: "0 0 240 240",
        "aria-hidden": "true",
    });

    for (let i = 0; i < VEGVISIR_RAYS; i++) {
        const ray = svgEl("g", {
            "class": "nrn-vegvisir-ray",
            "data-ray": i,
            transform: `rotate(${i * 45} 120 120)`,
        });
        /* Пути става писаны от середины знака, поэтому группу сдвигаем в
           центр квадрата; поворот наследуется от самого луча. */
        const stave = svgEl("g", {
            "class": "nrn-ray-stave",
            transform: "translate(120 120)",
        });
        /* Древко — первым, завершение поверх него: без этой черты от става
           остались бы одни концы, висящие в воздухе. */
        stave.innerHTML = `<path d="M0 0 L0 -104" />${VEGVISIR_ARMS[i]}`;
        ray.appendChild(stave);
        svg.appendChild(ray);
    }

    return $("<div>", { id: "nrn-vegvisir", "class": "nrn-vegvisir" }).append(svg);
}

/**
 * Кнопка створки: {{user}}, нить Фрейи и {{char}}.
 *
 * Три таких кнопки правят разворотом — какая нажата, та створка и открыта.
 * Имя стоит и подписью внутри кнопки, и подсказкой под курсором, и в
 * aria-label: подпись видно глазом, остальное нужно чтению с экрана.
 */
function figureButton(tab, id, label) {
    return $("<button>", {
        id,
        "class": `nrn-fig nrn-fig-${tab}`,
        type: "button",
        "data-tab": tab,
        "aria-label": label,
        title: label,
    }).append(
        $("<span>", { "class": "nrn-fig-name", text: label }),
    );
}

/**
 * Акцентный разделитель в духе исландских ставов.
 *
 * Ставится только там, где нужен акцент: перед нитью Фрейи.
 * Обычные черты остаются чертами — иначе акцент перестаёт быть акцентом.
 */
function buildNorseRule() {
    const glyph = `<path d="M2 4 A4 4 0 0 1 2 12" />
           <path d="M8 8 H30" />
           <path d="M22 4 L18 8 L22 12" />
           <path d="M30 4 V12" />
           <path d="M36 8 H52" />
           <path class="nrn-rule-eye" d="M66 2 L78 8 L66 14 L54 8 Z" />
           <circle class="nrn-rule-dot" cx="66" cy="8" r="1.4" />
           <path d="M80 8 H96" />
           <path d="M102 4 V12" />
           <path d="M110 4 L114 8 L110 12" />
           <path d="M102 8 H124" />
           <path d="M130 4 A4 4 0 0 0 130 12" />`;
    return $("<div>", { "class": "nrn-rule", "aria-hidden": "true" })
        .html(`<svg width="132" height="16" viewBox="0 0 132 16">${glyph}</svg>`);
}

/** Создаёт DOM-структуру виджета (detached — вставит mountWidget). */
function buildWidget() {
    if ($widget) return $widget;

    const s = settings();

    $widget = $("<div>", { id: "nrn-widget", "class": "nrn-themed" }).append(
        $("<div>", { id: "nrn-board", "class": "nrn-board" }).append(

            /*
             * Верхняя балка: обстановка сцены.
             *
             * Погода и место стоят друг напротив друга по разные стороны
             * солнца, время суток — под погодой. Три разных вопроса к сцене
             * разведены по углам балки, а не сложены в один список: так
             * ответ на каждый находится глазом сразу, без чтения остальных.
             *
             * Знак у каждой надписи свой; показывать его или нет, решает
             * раскладка стилями.
             */
            $("<div>", { id: "nrn-beam", "class": "nrn-beam" }).append(
                /* Погода и время — одной стопкой, а не двумя надписями по
                   своим местам: длинная погода занимает две строки, и время
                   должно съехать вниз вместе с ней, а не оказаться под ней. */
                $("<div>", { "class": "nrn-beam-left" }).append(
                    $("<div>", { id: "nrn-weather-text", "class": "nrn-beam-line" }).append(
                        icon("scene-weather"),
                        $("<span>", { id: "nrn-weather-value" }),
                    ),
                    $("<div>", { id: "nrn-time-line", "class": "nrn-beam-line" }).append(
                        $("<span>", { id: "nrn-eykt-name" }),
                        $("<span>", { id: "nrn-eykt-num" }),
                    ),
                ),
                $("<div>", { id: "nrn-location-text", "class": "nrn-beam-line" }).append(
                    icon("scene-location"),
                    $("<span>", { id: "nrn-location-value" }),
                ),
            ),

            /*
             * Левый столбец — счёт времени.
             *
             * Сверху вегвизир, и в нём горит луч нынешней эйкты. Под знаком
             * дата, у нижнего края — календарик.
             */
            $("<div>", { id: "nrn-wood", "class": "nrn-wood" }).append(
                vegvisirOverlay(),

                $("<div>", { id: "nrn-datebox" }).append(
                    $("<div>", { id: "nrn-sun", "class": "nrn-sun-line" }),
                    /*
                     * Седмица и Луна лежат в общей обёртке.
                     *
                     * Обе сходятся в одну подпись под календариком:
                     * «Frjádagr · vika 48 · Fullt tungl», и коробка нужна,
                     * чтобы было что положить в эту строку.
                     */
                    $("<div>", { "class": "nrn-calfoot" }).append(
                        $("<div>", { id: "nrn-week", "class": "nrn-cal-line" }),
                        $("<div>", { id: "nrn-moon", "class": "nrn-cal-line" }),
                    ),
                    $("<div>", { id: "nrn-date", "class": "nrn-cal-line" }),

                    /* Праздник — прямо над календариком, где он и покрашен. */
                    $("<div>", { id: "nrn-feast", "class": "nrn-cal-line" }),
                ),

                $("<div>", { id: "nrn-grid" }),
            ),

            /*
             * Книга — разворот из трёх створок.
             *
             * На странице вся сводка, а рядом с ней то, чем её
             * переключают: створки {{user}} и {{char}} и нить Фрейи.
             */
            $("<div>", { id: "nrn-book", "class": "nrn-book" }).append(

                $("<div>", { id: "nrn-page", "class": "nrn-page", "data-tab": "freyja" }).append(

                        $("<div>", { id: "nrn-page-user", "class": "nrn-leaf", "data-leaf": "user" }).append(
                            $("<div>", { id: "nrn-attire-user", "class": "nrn-attire" }).append(
                                icon("char-attire", "nrn-attire-icon"),
                                $("<span>", { id: "nrn-attire-user-text" }),
                            ),
                            $("<div>", { id: "nrn-user-state", "class": "nrn-state" }).append(
                                icon("char-state", "nrn-state-icon"),
                                $("<span>", { id: "nrn-user-state-text" }),
                            ),
                            $("<div>", { id: "nrn-user-empty", "class": "nrn-leaf-empty" }),
                        ),

                        /* Нить Фрейи — напоминалка о цикле и сроке. Слово
                           норны живёт здесь же: в разметке это последнее
                           слово листа, а на место его ставит applySkin. */
                        $("<div>", { id: "nrn-page-freyja", "class": "nrn-leaf", "data-leaf": "freyja" }).append(
                            buildNorseRule(),
                            $("<div>", { id: "nrn-cycle", "class": "nrn-cycle" }).append(
                                /* Фаза со счётом — заголовок листа, слова о ней
                                   под ним подзаголовком. */
                                $("<div>", { id: "nrn-cycle-text", "class": "nrn-cycle-head" }),
                                $("<div>", { id: "nrn-cycle-status", "class": "nrn-cycle-sub" }),
                                /* Когда ждать — только при ношении. */
                                $("<div>", { id: "nrn-cycle-extra", "class": "nrn-cycle-dim" }),
                            ),
                            /*
                             * Подножие: слово норны.
                             *
                             * Обёртка лежит внутри листа нити, а на место её
                             * ставит applySkin: в книгу, под все три створки.
                             * Здесь она потому, что совет — последнее слово
                             * именно этого листа, и разметке так понятнее.
                             */
                            $("<div>", { "class": "nrn-foot" }).append(
                                $("<div>", { id: "nrn-advice", "class": "nrn-advice" }).append(
                                    icon("advice", "nrn-advice-icon"),
                                    $("<span>", { id: "nrn-advice-text" }),
                                ),
                            ),
                            $("<div>", { id: "nrn-freyja-empty", "class": "nrn-leaf-empty" }),
                        ),

                        $("<div>", { id: "nrn-page-char", "class": "nrn-leaf", "data-leaf": "char" }).append(
                            $("<div>", { id: "nrn-mood-chips", "class": "nrn-chips" }),
                            $("<div>", { id: "nrn-attire-char", "class": "nrn-attire" }).append(
                                icon("char-attire", "nrn-attire-icon"),
                                $("<span>", { id: "nrn-attire-char-text" }),
                            ),
                            $("<div>", { id: "nrn-char-state", "class": "nrn-state" }).append(
                                icon("char-state", "nrn-state-icon"),
                                $("<span>", { id: "nrn-char-state-text" }),
                            ),
                            $("<div>", { id: "nrn-thought", "class": "nrn-thought" }).append(
                                icon("char-thought", "nrn-thought-icon"),
                                $("<span>", { id: "nrn-thought-text" }),
                            ),
                            $("<div>", { id: "nrn-char-empty", "class": "nrn-leaf-empty" }),
                        ),
                ),

                /*
                 * Фигурки. Порядок в разметке — порядок слоёв: шнурки висят
                 * внахлёст, и {{char}} нарисован поверх медальона, медальон —
                 * поверх хозяйки. Так же они лежали и в макете.
                 */
                figureButton("user", "nrn-fig-user", "{{user}}"),
                figureButton("freyja", "nrn-fig-freyja", "Нить Фрейи"),
                figureButton("char", "nrn-fig-char", "{{char}}"),

            ),

            $("<div>", { id: "nrn-stub", text: `ᚱ ${t`Waiting for the infoblock…`}` }),
        ),
    );

    /* Через currentTheme(), а не через s.theme: цвет обязан быть родным
       для раскладки, и спрашивают его в одном месте на всё расширение. */
    $widget.attr("data-theme", currentTheme());
    /* Через currentSkin() по той же причине: в настройках может лежать
       раскладка, которой больше нет, и тогда блок остался бы без стилей. */
    applySkin(currentSkin());

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

    $(document).on("click", "#nrn-widget .nrn-hintable", function () {
        swapHint($(this));
    });

    /* Фигурки на правой странице. Клик приходит с «горячего места» внутри
       кнопки и всплывает сюда: сама кнопка помечена pointer-events: none,
       чтобы прямоугольники рисунков не воровали клики друг у друга. */
    $(document).on("click", "#nrn-widget button[data-tab]", function () {
        const tab = $(this).attr("data-tab");
        if (!tabsForSkin().includes(tab)) return;
        /* В «нитях» разделы складываются, как ставни: щелчок по открытому
           закрывает его и оставляет одни заголовки. В двух других раскладках
           закрывать нечего — там лист открыт всегда. */
        const close = currentSkin() === "thread" && activeTab() === tab;
        settings().activeTab = close ? "" : tab;
        saveSettingsDebounced();
        applyTab();
    });
}

/* ============================================================
 * 7. TÍMATAL — мини-справочник
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
        isColumnVisible: (key) =>
            isPermanent(key) || list("timatalVisibleColumns", toggleable).includes(key),
        toggleColumn: (key) => toggle("timatalVisibleColumns", toggleable, key),

        isDefaultView: () =>
            sameSet(list("timatalVisibleColumns", toggleable), DEFAULT_VISIBLE_COLUMNS),

        resetView: () => {
            s.timatalVisibleColumns = [...DEFAULT_VISIBLE_COLUMNS];
            saveSettingsDebounced();
        },
    };
}

/**
 * Настройки уведомлений для раздела в Tímatal.
 *
 * Мастер-выключатель и набор видов. Выключатель отдельно от набора нарочно:
 * «выключить всё на вечер» — не то же самое, что «мне не нужны праздники», и
 * галочки после включения обратно должны остаться теми же.
 */
function notifyPrefs() {
    const s = settings();

    const kinds = () => {
        if (!Array.isArray(s.notifyKinds)) s.notifyKinds = [...DEFAULT_NOTICES];
        /* Чистим от неизвестных ключей: переименование вида не должно
           оставлять в настройках мусор, который никто уже не выключит. */
        const clean = s.notifyKinds.filter((v) => NOTICE_IDS.includes(v));
        if (clean.length !== s.notifyKinds.length) s.notifyKinds = clean;
        return s.notifyKinds;
    };

    return {
        enabled: () => !!s.notify,
        setEnabled: (on) => {
            s.notify = !!on;
            saveSettingsDebounced();
            /* Включили — считаем нынешний ход точкой отсчёта, чтобы первая
               же всплывашка не пересказала то, что и так на экране. */
            forgetWatch();
            notifyTick();
        },
        isOn: (id) => kinds().includes(id),
        toggle: (id) => {
            const arr = kinds();
            const idx = arr.indexOf(id);
            if (idx === -1) arr.push(id);
            else arr.splice(idx, 1);
            saveSettingsDebounced();
            return idx === -1;
        },
        /* Что показывать в разделе, а что скрыть: женская линия выключена —
           галочкам про цикл и ношение там делать нечего. */
        bodyTracking: () => !!s.bodyTracking,
        holidays: () => !!s.holidays,
    };
}

/**
 * Ставит дату сцены из календарика Tímatal.
 *
 * Якорь ложится на последнее сообщение {{char}} — там же, где живёт весь
 * остальной снимок. Поэтому откат чата и удаление сообщений уносят дату
 * вместе с собой, а свайпы её не перепутывают.
 */
function applySceneDate(date) {
    const context = getContext();
    /* Дату начала чата пишем всегда: она страхует случай, когда сообщение
       с якорем потом удалят или откатят. Якорь на сообщении поверх неё
       уточняет, с какого места в истории дата поменялась. */
    setChatStartDate(date);
    if (setSceneDate(context?.chat, date, date, readOptions())) context.saveChat?.();
    refresh();
    return true;
}

/* ============================================================
 * 7a. ОФОРМЛЕНИЕ: РАСКЛАДКА, ТЕМА И ПОЛЬЗОВАТЕЛЬСКИЙ CSS
 *
 * Последний раздел Tímatal собрал всё, что относится к виду блока:
 * выбор раскладки, выбор темы и поле с исходным CSS выбранной темы,
 * которое можно править, — «Применить» и «Восстановить» под ним.
 *
 * В «кубиках» таверны этих двух списков больше нет нарочно. Оформление
 * выбирают глазами, а глазами блок виден отсюда: справочник открывается
 * поверх чата, и перекрашенный блок видно в ту же секунду. В настройках
 * расширения остались только те переключатели, у которых есть последствия
 * помимо вида, — инжект в промпт, счёт тела, праздники.
 *
 * Правки лежат в localStorage, а не в настройках расширения: это оформление
 * одного браузера, а не часть чата, и таскать его на сервер вместе с датами
 * и телом незачем. Ключ у каждой темы свой — правка «Полночного моря» не
 * должна пропадать оттого, что человек ушёл в «Жар очага».
 *
 * Применяется всё одним <style> в конце <head>. Он идёт после нашего
 * style.css, поэтому при равном весе побеждают правки пользователя — и
 * ему не приходится дописывать !important к каждой строке.
 * ============================================================ */

const USER_CSS_PREFIX = "nornir-css:";
const USER_CSS_STYLE_ID = "nornir-user-css";

/**
 * Темы и раскладки — списком, а не только блоками в CSS.
 *
 * Порядок здесь и есть порядок в откидном меню справочника: сперва тёмные,
 * потом светлые, стандартная первой. Добавили тему в style.css — впишите
 * её сюда, и она появится в выборе.
 */
const THEME_LABELS = {
    "thread-tavern": () => t`Threads: like the tavern`,
    "thread-dark": () => t`Threads: dark`,
    "thread-light": () => t`Threads: light`,
    "thread-calm": () => t`Threads: calm`,
    "thread-starks": () => t`Threads: Starks`,
    "thread-lannister": () => t`Threads: Lannister`,
    "thread-targaryen": () => t`Threads: Targaryen`,
    "thread-baratheon": () => t`Threads: Baratheon`,
    "thread-greyjoy": () => t`Threads: Greyjoy`,
    "thread-tyrell": () => t`Threads: Tyrell`,
    "thread-martell": () => t`Threads: Martell`,
    "thread-arryn": () => t`Threads: Arryn`,
    "thread-tully": () => t`Threads: Tully`,
    "thread-bolton": () => t`Threads: Bolton`,
    "thread-watch": () => t`Threads: Night's Watch`,
    "thread-voyage": () => t`Threads: Sea voyage`,
    "thread-longhouse": () => t`Threads: Longhouse`,
    "thread-forge": () => t`Threads: Forge`,
    "thread-hoard": () => t`Threads: Barrow gold`,
    "thread-seidr": () => t`Threads: Seidr`,
    "thread-yule": () => t`Threads: Yule`,
    "thread-niflheim": () => t`Threads: Niflheim`,
    /* Тема новой раскладки. Зовётся так же, как «Нити: тьма» у старой, и
       это не описка: цвет тот же, а список у каждой раскладки свой, и
       рядом эти две в нём не встают. */
    "loom-dark": () => t`Threads: dark`,
};

const SKIN_LABELS = {
    thread: () => t`House and its threads`,
    loom: () => t`House and its threads (new)`,
};

/*
 * Перекрасы — у каждой раскладки свои, и общего списка больше нет.
 *
 * Список тем спрашивается у раскладки, а не у файла: у каждой свой набор
 * ролей, и цвет из чужого набора красил бы блок наполовину. Новая
 * раскладка (loom) пока при одной теме — на ней и идёт правка вёрстки;
 * её палитра лежит в отдельном файле skin-loom.css и старую не задевает.
 */
const SKIN_THEMES = {
    thread: [
        /* Первой — та, что цвета не имеет: она берёт их у таверны. */
        "thread-tavern",
        "thread-dark", "thread-light", "thread-calm",
        "thread-starks", "thread-lannister", "thread-targaryen", "thread-baratheon",
        "thread-greyjoy", "thread-tyrell", "thread-martell", "thread-arryn",
        "thread-tully", "thread-bolton", "thread-watch",
        "thread-voyage", "thread-longhouse", "thread-forge", "thread-hoard",
        "thread-seidr", "thread-yule", "thread-niflheim",
    ],
    loom: ["loom-dark"],
};

function themeLabel(theme) {
    return (THEME_LABELS[theme] ?? (() => theme))();
}

function currentSkin() {
    return SKIN_LABELS[settings().skin] ? settings().skin : "thread";
}

/** Родные перекрасы раскладки — в том порядке, в каком они встанут в список. */
function themesOfSkin(skin) {
    return SKIN_THEMES[skin] ?? SKIN_THEMES.thread;
}

function themeFitsSkin(theme, skin) {
    return themesOfSkin(skin).includes(theme);
}

/**
 * Чем красить эту раскладку.
 *
 * Каждая раскладка помнит СВОЙ последний выбор: ушли с «нитей» на новую
 * и вернулись — Ланнистеры на месте. Иначе один общий цвет на все
 * раскладки означал бы, что переход туда и обратно стирает выбор,
 * сделанный минуту назад.
 */
function themeOfSkin(skin) {
    const kept = settings().skinThemes?.[skin];
    return themeFitsSkin(kept, skin) ? kept : themesOfSkin(skin)[0];
}

/* Чистая: настройки не правит. Сохранённая тема может быть от прежней
   раскладки — тогда берётся та, что помнит нынешняя. */
function currentTheme() {
    const skin = currentSkin();
    return themeFitsSkin(settings().theme, skin) ? settings().theme : themeOfSkin(skin);
}

/*
 * localStorage бывает недоступен: приватное окно, запрет на сторонние
 * данные, переполнение квоты. Тогда правки просто не сохраняются — окно
 * скажет об этом словом, а блок продолжит работать на своих цветах.
 */
function readUserCss(theme) {
    try {
        return localStorage.getItem(`${USER_CSS_PREFIX}${theme || "thread-dark"}`);
    } catch {
        return null;
    }
}

function writeUserCss(theme, text) {
    const key = `${USER_CSS_PREFIX}${theme || "thread-dark"}`;
    try {
        if (text == null) localStorage.removeItem(key);
        else localStorage.setItem(key, text);
        return true;
    } catch (e) {
        console.error(`[${extensionName}] не удалось сохранить правку CSS:`, e);
        return false;
    }
}

/** Темы, у которых есть сохранённая правка. Список не заведён нарочно:
    так добавление темы не требует править ещё и это место. */
function editedThemes() {
    const out = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(USER_CSS_PREFIX)) out.push(key.slice(USER_CSS_PREFIX.length));
        }
    } catch { /* localStorage недоступен — правок нет по определению */ }
    return out;
}

/*
 * Вторая таблица стилей — раскладка «Дом и его нити (новая)».
 *
 * В manifest.json значится один файл, и менять это незачем: там лежит всё,
 * что расширению нужно всегда. Новая раскладка — опыт: её правят отдельно,
 * и падать вместе с ней старая не должна. Поэтому она живёт своим файлом
 * и подкладывается отсюда.
 *
 * Путь считается от самого index.js: из JS папку расширения иначе не
 * видно, а писать её руками — значит сломаться на первой же установке не
 * в third-party/NORNIR.
 */
const SKIN_CSS_ID = "nornir-skin-loom";

function loadSkinCss() {
    if (document.getElementById(SKIN_CSS_ID)) return;
    const link = document.createElement("link");
    link.id = SKIN_CSS_ID;
    link.rel = "stylesheet";
    link.href = new URL("./skin-loom.css", import.meta.url).href;
    document.head.append(link);
}

/** Собирает все сохранённые правки в один <style> в конце <head>. */
function applyUserCss() {
    const parts = editedThemes().map((th) => readUserCss(th)).filter(Boolean);
    let el = document.getElementById(USER_CSS_STYLE_ID);

    if (!parts.length) { el?.remove(); return; }

    if (!el) {
        el = document.createElement("style");
        el.id = USER_CSS_STYLE_ID;
        document.head.append(el);
    }
    el.textContent = parts.join("\n\n");
}

/**
 * Исходный CSS темы — прочитанный из самого style.css, а не переписанный
 * сюда руками.
 *
 * Иначе «Восстановить» возвращало бы вчерашние цвета: правка файла и копия
 * в коде разъезжаются на первом же изменении темы. Берём все правила, в
 * чьём селекторе стоит эта тема, — и общий блок переменных, и поправки
 * к нему, где бы они ни лежали.
 */
/**
 * Правило — в читаемый вид: селекторы по строкам, свойства столбиком.
 *
 * Через rule.cssText не выйдет: браузер отдаёт его одной строкой в тысячу
 * знаков, и править её в поле ввода невозможно. Поэтому пересобираем сами,
 * из selectorText и списка свойств.
 */
function themeRuleText(rule) {
    const selectors = rule.selectorText.split(",").map((s) => s.trim()).join(",\n");
    const lines = [];
    for (const prop of rule.style) {
        const value = rule.style.getPropertyValue(prop).trim();
        const bang = rule.style.getPropertyPriority(prop) ? " !important" : "";
        lines.push(`    ${prop}: ${value}${bang};`);
    }
    return `${selectors} {\n${lines.join("\n")}\n}`;
}

function originalThemeCss(theme) {
    const marker = `[data-theme="${theme || "thread-dark"}"]`;
    const chunks = [];

    for (const sheet of document.styleSheets) {
        if (!(sheet.href ?? "").includes("NORNIR")) continue;
        let rules;
        /* Чужой источник читать нельзя — браузер бросит SecurityError. */
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
            if (!rule.selectorText?.includes(marker)) continue;
            chunks.push(themeRuleText(rule));
        }
    }
    return chunks.join("\n\n");
}

/**
 * Всё, что нужно разделу оформления в справочнике.
 *
 * Тема здесь не запомнена числом, а спрашивается каждый раз: список сам
 * её и меняет, и окно не пересобирается ради этого — перекрашивается на
 * месте. Поэтому все действия принимают тему явным доводом.
 *
 * @param {function(): HTMLElement|null} getDialog Подложка окна Tímatal:
 *   её тоже надо перекрасить, а создаётся она позже самого содержимого.
 */
function lookControls(getDialog) {
    const list = (labels) => Object.keys(labels).map((id) => ({ id, label: labels[id]() }));

    /* Окно справочника красится той же темой, что и блок: иначе выбор
       пришлось бы сверять с чатом за спиной у окна. */
    const paintDialog = () => {
        const dlg = getDialog?.();
        if (dlg) dlg.dataset.theme = settings().theme;
    };

    return {
        skins: list(SKIN_LABELS),
        /* Списком тем ведает раскладка: чужие в него не попадают, и выбрать
           то, что сломает вид, попросту нечем. */
        themes: () => themesOfSkin(currentSkin()).map((id) => ({ id, label: themeLabel(id) })),
        skin: () => currentSkin(),
        theme: () => currentTheme(),
        themeLabel,

        setSkin: (id) => {
            const skin = SKIN_LABELS[id] ? id : "thread";
            settings().skin = skin;
            /* Раскладка тянет за собой свой цвет — тот, на котором её
               оставили в прошлый раз. */
            settings().theme = themeOfSkin(skin);
            saveSettingsDebounced();
            applySkin(skin);
            applyTheme(settings().theme);
            paintDialog();
        },

        setTheme: (id) => {
            const skin = currentSkin();
            settings().theme = themeFitsSkin(id, skin) ? id : themeOfSkin(skin);
            settings().skinThemes[skin] = settings().theme;
            saveSettingsDebounced();
            applyTheme(settings().theme);
            paintDialog();
        },

        original: (theme) => originalThemeCss(theme),
        isEdited: (theme) => readUserCss(theme) != null,
        read: (theme) => readUserCss(theme) ?? originalThemeCss(theme),

        apply: (theme, text) => {
            if (!writeUserCss(theme, text)) return false;
            applyUserCss();
            return true;
        },

        restore: (theme) => {
            writeUserCss(theme, null);
            applyUserCss();
            return originalThemeCss(theme);
        },
    };
}

/** Открывает окно Tímatal. */
async function openTimatal() {
    /*
     * Окно пересобирается после каждой правки, а не только при открытии.
     *
     * На новом чате даты ещё нет, и блока про тело в справочнике нет тоже:
     * считать не от чего. Пользователь ставит дату — блок обязан появиться
     * тут же, а не после закрытия и повторного открытия окна. Заодно
     * «что сейчас» над формой перестаёт врать: раньше там до конца сеанса
     * висело то, что было на момент открытия.
     */
    /*
     * Popup таверны кладёт эту коробку в свою `.popup-content`, и коробка
     * эта — звено в цепочке гибких блоков от <dialog> до полосы прокрутки
     * внутри справочника. Класс на ней затем и нужен: без него обёртка
     * растекается по содержимому, и справочник перестаёт листаться вовсе.
     */
    const shell = document.createElement("div");
    shell.className = "nrn-t-shell";
    /* Подложка окна появляется после первой сборки содержимого, поэтому
       раздел оформления получает не её саму, а способ её спросить. */
    let dialog = null;
    const look = lookControls(() => dialog);

    const paint = () => {
        shell.replaceChildren(
            buildReference(state, currentTheme(), timatalPrefs(), onSetDate,
                cycleControls(paint), look, notifyPrefs()),
        );
    };
    const onSetDate = (date) => {
        if (!applySceneDate(date)) return false;
        paint();
        return true;
    };

    /* Первая сборка идёт до показа окна, и её падение выглядело как «кнопка
       не нажимается»: ни окна, ни слова. Пусть лучше не откроется вовсе,
       но скажет почему. */
    try {
        paint();
    } catch (e) {
        panelFailed("Tímatal", e);
        return;
    }

    // Popup, а не callGenericPopup: нужен доступ к <dialog> ДО показа, чтобы
    // покрасить подложку своей темой без мигания таверновской.
    /*
     * allowVerticalScrolling выключен нарочно: прокрутку ведёт не окно
     * целиком, а страница внутри него. Шапка с возвратом на карту обязана
     * стоять на месте, пока таблица под ней уезжает вверх, — иначе с
     * телефона до «← карта» пришлось бы листать обратно.
     */
    const popup = new Popup(shell, POPUP_TYPE.DISPLAY, "", {
        wide: true,
        large: true,
        allowVerticalScrolling: false,
        leftAlign: true,
    });
    popup.dlg.classList.add("nrn-popup", "nrn-themed");
    popup.dlg.dataset.theme = currentTheme();
    dialog = popup.dlg;

    await popup.show();
}

/** Добавляет пункт Tímatal в меню «волшебной палочки». */
function addWandMenuItem() {
    const menu = document.getElementById("extensionsMenu");
    if (!menu || document.getElementById("nrn_timatal_button")) return;

    const container = document.createElement("div");
    container.id = "nrn_timatal_wand_container";
    container.className = "extension_container";

    const item = document.createElement("div");
    item.id = "nrn_timatal_button";
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
 * 8. SLASH COMMANDS (STscript)
 * ============================================================ */

/** Дата строкой, как её показывает панель, либо пустая строка. */
function formatDate() {
    if (!hasDate(state)) return "";
    const { year, month, day } = state;
    if (isAuk(month)) return `Sumarauki ${day} из ${aukDays(year)}, ${year}`;
    return `${day} ${MONTHS[month - 1].ru} ${year}`;
}

/** Название текущей эйкты, либо пустая строка. */
function formatEykt() {
    if (!hasTime(state)) return "";
    return EYKTIR[eyktForHour(state.hour)].ru;
}

function registerSlashCommands() {
    const commands = [
        {
            name: "nornir-date",
            callback: () => formatDate(),
            returns: "текущую дату сцены, либо пустую строку",
            helpString: "Возвращает дату сцены (например «13 Гормануд 1015»).",
        },
        {
            name: "nornir-eykt",
            callback: () => formatEykt(),
            returns: "название текущей эйкты, либо пустая строка",
            helpString: "Возвращает эйкту из последнего маркера (например «Хадеги»).",
        },
        {
            name: "nornir-state",
            callback: () => JSON.stringify(state),
            returns: "весь распознанный инфоблок в JSON",
            helpString: "Возвращает всё состояние панели: дату, время, погоду, локацию, настроение, одежду, мысль, состояния тел, совет и всё, что сказано про дитя.",
        },
        {
            /* Отладочная: показывает ровно то, что уходит модели, — целиком
               и в том же порядке. Без неё сравнить два промпта можно было
               только через просмотрщик таверны, выковыривая наш кусок
               из чужого; а сравнивать их приходится каждую правку. */
            name: "nornir-prompt",
            callback: () => {
                forgetChat();
                try {
                    return settings()?.inject ? buildPrompt() : "";
                } catch (e) {
                    console.error(`[${extensionName}] /nornir-prompt:`, e);
                    return "";
                }
            },
            returns: "весь собранный инжект, либо пустую строку",
            helpString: "Возвращает промпт, который расширение подмешивает в запрос: справки о времени, теле, дитяти и прошлой сцене плюс требования блока. Пустая строка — если инжект выключен.",
        },
        {
            name: "nornir-refresh",
            callback: () => {
                refresh();
                return "";
            },
            returns: "пустую строку",
            helpString: "Принудительно перечитывает чат и перерисовывает виджет.",
        },
        {
            name: "nornir-timatal",
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
            // Массивы и коробки копируем: иначе настройки получат ссылку на
            // сам defaultSettings, и первая же правка испортит константу.
            extension_settings[extensionName][key] = Array.isArray(value) ? [...value]
                : (value && typeof value === "object" ? { ...value } : value);
        }
    }
    /*
     * В настройках может лежать раскладка, которой больше нет, — и тема
     * от неё заодно. Сводим одно с другим один раз при загрузке, чтобы
     * дальше всё считалось от нынешней раскладки, а не от того, что
     * осталось с прошлой версии.
     */
    const settingsNow = extension_settings[extensionName];
    const skinNow = SKIN_LABELS[settingsNow.skin] ? settingsNow.skin : "thread";
    settingsNow.skin = skinNow;
    if (!settingsNow.skinThemes || typeof settingsNow.skinThemes !== "object") {
        settingsNow.skinThemes = { ...defaultSettings.skinThemes };
    }
    if (themeFitsSkin(settingsNow.theme, skinNow)) settingsNow.skinThemes[skinNow] = settingsNow.theme;
    settingsNow.theme = themeOfSkin(skinNow);
    // Наследие прежней схемы, где хранился список скрытых колонок.
    delete extension_settings[extensionName].timatalHiddenColumns;
    /* Сетка дней больше не сворачивается: кнопку убрали, блок всегда открыт. */
    delete extension_settings[extensionName].collapsed;
    /*
     * Аккордеон в Tímatal был, да весь вышел: разделы больше не сворачиваются,
     * у каждого своя страница. Список свёрнутых и досыпка к нему («раздел
     * уведомлений появился позже прочих») стали ни к чему — выметаем их из
     * сохранённых настроек, чтобы не тащить за собой мёртвый ключ.
     */
    delete extension_settings[extensionName].timatalClosedSections;
    delete extension_settings[extensionName].notifySeeded;
    /* Длина цикла была настройкой и успела сохраниться со значением 30.
       Теперь она всегда 28, а забытая тридцатка давала ровный оборот на
       таймскипе в три месяца — цикл возвращался на тот же день. */
    delete extension_settings[extensionName].cycleLength;
    /* Женскую линию урезали до счёта цикла и срока: отладка скрытого слоя,
       смерть от отвара, точность гадания и шансы зачатия больше ни к чему. */
    for (const key of ["bodyDebug", "herbDeath", "divinationAccuracy", "conceptionChances"]) {
        delete extension_settings[extensionName][key];
    }
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
    if ($widget) $widget.attr("data-theme", theme || "thread-dark");
}

/**
 * Раскладка — атрибутом на виджете, и одно перевешивание узла.
 *
 * Всё остальное решает CSS: разметка у раскладок одна, лишнее в каждой
 * спрятано стилями. Поэтому переключение мгновенное и не теряет ни
 * открытой створки, ни прокрутки.
 *
 * Подножие — единственное исключение: оно принадлежит всей панели, стоит
 * под всеми тремя створками и говорит о ходе, а не о листе. В разметке
 * оно лежит внутри листа нити, и здесь его переносят в книгу. CSS такого
 * не умеет: узел меняет не вид, а хозяина.
 */
function applySkin(skin) {
    if (!$widget) return;
    $widget.attr("data-skin", skin || "thread");

    const foot = $widget.find(".nrn-foot");
    const $book = $widget.find("#nrn-book");
    if ($book.length && !foot.parent().is($book)) $book.append(foot);

    forgetStoredDisplay();
}

/*
 * Забыть, каким был display в прошлой раскладке.
 *
 * jQuery .hide() запоминает ВЫЧИСЛЕННЫЙ display и возвращает его обратно
 * при .show() — уже строкой в атрибуте style, а инлайн сильнее файла.
 * Значение запомнено под той раскладкой, что была на экране: спрятали род
 * с домом там, где у них сетка, — и в другой раскладке .show() возвращает
 * им ту же сетку вместо двух столбцов. Столбцы складывались в один,
 * приметы теряли строй, и починить это правилами было нечем.
 *
 * Гасим только то, что показано: скрытое пусть остаётся скрытым, иначе
 * до ближайшей перерисовки на экране повисли бы пустые строки. Дальше
 * jQuery запомнит уже вычисленное в новой раскладке, и всё сойдётся само.
 */
function forgetStoredDisplay() {
    $widget.find("*").each(function () {
        if (this.style.display && this.style.display !== "none") this.style.display = "";
    });
}

function bindSettings() {
    bindCheckbox("#nrn_enabled", "enabled", (v) => {
        if (v) {
            refresh();
        } else if ($widget) {
            $widget.detach();
        }
    });

    bindCheckbox("#nrn_inject", "inject", () => injectPrompt());
    bindCheckbox("#nrn_calendar_hints", "calendarHints", () => injectPrompt());

    /* Праздники: показ, слои и край света. Каждая правка перетряхивает и
       панель, и инжект — праздник виден в обоих, и разъехаться им нельзя. */
    const feastsChanged = () => { injectPrompt(); refresh(); };
    bindCheckbox("#nrn_holidays", "holidays", feastsChanged);

    for (const tier of HOLIDAY_TIERS) {
        const $box = $(`#nrn_holiday_${tier.id}`);
        $box.prop("checked", (settings().holidayTiers ?? DEFAULT_TIERS).includes(tier.id));
        $box.on("input", function () {
            const on = Boolean($(this).prop("checked"));
            const kept = (settings().holidayTiers ?? DEFAULT_TIERS).filter((id) => id !== tier.id);
            /* Порядок слоёв держим по таблице, а не по тому, в каком порядке
               их щёлкали: от него зависит старшинство праздников в один день. */
            settings().holidayTiers = HOLIDAY_TIERS
                .map((t) => t.id)
                .filter((id) => (id === tier.id ? on : kept.includes(id)));
            saveSettingsDebounced();
            feastsChanged();
        });
    }

    const regionSel = $("#nrn_holiday_region");
    regionSel.val(settings().holidayRegion || "all");
    regionSel.on("input", function () {
        settings().holidayRegion = String($(this).val());
        saveSettingsDebounced();
        feastsChanged();
    });

    bindCheckbox("#nrn_body", "bodyTracking", () => { injectPrompt(); refresh(); });

    /* Раскладки и темы здесь нет: оформление живёт в Tímatal, рядом с
       полем правки CSS — см. раздел 7a. */

    bindCheckbox("#nrn_debug_markers", "debugKeepMarkers", () => refresh());

    $("#nrn_purge_markers").on("click", () => {
        const context = getContext();
        const n = syncWholeChat(context?.chat, { keepMarker: false });
        if (n && typeof context?.saveChat === "function") {
            try { context.saveChat(); } catch (e) {
                console.error(`[${extensionName}] не удалось сохранить чат после чистки:`, e);
            }
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

    /* Стили новой раскладки — до правок пользователя: те должны лежать в
       <head> последними, иначе файл перебивал бы их при равном весе. */
    loadSkinCss();

    /* Правки CSS подкладываем до сборки виджета: иначе на первый кадр
       блок вспыхнул бы нашими цветами и только потом перекрасился. */
    applyUserCss();

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

    injectPrompt();
    eventSource.on(event_types.GENERATION_STARTED, injectPrompt);

    // Чат мог набрать маркеры, пока расширение было выключено. Разбираем их
    // в extra и вырезаем из текста — молча, один раз на чат.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        forgetChat();
        /* Новый чат — новая дата и новое тело. Сравнивать нынешний ход
           с ходом из прошлой истории нельзя, поэтому слепок забываем. */
        forgetWatch();
        const context = getContext();
        if (!chatHasRawMarkers(context?.chat)) return;
        const n = syncWholeChat(context?.chat, { keepMarker: settings().debugKeepMarkers });
        if (n && typeof context?.saveChat === "function") {
            try { context.saveChat(); } catch (e) {
                console.error(`[${extensionName}] не удалось сохранить разобранный чат:`, e);
            }
        }
        forgetChat();
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
