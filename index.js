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
import { buildReference, SECTION_IDS, COLUMN_KEYS, isPermanent } from "./reference.js";

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
    herbAnchor,
    labourAnchor,
    pregnancyAnchor,
    readChat,
    setSceneDate,
    syncWholeChat,
} from "./chat-state.js";

import { CYCLE_DEFAULT, DIVINATION_ACCURACY, bodyView, pregnancyTerm } from "./body.js";

import { DEFAULT_TIERS, HOLIDAY_TIERS, holidayView, markWeek } from "./holidays.js";

import { DEFAULT_NOTICES, NOTICE_IDS, noticesBetween, watchSnapshot } from "./notify.js";

const extensionName = "NORNIR";
const extensionFolderName = `third-party/${extensionName}`;

/* По умолчанию в Tímatal открыты только Эйкты: с телефона незачем листать
   весь справочник, а нужный раздел разворачивается одним касанием. */
const DEFAULT_CLOSED_SECTIONS = ["month", "vika", "week", "moon", "feast", "block", "notify", "css"];

/* Постоянные колонки (номер и др.-сканд. написание) здесь не перечисляются —
   они всегда на месте. Русский включён, чтобы при первом открытии сразу было
   видно, что есть что; остальное добирается облачками. */
const DEFAULT_VISIBLE_COLUMNS = ["ru"];

const defaultSettings = {
    enabled: true,
    inject: true,
    theme: "default",
    /*
     * Раскладка и цвет — две разные настройки.
     *
     * skin решает, КАК стоит блок: «board» — доска-картинка с книгой,
     * «flat» — прежняя плоская вёрстка колонками. theme решает, КАКОГО
     * ОН ЦВЕТА, и работает в обеих раскладках. Разметка при этом одна:
     * лишнее в каждой раскладке спрятано стилями, а не пересобрано.
     */
    skin: "board",
    /* Какой лист разворота открыт. Нить Фрейи первой не по алфавиту:
       ради неё расширение и писалось. */
    activeTab: "freyja",
    timatalClosedSections: DEFAULT_CLOSED_SECTIONS,
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
    bodyDebug: false,
    herbDeath: false,
    divinationAccuracy: 0.6,
    conceptionChances: null,
    debugKeepMarkers: false,
};

/** Настройки расширения (после loadSettings всегда заполнены). */
function settings() {
    return extension_settings[extensionName];
}
/* ============================================================
 * 2. PROMPT
 *
 * ВНИМАНИЕ: этот текст проверен в живой ролевой, и менять его «на глаз»
 * нельзя. Один раз так уже сделали.
 *
 * Что здесь есть и почему:
 *
 *  - маркер ставится в КОНЦЕ ответа. Требование «перед прозой» думающие модели
 *    роняют первыми: они сначала планируют текст, а служебный блок до текста
 *    в план не попадает. Виджету это безразлично — он вставляет себя в начало
 *    сообщения через DOM;
 *  - объясняется, что это HTML-комментарий и читателю он не виден: иначе
 *    RP-пресеты «не выходи из роли» его подавляют;
 *  - есть прямая оговорка, что требование сильнее запретов на OOC, и что ответ
 *    без маркера считается некорректным;
 *  - отдельный абзац про думалку: синтаксис маркера нельзя писать внутри
 *    рассуждений. Формулировку один раз попробовали ужесточить — «ни скобку,
 *    ни заполненные поля», потому что модель соблюдала букву и перечисляла
 *    значения без скобки. Стало хуже: из шести прогонов в трёх она выписала
 *    маркер целиком, со скобкой, чего до ужесточения не делала ни разу.
 *    Названный запретный токен становится заметнее — здесь это проверено
 *    на живых прогонах, а не выведено из общих соображений;
 *  - при месяцах стоят григорианские номера — готовая таблица перевода
 *    для современных сцен;
 *  - есть заполненный пример. Схема с <плейсхолдерами> показывает форму, но не
 *    показывает ни одного значения, и модель сочиняет их в рассуждениях;
 *  - эталон состояния приходит инжектом (<norse_time>, <norse_body>,
 *    <norse_child>, <norse_scene>), а не из истории: старые маркеры из чата
 *    вырезаны, модели их взять неоткуда.
 *
 * История вопроса, чтобы не ходить по кругу.
 *
 * Этот блок один раз переписали целиком: сократили вчетверо, выкинули пример,
 * чек-лист, абзац про думалку и развёрнутые формулировки. Рассуждения были
 * стройные — «думающая модель исполняет чек-листы вслух», «лишний образец она
 * репетирует в думалке». На практике вышло наоборот: у пользователя поехала
 * думалка, модель начала писать в рассуждениях черновик прозы и расписывать
 * маркер по полям. Пришлось откатывать дословно.
 *
 * Мораль не в том, что короткий промпт хуже длинного, а в том, что здесь
 * теория ничего не стоит: единственное доказательство — прогон в живой
 * ролевой. Поэтому правила такие:
 *
 *  - меняем ОДНУ вещь за раз и каждую проверяем отдельно, иначе при регрессии
 *    непонятно, что откатывать (в прошлый раз в одном батче уехало полтора
 *    десятка правок, и на разбор ушло три круга);
 *  - формулировки собираем из MONTHS и прочих таблиц, чтобы промпт не
 *    разъезжался с парсером, но текст вокруг них не трогаем;
 *  - «улучшения», которые нельзя проверить, не делаем вовсе.
 * ============================================================ */

/* ── Блоки промпта ───────────────────────────────────────────────────────
 *
 * Каждый блок отвечает за одну тему и собирается отдельно. Так видно, во что
 * обходится новое поле, и так блок можно выключить целиком, не разбирая
 * остальной текст: модуль тела добавит свой блок и одно поле в маркер, ничего
 * вокруг не трогая.
 *
 * Объясняем только то, чего модель не угадает: эйкты и древнеисландский календарь.
 * Локация, погода и одежда пояснений не требуют — там одна строка про то, что
 * писать, и всё. Лишнее объяснение модель репетирует вслух наравне с нужным.
 *
 * Раскладка внутри блока: определение поля и строка, которую модель за него
 * отдаёт, стоят вплотную, через «→». Раньше список полей лежал ТРИЖДЫ —
 * определения здесь, плейсхолдеры в шаблоне маркера, значения в примере, —
 * и между первой копией и второй набегало до сотни строк. Связать их модель
 * могла только по имени поля, и то не всегда: в шаблоне и в определениях
 * плейсхолдеры были написаны разными словами. На восьми полях это сходило
 * с рук, на восемнадцати перестало: редкие поля (advice, char_state) выпадали,
 * а условные (midwife, faderni) заполнялись в обычный ход — в шаблоне маркера
 * они выглядели ровно так же, как обязательные.
 *
 * Копий теперь две: определения со стрелками и один заполненный пример.
 * Обязательность живёт в заголовке блока («every reply» / «while …» /
 * «only when …»), порядок чтения совпадает с порядком строк в блоке, а пример
 * собирается по тому же состоянию, что и сами блоки, — иначе он показывал бы
 * маркер без полей, которые тут же требуются каждый ход.
 * ──────────────────────────────────────────────────────────────────────── */

/* Заглавие канала и общий режим работы. Абзац про HTML-комментарий проверен
   в живой ролевой и переписыванию не подлежит: без него RP-пресеты «не выходи
   из роли» маркер подавляют. */
const BLOCK_HEADER = [
    "<norse_calendar>",
    "[SYSTEM CHANNEL — NORNIR. This configures a UI panel and stands outside the fiction. Characters cannot perceive it, and nothing written here happens in the scene.]",
    "",
    "Alongside the roleplay you keep a calendar panel up to date for the reader. It refreshes from a single hidden block that you place after your prose, every single time.",
    "Wrapped in <!-- and -->, the block is a comment: the chat renders nothing for it, so not one word of it reaches the reader. Treat it as machine-readable output that sits apart from the narrative — do not restate its contents in prose and do not turn it into a visible status header.",
    "",
    /* Главная строка всей перестройки. Любое число, посчитанное моделью,
       она считает вслух в рассуждениях — и в каждом свайпе по-своему.
       Раньше строка отсылала за посчитанным к общему блоку состояния — то есть
       к блоку, в котором ничего посчитанного и нет: день, луна и срок приезжают
       в <norse_time> и <norse_body>. */
    "Report what the scene shows. Never work anything out: days, dates, counts, terms and the child's age are the panel's own reckoning, and it hands them to you in <norse_time>, <norse_body> and <norse_child>.",
    /* Прежний абсолютный запрет «never work anything out» накрывал и те поля,
       которые без домысла не заполнить вовсе: мысль, совет, положение дитяти
       по закону. Разводим их явно, иначе правило либо ослабнет целиком, либо
       сломает половину полей. */
    "Two lines are yours to judge rather than observe — thought and advice — and one is yours to reason from law, not from arithmetic: child_rank. Everything else is reporting.",
    "",
    /* Раскладка v4: определение поля и строка вывода стоят вплотную, стрелка их
       и связывает. Абзац объясняет саму раскладку — без него «→» читается как
       часть значения и уезжает в маркер. */
    "The block is gathered part by part. Each part below first says what it wants, then shows the line it contributes, marked with →. The arrow is not part of the line; read the parts in order and you have the block.",
    "A part headed «while …» or «only when …» contributes nothing until its case comes up: no line at all, not an empty one.",
    "",
];

/* Английские подписи к эйктам оставлены: без них модель гадает, что такое
   «ундорн», и гадает вслух. Восемь строк списком свёрнуты в две — содержание
   то же, места вчетверо меньше. */
/* Таблица эйкт переехала в <norse_time>: там она читается как устройство мира,
   а не как ещё одно требование трекера. Здесь остаётся одна строка. */
const BLOCK_TIME = [
    "[TIME — every reply]",
    "eykt — which of the eight the scene stands in.",
    "→ eykt: <the eykt this scene stands in>",
    "",
];

/* Пропуск времени уехал из [TIME] в свой блок: поле условное, а стояло вторым
   среди обязательных — и заполнялось в обычный ход. Заодно порядок чтения
   сошёлся с порядком в маркере, где passed идёт после advice. */
const BLOCK_SKIP = [
    "[SKIPS — only when the story jumps ahead]",
    "passed — how much time went by, as a plain amount: «2 дня», «три месяца», «полгода». Never a date. On an ordinary turn there is no such line.",
    "→ passed: <the length of the skip>",
    "",
];

/*
 * Блока [DATE] здесь больше нет, и это самая крупная правка за всю отладку.
 *
 * Дата была единственным полем маркера, которое модель не наблюдала в сцене,
 * а ВЫЧИСЛЯЛА: переводила современный месяц в древнеисландский, спорила сама с собой,
 * сольмануд это июль или сентябрь, и делала это вслух — по-разному в каждом
 * свайпе. Полтабличных 472 символа объяснений уходили только на то, чтобы она
 * могла посчитать то, что мы и так знаем.
 *
 * Теперь дату ставит пользователь через Tímatal, расширение везёт её вперёд
 * и перелистывает по смене эйкты, а модели она приезжает готовой строкой
 * в <norse_time> — чтобы персонажи могли на неё ссылаться в речи.
 */

/* Погода перед локацией: в маркере они стоят так же, и порядок чтения теперь
   совпадает с порядком сборки. */
const BLOCK_PLACE = [
    "[PLACE — every reply]",
    "weather — what the sky and the air are doing.",
    "→ weather: <the sky and the air>",
    "",
    "location — where the scene stands, as precisely as the prose allows.",
    "→ location: <where the scene stands>",
    "",
];

/*
 * Блок тела — единственный, который включается настройкой.
 *
 * Спрашиваем событие, а не состояние. Полный статус каждый ход («фертильность,
 * либидо, самочувствие») модели неоткуда взять, и она его сочиняет: у
 * пользователя в соседних свайпах на один и тот же день выходило «Высокая»,
 * «Норма» и «low». Событие же она видит в сцене и врать ей незачем.
 *
 * В обычный ход строки нет вовсе — это самый частый случай и самый дешёвый.
 */
const BLOCK_BODY = [
    "[BODY — only when something happens to {{user}}'s body]",
    "body — what happened, in these words exactly:",
    "  кровь пришла · кровь кончилась · кровь не в срок",
    "  семя пролилось · семя не пролилось",
    /* «дитя бьётся» и «дитя затихло» здесь появились не для красоты: без них
       счётчик тишины было не от чего вести, и вся тревога о дитяти оставалась
       кодом, до которого нельзя добраться. Движок их понимал с самого начала —
       не понимал промпт. */
    "  дитя шевельнулось · дитя бьётся · дитя затихло",
    "  схватки начались · родила · выкидыш",
    "  дитя у груди · отняли от груди · поняла, что тяжела · понесла",
    "  голодала · хворала · была в дороге · извелась",
    /* Тяготы. Панель по ним считает угрозу утробе — поэтому слова нужны
       точные: догадка по вольному описанию стоила бы ребёнка. */
    "  подняла тяжёлое · надорвалась · упала · побили · легла пластом",
    "  дитя родилось мёртвым",
    /* Вехи первых двух лет. Возраст и нужды дитяти панель считает сама —
       у модели спрашиваются только те четыре вещи, которых из календаря
       не выведешь. */
    "  зубок прорезался · дитя пошло · дитя заговорило",
    "  дитя занемогло · дитя поправилось · дитя померло",
    "Two things in one scene: separate with \"; \". Nothing happened — no line, and that is the ordinary turn. The panel counts the days itself.",
    "→ body: <words from the list above>",
    "",
    "sex — the scene held coupling.",
    "→ sex: да",
    "",
    "internal — whether the seed was spilled inside. Only ever alongside sex.",
    "→ internal: <да / нет / неизвестно>",
    "",
    "Состояние утробы известно только рассказчику. Персонажи не знают о беременности и не упоминают её, пока героиня не объявит об этом сама. Симптомы (тошнота, слабость, отвращение к запахам) могут быть замечены окружающими, но истолкованы как хворь, усталость или порча — не как беременность.",
    "Задержка тидир сама по себе ничего не доказывает: её приносят и голод, и дорога, и тревога. Пока строка состояния не назвала срок, догадку о дитяти оставь героине — сама она может гадать, сомневаться и отмахиваться, но подтверждать за неё нельзя.",
    "",
];

const BLOCK_PEOPLE = [
    "[PEOPLE — every reply]",
    "mood — {{char}}'s mood right now.",
    "→ mood: <{{char}}'s mood>",
    "",
    "user_attire — what {{user}} is wearing, as the scene last showed it.",
    "→ user_attire: <{{user}}'s clothing>",
    "",
    "char_attire — what {{char}} is wearing.",
    "→ char_attire: <{{char}}'s clothing>",
    "",
    "thought — one thing {{char}} thinks about {{user}} and does not say aloud.",
    "→ thought: <the unspoken thought>",
    "",
    /* Состояние тела пишет модель, а не таблица: «продрог у брода» она видит
       в сцене, а расширение — нет. Три-пять слов, иначе выйдет второй thought. */
    "char_state — how {{char}}'s body fares right now: tired, cold, aching, hale. Three to five words, no more.",
    "→ char_state: <{{char}}'s body, 3-5 words>",
    "",
    "user_state — the same for {{user}}, from what the scene shows.",
    "→ user_state: <{{user}}'s body, 3-5 words>",
    "",
    /* Совет — единственное поле, где легко проскочить анахронизм. */
    "advice — what a wise woman of this age would tell {{user}} right now. Look both at what she is doing in the scene and at how her body fares: chopping wood while heavy with child earns a word about resting. Speak in the remedies of the age — отвар, покой, тёплое питьё, не подымать тяжёлого, натопить баню. Nothing from later ages: no medicines, no doctors, no measured hours of sleep.",
    "→ advice: <a word of counsel fit for the age>",
    "",
];

/*
 * Блоки, которые появляются только к месту.
 *
 * Готовность к родам нужна на последней части ношения, правовой слой — когда
 * о дитяти уже знают, имя и обряд — после родов. Спрашивать их с первого дня
 * игры значило бы держать в маркере восемь пустых строк каждый ход.
 *
 * Формат везде жёсткий: имена и числа, два-пять слов, «нет» вместо описания.
 * Без этого модель начинает сочинять абзацы там, где нужно одно слово.
 */
const BLOCK_BIRTH = [
    "[BIRTH WATCH — every reply while the birth is near]",
    "Answer in names and numbers, not in sentences. Two to five words each, no description, no reasoning.",
    "midwife — who will take the child, and how far off: «Арнхейд, полдня пути». Никого поблизости — «нет».",
    "→ midwife: <name and distance>",
    "",
    "women — how many grown women are in the house: «три», «одна», «нет».",
    "→ women: <how many>",
    "",
    "charms — what wards she has on her: «молот Тора у горла», «бьяргруны не вырезаны».",
    "→ charms: <the wards, or нет>",
    "",
    "gear — water, swaddling, fire: «вода и пелёнки готовы», «пелёнок нет».",
    "→ gear: <what is ready, what is not>",
    "",
];

const BLOCK_LEGAL = [
    "[THE CHILD'S STANDING — every reply while the child is known]",
    "faderni — whether the father has acknowledged the child. One word only.",
    "→ faderni: <признано / не признано / оспорено>",
    "",
    "child_rank — what the child will be born as, by the law of this age: скирборинн (born in wedlock), фриллуборинн (of a concubine), тюборинн (of a bondwoman, and a bondman himself), хорнунг (of a free woman out of wedlock). One word only.",
    "→ child_rank: <one of those four>",
    "",
];

/*
 * Имя спрашиваем, пока дитя без имени, а не «после родов».
 *
 * Раньше блок висел на послеродовом состоянии матери. Оно кончается, когда
 * дитя отняли от груди, — а безымянным дитя может остаться и дольше, и тогда
 * спросить имя было уже негде.
 */
const BLOCK_NAMING = [
    "[NAMING — every reply while the child has no name yet]",
    "child_name — the name given at the water-sprinkling. Twins: both names, separated by \"; \".",
    "→ child_name: <the name, or не наречён>",
    "",
];

/*
 * Сборка блока — без третьей копии списка полей.
 *
 * Раньше здесь стоял полный шаблон с плейсхолдерами, и список полей лежал
 * в промпте ТРИЖДЫ: определения выше, шаблон тут, значения в примере. Причём
 * плейсхолдеры в шаблоне и в определениях были написаны разными словами
 * («eykt: <current eykt>» против «→ eykt: <the eykt this scene stands in>»),
 * так что связать три копии модель могла только по имени поля.
 *
 * Хуже цены было противоречие. Шапка говорит: строки условного блока нет вовсе,
 * пока не настал её случай. Шаблон показывал passed, body, sex и internal
 * ровным списком внутри маркера — то есть ровно наоборот. Отсюда и брались
 * условные поля в обычный ход.
 *
 * Теперь копий две: определения со стрелками и один заполненный пример,
 * который собирается по тому же состоянию, что и блоки.
 */
const BLOCK_ASSEMBLY = [
    "[THE BLOCK — the last thing in every reply, after all the prose]",
    "Put the lines you gathered, in the order they were given, into one comment:",
    "",
    "<!-- [URD:",
    "… the lines you gathered, one per line …",
    "] -->",
    "",
    /* Прежняя формулировка называла запретную последовательность буквально.
       На этом проекте уже проверено на живых прогонах, что названный запретный
       токен модель начинает выписывать именно там, где его запретили, — так
       что здесь требование положительное. */
    "Write all field values in Russian, as plain words and punctuation: no HTML, no angle brackets, no markup of any kind.",
    "",
];

/* Строки примера, которые появляются только вместе со своим блоком. */
const EXAMPLE_BIRTH_LINES = [
    "midwife: Арнхейд, полдня пути",
    "women: три",
    "charms: молот Тора у горла",
    "gear: вода и пелёнки готовы, пелёнок мало",
];
const EXAMPLE_LEGAL_LINES = [
    "faderni: признано",
    "child_rank: скирборинн",
];
const EXAMPLE_NAMING_LINES = [
    "child_name: Хельга",
];

/* Обязательная часть — она же весь обычный ход. */
const EXAMPLE_BASE_LINES = [
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
];

/**
 * Единственный пример — и он обязан совпадать с тем, что сейчас требуется.
 *
 * Схема с <плейсхолдерами> показывает форму, но ни одного значения, и тогда
 * модель сочиняет их в рассуждениях. Поэтому пример заполненный.
 *
 * Собирается по состоянию, и это не украшательство. Пример был константой,
 * а блоки [BIRTH WATCH], [THE CHILD'S STANDING] и [NAMING] помечены «every
 * reply while …». Выходило, что единственный образец в промпте показывал
 * маркер БЕЗ полей, которые тут же требовались каждый ход, — а заполненный
 * образец весит больше инструкции. Оттуда и пропадали имя и фадерни.
 *
 * Второго примера не ставим: лишний образец модель репетирует целиком.
 */
function exampleBlock({ withBody, nearBirth, known, born, unnamed }) {
    const lines = [
        ...EXAMPLE_BASE_LINES,
        ...(nearBirth ? EXAMPLE_BIRTH_LINES : []),
        ...(known || born ? EXAMPLE_LEGAL_LINES : []),
        ...(unnamed ? EXAMPLE_NAMING_LINES : []),
    ];
    return [
        "EXAMPLE (end of an ordinary reply):",
        "…и он опустил точильный камень, не отводя от неё взгляда.",
        "",
        "<!-- [URD:",
        ...lines,
        "] -->",
        "",
        /* Без этой строки пример читается как полный список: раз в образце нет
           passed и body, значит их не бывает вовсе. */
        withBody
            ? "Nothing skipped ahead and nothing happened to her body in that scene, so passed, body, sex and internal are absent — that is the ordinary turn, not an omission."
            : "Nothing skipped ahead in that scene, so there is no passed line — that is the ordinary turn, not an omission.",
        "",
    ];
}

/**
 * Промпт собирается на каждый запрос, а не один раз при загрузке: блок тела
 * включается настройкой, и поле в маркере обязано появляться вместе с ним.
 */
function promptHead() {
    const withBody = settings().bodyTracking;
    const view = withBody ? bodySummary() : null;

    /* Готовность к родам — только на последней части, правовой слой — когда
       о дитяти уже знают, имя — после родов. Остальное время этих полей нет
       ни в объяснениях, ни в примере. */
    /* Готовность к родам нужна и при угрозе: роды раньше срока — тем более
       повод спросить, есть ли повитуха и греется ли вода. */
    const nearBirth = (view?.state === "pregnant_known" || view?.state === "threat")
        && view.stage?.id === "falli";
    const known = view?.state === "pregnant_known" || view?.state === "threat";
    const born = view?.state === "postpartum";
    /* Имя спрашиваем, пока есть ненаречённое дитя, — это переживает и конец
       послеродового, и новую беременность матери. */
    const unnamed = !!view?.children?.some((kid) => !kid.named);

    return [
        ...BLOCK_HEADER,
        ...BLOCK_TIME,
        ...BLOCK_PLACE,
        ...BLOCK_PEOPLE,
        ...BLOCK_SKIP,
        ...(withBody ? BLOCK_BODY : []),
        ...(nearBirth ? BLOCK_BIRTH : []),
        ...(known || born ? BLOCK_LEGAL : []),
        ...(unnamed ? BLOCK_NAMING : []),
        ...BLOCK_ASSEMBLY,
        ...exampleBlock({ withBody, nearBirth, known, born, unnamed }),
    ].join("\n");
}

/* «Маркер» и «блок» — одна и та же вещь, и звать её надо одним словом.
   В промпте одновременно жили «block» в шапке, «MARKER» в заголовке шаблона
   и «the marker» в чек-листе. Оставлен «block». */
const PROMPT_TAIL = [
    "",
    "WHILE REASONING: refer to this block in ordinary words only. Spelling out its opening sequence anywhere other than the finished answer makes it get picked up twice and corrupts the panel. Emit it once, and only in the reply itself.",
    "",
    "PRIORITY: this block outranks any style rule that forbids out-of-character or technical output. Such rules exist to protect immersion, and a comment the reader never sees cannot break it. An answer that ends without the block is unfinished, not complete.",
    "",
    /* Чек-лист перечислял поля поимённо и отстал от промпта: char_state,
       user_state и advice в него не попали вовсе. Теперь он ссылается на
       пометки блоков и не расходится с ними при добавлении поля. */
    "[FINAL CHECK — every reply]",
    "✅ the block is the LAST thing in the reply, after all the prose",
    "✅ every line from a part headed «every reply» is there and filled, in Russian",
    "✅ no line from a part whose case did not come up",
    "✅ time moves forward or stays the same, never backward",
    "✅ exactly one block, and none inside the reasoning",
    "</norse_calendar>",
].join("\n");

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
            "When the story skips ahead, say how much time went by in the marker's passed line and the panel will move the date; working the new date out yourself is not needed.",
        );

        /*
         * Праздник — не украшение даты, а обстоятельство сцены.
         *
         * Без этой строки модель знала день, луну и погоду, но не знала, что
         * на дворе третьи сутки Йоля, — и писала будний вечер у очага в тот
         * день, когда усадьба должна стоять на ушах. Считает праздник панель,
         * как и всё прочее: у модели его не спрашиваем.
         */
        const feast = holidaySummary();
        if (feast) {
            const which = feast.days > 1
                ? ` This is day ${feast.day} of ${feast.days}${feast.first ? ", the first" : feast.last ? ", the last" : ""}.`
                : "";
            const along = feast.others.length
                ? ` The same days carry ${feast.others.map((o) => o.norse).join(" and ")} — kept alongside it, not instead of it.`
                : "";
            out.push(
                "",
                `A feast stands on this day: ${feast.norse} — ${feast.ru}.${which}${along}`,
                feast.gloss,
                "Let it show in the scene as people of the time would live it — in the work that stops, the food, the drink, the guests, what is owed and what is forbidden. Do not announce it as a label.",
            );
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
        chatId: getContext()?.chatId,
        chances: settings().conceptionChances,
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
 * и промпт, и три места в отрисовке.
 */
function bodySummary() {
    if (!settings().bodyTracking) return null;
    const read = readState();
    if (read.view !== undefined) return read.view;

    const date = sceneDate();
    read.view = date && read.body
        ? bodyView(read.body, date, {
            accuracy: settings().divinationAccuracy ?? DIVINATION_ACCURACY,
            debug: settings().bodyDebug,
            /* Погоду панель и так знает из маркера — приметы по жаре и морозу
               считаются даром. Раньше сюда её просто забывали передать, и вся
               ветка weatherToll() не работала ни разу. */
            weather: read.state?.weather ?? null,
            /* Время суток и день недели — для нужд дитяти: ночью оно спит,
               а в лаугардаг его моют. Календарь это и так знает, спрашивать
               у модели незачем. */
            eykt: read.state?.hour != null ? eyktForHour(read.state.hour) : null,
            weekday: weekdayOf(date.year, date.month, date.day),
        })
        : null;
    return read.view;
}

/** Строка про тело для промпта — обычными словами, без цифр и латиницы. */
function bodyPhrase() {
    return bodySummary()?.phrase ?? null;
}

/**
 * Что Tímatal показывает и умеет про тело.
 *
 * Возвращаем null, когда отслеживание выключено или дата ещё не поставлена:
 * без даты считать не от чего, и пустой блок в справочнике только мешает.
 */
function cycleControls(repaint = () => {}) {
    if (!settings().bodyTracking) return null;
    const today = sceneDate();
    if (!today) return null;

    const body = readState().body;

    /* Записали — сразу перерисовали панель и пересобрали инжект. Без второго
       модель до следующего хода жила бы со старой строкой состояния. */
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
        known: !!body?.pregnancy?.knownSince,
        father: body?.pregnancy?.father ?? null,
        conceived: body?.pregnancy?.conceived ?? null,
        births: body?.pregnancy?.births ?? 1,
        /* Пол показываем как выбор только если он у всех одинаков: смешанную
           двойню одним списком не выразить, и врать про неё не станем. */
        sex: sameSex(body?.pregnancy),
        onSetDay: (day) => done(cycleAnchor(today, day)),
        onSetPregnancy: (setup) => done(pregnancyAnchor(today, setup, body?.pregnancy ?? null, {
            chatId: getContext()?.chatId,
        })),
        /* Призыв Фригг доступен, только когда есть кого рожать. */
        canSummon: !!body?.pregnancy && !body.pregnancy.labour,
        onSummonFrigg: () => done(labourAnchor(today, body?.pregnancy ?? null)),
        /* Женское питьё — всегда: героиня не знает, есть ли кого прерывать,
           и кнопка, доступная только беременным, выдала бы ей это с головой. */
        onDrinkHerb: () => done(herbAnchor(today, body, {
            chatId: getContext()?.chatId,
            death: !!settings().herbDeath,
        })),
    };
}

/** Общий пол всех детей, либо null — если разный или неизвестен. */
function sameSex(pregnancy) {
    const sexes = pregnancy?.sexes ?? (pregnancy?.sex ? [pregnancy.sex] : null);
    if (!sexes?.length) return null;
    return sexes.every((s) => s === sexes[0]) ? sexes[0] : null;
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
 * последним перед ответом идёт чек-лист, а не второй набор заполненных полей.
 */
function buildPrompt() {
    return timeContext() + bodyContext() + childContext() + sceneContext() + promptHead() + PROMPT_TAIL;
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
 */
function bodyContext() {
    const phrase = bodyPhrase();
    if (!phrase) return "";

    const view = bodySummary();
    const out = ["<norse_body>", phrase];

    /* Заметное со стороны называем прямо: иначе персонажи ведут себя так,
       будто перед ними прежняя женщина. */
    if (view?.state === "pregnant_known") {
        out.push("Это видно всякому, кто на неё смотрит, и все вокруг это давно заметили. Тело тяжелеет, походка меняется, прежняя одежда не сходится.");
    } else if (view?.state === "postpartum") {
        out.push("Она недавно родила, и в доме это знают все.");
    }

    /*
     * Три случая, где мягкой справки мало.
     *
     * Обычно этот блок только рассказывает, а решает сцена. Но схватки, угроза
     * и свежая потеря — это то, что уже случилось с телом, и обходить их сцена
     * не вправе: иначе панель показывает роды, а в прозе героиня идёт за
     * дровами. Поэтому здесь блок говорит прямо, что происходит СЕЙЧАС.
     */
    if (view?.labour) {
        out.push(view.labour.days <= 0
            ? "СХВАТКИ НАЧАЛИСЬ ПРЯМО СЕЙЧАС, в этой самой сцене. Что бы ни происходило вокруг — боль пришла, воды близко, дитя идёт. Это уже случилось: не «может начаться», а началось. Пиши эту сцену от того, что роды идут."
            : "Роды идут. Она рожает, и всё остальное подождёт.");
        out.push("Когда дитя родится, поставь в блоке «родила». Если родилось мёртвым — «дитя родилось мёртвым».");
    } else if (view?.state === "threat") {
        out.push(view.title === "Утроба в беде"
            ? "УТРОБА В БЕДЕ ПРЯМО СЕЙЧАС. Тянет низ живота, мажет кровью — это происходит в этой сцене, а не грозит когда-нибудь. Дитя может не удержаться."
            : "СХВАТКИ ИДУТ РАНЬШЕ СРОКА, прямо в этой сцене. Утроба каменеет часто и больно.");
        out.push("Если героиня ляжет пластом и не встанет — поставь в блоке «легла пластом». Это единственное, чем тут можно помочь, и помогает оно не всегда.");
    } else if (view?.state === "loss") {
        out.push("Это случилось только что и по-настоящему. Не отыгрывай назад, не смягчай и не оставляй дитя живым.");
    }

    /*
     * Отвар. Модели даётся только то, что видит сама героиня и дом вокруг:
     * какую траву пила, откуда взяла и что с ней теперь.
     *
     * Чего НЕ даётся — было ли что прерывать. Об этом не знает и она сама:
     * на малом сроке о дитяти не знают, знают, что кровь не приходит. Связывать
     * питьё с беременностью в сцене нельзя никому.
     */
    if (view?.draught) out.push(...draughtLines(view.draught));

    out.push("</norse_body>", "");
    return out.join("\n");
}

/**
 * Строки об отваре для модели.
 *
 * В день приёма — сам факт: что выпила и что это была за трава. Дальше —
 * только откат, потому что пить она больше не пьёт, а мутит её по-прежнему.
 *
 * Источник отвара нарочно не назван. Кухня, старуха, торговка, соседка —
 * это выбирает сцена по тому, кто у неё под рукой; движку тут решать нечего.
 */
function draughtLines(draught) {
    const out = [];
    if (draught.age === 0) {
        out.push(`{{user}} выпила женское питьё — отвар, возвращающий кровь: ${draught.herb.say}. Это случилось в этой сцене.`);
        out.push("Такой отвар в этом веке берут у той, кто под рукой: у стряпух, у старухи, у заезжей торговки. Кто дал его — реши по сцене.");
        out.push("Никто не говорит вслух о дитяти и не связывает питьё с ним. Это трава, возвращающая тидир, — так о ней и думают, и так о ней и говорят.");
    } else {
        out.push(`{{user}} пила женское питьё ${draught.age} ${draught.age === 1 ? "день" : "дня"} назад.`);
    }

    out.push(`Тело отвечает: ${draught.status} ${draught.hint}`);
    if (draught.lingering) {
        out.push("Отвар давно выпит, а тело не отпускает. Это видно всем в доме.");
    }
    if (draught.fatal) {
        out.push("ЭТОТ ОТВАР ЕЁ УБИВАЕТ. Отрава взяла своё: жар не спадает, судороги идут одна за другой, силы уходят. Спасти её нечем — этого не умеют. Пиши это как есть.");
    }
    return out;
}

/**
 * Что с дитятей — отдельной справкой, рядом со временем и телом.
 *
 * По той же причине, по которой отсюда уехали дата и тело: внутри блока
 * трекера всё читается как поле для заполнения, а возраст дитяти и его нужда —
 * не поля, а обстановка сцены. Модель их не сообщает, она их видит.
 *
 * Возраст и нужду считает панель. У модели спрашиваются только вехи — зубок,
 * первые шаги, первое слово, хворь, — потому что их из календаря не выведешь.
 */
function childContext() {
    const kids = bodySummary()?.children;
    if (!kids?.length) return "";

    const out = ["<norse_child>"];
    for (const kid of kids) {
        out.push(`${kid.title}, ${kid.age}. ${kid.stage.hint} Сейчас: ${kid.need}.`);
        for (const mark of kid.marks) out.push(mark + ".");
    }
    out.push(
        "Дитя не говорит и не рассуждает: оно кричит, тянется, засыпает. Взрослые понимают его по крику и по тому, как оно берёт грудь.",
        "</norse_child>",
        "",
    );
    return out.join("\n");
}

/**
 * Инжектит инструкцию в промпт — в два слота.
 *
 * Основной слот: IN_CHAT на нулевой глубине с ролью SYSTEM.
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
 * Запасной слот: IN_PROMPT, чтобы инструкция была видна и через prompt-manager.
 * Ключи обязаны различаться — на один ключ setExtensionPrompt хранит ровно
 * одну запись, и второй вызов затёр бы первый.
 *
 * Второй слот шлёт модели тот же текст повторно, и убрать его напрашивается.
 * Один раз это уже сделали — и зря: слот был на месте в конфигурации, которая
 * у пользователя работала, так что его удаление относится к «улучшениям без
 * подтверждения». Трогать только вместе с проверкой в живой ролевой.
 */
function injectPrompt() {
    const context = getContext();
    if (!context || typeof context.setExtensionPrompt !== "function") return;

    /* Инжект собирается перед генерацией, то есть после того, как чат уже
       мог измениться. Открываем свой такт чтения, а не берём чужой. */
    forgetChat();

    const chatKey = extensionName;
    const sysKey = `${extensionName}_sys`;
    const value = settings()?.inject ? buildPrompt() : "";

    context.setExtensionPrompt(chatKey, value, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
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
    midwife: null, women: null, charms: null, gear: null,
    faderni: null, childRank: null, childName: null,
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

function refresh() {
    forgetChat();
    const context = getContext();
    const read = readState();

    Object.assign(state, EMPTY_STATE, read.state ?? {});
    /* Сказанное однажды приезжает не из снимка, а из общего счёта: модель
       называет имя дитяти один раз, а панель обязана помнить его дальше. */
    Object.assign(state, read.told ?? {});

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
    if (label) row.append($("<span>", { "class": "nrn-fact-label", text: `${label}:` }));
    row.append(hint
        ? hintSpan(`fact-${label ?? iconName}`, value, hint).addClass("nrn-fact-value")
        : $("<span>", { "class": "nrn-fact-value", text: value }));
    return row;
}

/**
 * Чем дитя будет по закону этого века.
 *
 * Слова приходят от модели: их четыре, и они перечислены в блоке промпта
 * BLOCK_LEGAL. Здесь только перевод для подсказки — «хорнунг» само по себе
 * не говорит ничего даже тому, кто писал расширение.
 */
const CHILD_RANKS = {
    "скирборинн": "Рождён в браке — наследует по закону",
    "фриллуборинн": "Рождён от наложницы — признан, но не наравне с законными",
    "тюборинн": "Рождён от рабыни — и сам раб",
    "хорнунг": "Рождён от свободной женщины вне брака",
};

/** Подсказка к рангу дитяти, если слово узнано. */
function childRankHint(value) {
    return CHILD_RANKS[String(value ?? "").trim().toLowerCase()] ?? null;
}

/**
 * Род — чьё дитя и кем оно будет в роду.
 *
 * Отец, признание отцовства, ранг и имя — один вопрос, а не четыре. Раньше
 * отец стоял в панели пятой строкой, а фадерни с рангом — двенадцатой, между
 * оберегами и греющейся водой, хотя в этом веке именно они и решали судьбу
 * ребёнка: признанный сын наследует, непризнанный не наследует ничего.
 */
const KIN_FIELDS = [
    ["watch-faderni", "Фадерни", "faderni"],
    ["watch-rank", "Дитя будет", "childRank"],
    ["watch-name", "Имя", "childName"],
];

/** Дом — кто рядом и что наготове к родам. */
const HOUSE_FIELDS = [
    ["watch-midwife", "Льосмодир", "midwife"],
    ["watch-women", "Женщин в доме", "women"],
    ["watch-charms", "Обереги", "charms"],
    ["watch-gear", "Наготове", "gear"],
];

/** Кучка фактов под своим заголовком. Пустую не рисуем вовсе. */
function fillGroup(selector, title, rows) {
    const box = el(selector).empty();
    if (!rows.length) { box.hide(); return false; }
    box.append($("<div>", { "class": "nrn-group-title", text: title }), ...rows).show();
    return true;
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
        el("#nrn-eykt-name, #nrn-week, #nrn-date, #nrn-moon, #nrn-feast, #nrn-grid, #nrn-mood-chips, #nrn-children, #nrn-draught-name").empty();
        el("#nrn-sun, #nrn-eykt-num, #nrn-weather-value, #nrn-location-value").text("");
        const arc = el("#nrn-weather-text").find("textPath")[0];
        if (arc) arc.textContent = "";
        el("#nrn-attire-user-text, #nrn-attire-char-text, #nrn-thought-text, #nrn-cycle-text, #nrn-cycle-status, #nrn-cycle-kicks, #nrn-cycle-extra, #nrn-cycle-kin, #nrn-cycle-house, #nrn-cycle-signs, #nrn-cycle-debug, #nrn-char-state-text, #nrn-user-state-text, #nrn-advice-text").text("");
        el("#nrn-beam, #nrn-wood, #nrn-book").hide();
        el("#nrn-grid").addClass("nrn-hidden");
        stub.show();
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

/** Левая половина доски: эйкта, положение солнца, дата, день недели и Луна. */
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
        el("#nrn-eykt-num").text(t`eykt ${idx + 1}`);
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
 * Наше дело — подстраховка: если строки нет, берём слово повитухи по стадии,
 * чтобы совет был всегда, как и просили.
 */
function renderAdvice() {
    textRow("#nrn-advice", "#nrn-advice-text", state.advice || bodySummary()?.advice || null);
}

function renderCycle() {
    const row = el("#nrn-cycle");
    const s = bodySummary();
    if (!s) { row.hide(); el("#nrn-cycle-cols").hide(); return; }

    /* Две обязательные строки: где мы в счёте и что с телом. Обе кликабельны.
       Ещё две необязательные — приметы и гадание — появляются только когда
       героиня знает о дитяти. Что показывать, решено в bodyView(): здесь
       только раскладка, иначе панель и промпт разъедутся. */
    el("#nrn-cycle-text").empty().append(
        icon(s.icon),
        hintSpan("cyclePhase", s.title, s.titleHint),
        ...(s.count ? [plainSpan(` · ${s.count}`)] : []),
    );
    el("#nrn-cycle-status").empty().append(hintSpan("cycleStatus", s.status, s.statusHint));

    /* Шевеления — во всю ширину, сразу под словами о теле. Тревога висит на
       самой строке, а не на соседях: раньше затишье дитяти красило заодно и
       обереги, и имя, и число женщин в доме — восемь строк кричали об одном,
       и кричать переставало быть заметным. */
    const kicks = el("#nrn-cycle-kicks").empty();
    if (s.kicks) {
        kicks.append(
            factRow("watch-kicks", null, s.kicks.text).toggleClass("nrn-alarm", !!s.kicks.alarm),
        ).show();
    } else {
        kicks.hide();
    }

    const extra = el("#nrn-cycle-extra").empty();
    if (s.extra) extra.append(factRow(s.extraIcon, null, s.extra)).show(); else extra.hide();

    /* Род. Отец и гадание — двумя строками, не одной: признание отцовства
       это правовой факт, а толкование живота — присказка повитухи, и
       подсказка «гадание, а не знание» относится только ко второму. */
    const kin = [];
    if (s.father) kin.push(factRow("body-father", "Отец", s.father));
    if (s.guess) {
        kin.push($("<div>", { "class": "nrn-fact" }).append(
            icon("body-divination"),
            $("<span>", { "class": "nrn-fact-label", text: "Толкуют:" }),
            hintSpan("cycleGuess", s.guess, s.guessHint),
        ));
    }
    for (const [iconName, label, key] of KIN_FIELDS) {
        if (!state[key]) continue;
        /* Ранг дитяти — единственное поле рода, которое само по себе не
           читается: «хорнунг» ничего не говорит, пока не щёлкнешь. */
        kin.push(factRow(iconName, label, state[key],
            key === "childRank" ? childRankHint(state[key]) : null));
    }
    const hasKin = fillGroup("#nrn-cycle-kin", "Род", kin);

    const house = HOUSE_FIELDS
        .filter(([, , key]) => state[key])
        .map(([iconName, label, key]) => factRow(iconName, label, state[key]));
    const hasHouse = fillGroup("#nrn-cycle-house", "Дом", house);

    /* Приметы — по строке на примету, каждая со своим знаком. Вид приметы
       считает bodyView(): что грудь, что дурнота, что кровь — знать это
       раскладке неоткуда. Своим столбцом напротив рода и дома: к девятой
       части их набирается десяток, и в общем потоке они топили всё под собой. */
    const signs = el("#nrn-cycle-signs").empty();
    if (s.signs?.length) {
        for (const sign of s.signs) signs.append(factRow(`sign-${sign.kind}`, null, sign.text));
        signs.show();
    } else {
        signs.hide();
    }

    el("#nrn-cycle-cols").toggle(hasKin || hasHouse);

    const debug = el("#nrn-cycle-debug").empty();
    if (s.hidden?.length) debug.append(plainSpan(s.hidden.join(" · "))).show(); else debug.hide();

    row.show();
}

/**
 * Плашка про дитя — под сводкой об утробе, своей строкой на каждого.
 *
 * Отдельно от матери нарочно: она может уже снова носить, а первенцу всё так
 * же нужна грудь. Показываем только то, что видно с одного взгляда — имя,
 * возраст и что дитяти нужно сейчас.
 */
/**
 * Плашка отвара — под сводкой об утробе, рядом с дитятей.
 *
 * Показывает только то, что чувствует героиня. Подействовал отвар или
 * прерывать было нечего — этого здесь нет и не будет: она бы и сама
 * не различила.
 */
function renderDraught() {
    const row = el("#nrn-draught");
    const d = bodySummary()?.draught;
    if (!d) { row.hide(); return; }

    el("#nrn-draught-name").empty().append(
        hintSpan("draught", d.title, `${d.herb.ru} · ${d.toll.ru} откат`),
    );
    const text = el("#nrn-draught-text").text(d.status);
    text.toggleClass("nrn-alarm", d.fatal || d.toll.id === "dire");
    row.show();
}

function renderChildren() {
    const box = el("#nrn-children").empty();
    const kids = bodySummary()?.children;
    if (!kids?.length) { box.hide(); return; }

    for (const kid of kids) {
        const line = $("<div>", { "class": "nrn-child" });
        line.append(
            icon("child", "nrn-child-icon"),
            hintSpan(`child-${kid.title}`, kid.title, kid.stage.ru),
            plainSpan(` · ${kid.age}`),
        );
        if (kid.need) {
            const need = factRow("child-need", null, kid.need).addClass("nrn-child-need");
            if (kid.alarm) need.addClass("nrn-alarm");
            line.append(need);
        }
        for (const mark of kid.marks) {
            line.append(factRow("child-mark", null, mark).addClass("nrn-child-mark"));
        }
        box.append(line);
    }
    box.show();
}

/**
 * Сколько букв погоды ещё ложится на дугу медальона.
 *
 * «Лютый мороз» ложится, «метель с моря, к ночи заворачивает» — уже нет:
 * буквы пришлось бы жать вдвое. Такая погода уходит прямой строкой.
 */
const WEATHER_CURVE_MAX = 19;

/**
 * Верхняя балка: погода слева, место справа — по разные стороны солнца.
 *
 * Раскладку здесь не спрашиваем. Погода пишется сразу в оба места — и в
 * дугу медальона, и прямой строкой, — а какое из них показать, решают
 * стили по классу `nrn-weather-curved` и по самой раскладке. Иначе рендер
 * пришлось бы учить различать доску и плоскую вёрстку, а он о них не знает
 * и знать не должен.
 */
function renderScene() {
    const weather = el("#nrn-weather-text");
    const arc = weather.find("textPath")[0] ?? null;
    const curved = !!state.weather && state.weather.length <= WEATHER_CURVE_MAX;

    /* Погоду в дуге чистим отдельно: она живёт в SVG, и jQuery её текстом
       не достать. */
    if (arc) arc.textContent = curved ? state.weather : "";
    el("#nrn-weather-value").text(state.weather || "");
    weather.toggleClass("nrn-weather-curved", curved).toggle(!!state.weather);

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
    renderDraught();
    renderAdvice();
    renderChildren();
    const hasBody = !!bodySummary();
    const hasAdvice = !!(state.advice || bodySummary()?.advice);
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
 * Имя фигурки — в подпись, в подсказку под курсором и в aria-label.
 *
 * Подпись видна только в плоской раскладке; на доске имя живёт в подсказке,
 * потому что фигурку там узнают в лицо. Пишем во все три места разом —
 * рендеру не положено знать, какая раскладка выбрана.
 */
function figureLabel(selector, name) {
    const fig = el(selector);
    fig.attr({ "aria-label": name, title: name });
    fig.find(".nrn-fig-hit").attr("title", name);
    fig.find(".nrn-fig-name").text(name);
}

/* --- фигурки: какая страница открыта --- */

const TABS = ["user", "freyja", "char"];

/**
 * Выбранный лист живёт в настройках, а не в переменной.
 *
 * Виджет пересобирается на каждом ходу и на каждом свайпе, а SillyTavern
 * вдобавок затирает его при перерисовке сообщения. Держи выбор в памяти
 * модуля — и он слетал бы на нить Фрейи посреди разговора о {{char}}.
 */
function activeTab() {
    const tab = settings().activeTab;
    return TABS.includes(tab) ? tab : "freyja";
}

function applyTab() {
    const tab = activeTab();
    el("#nrn-page").attr("data-tab", tab);
    el(".nrn-fig").each(function () {
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
 * Медальон погоды — круг с надписью по дуге. Только плоская раскладка.
 *
 * Текст погоды ложится по дуге внутри круга: путь-дуга в <defs>, надпись на
 * ней через <textPath>. Дуга идёт слева направо понизу — тогда «верх» букв
 * смотрит в середину круга и надпись читается как обычно.
 *
 * Длинную погоду по дуге не уложить, поэтому она уходит прямой строкой под
 * круг: см. WEATHER_CURVE_MAX в renderScene(). На доске-картинке круга нет
 * вовсе, и там прямая строка показывается всегда.
 */
const WEATHER_ARC_ID = "nrn-weather-arc";

function weatherArc() {
    const svg = svgEl("svg", {
        "class": "nrn-medallion-svg",
        viewBox: "0 0 120 120",
        "aria-hidden": "true",
    });
    const defs = svgEl("defs");
    defs.appendChild(svgEl("path", {
        id: WEATHER_ARC_ID,
        d: "M 18 62 A 42 42 0 0 0 102 62",
        fill: "none",
    }));
    const text = svgEl("text", { "class": "nrn-medallion-text" });
    text.appendChild(svgEl("textPath", {
        href: `#${WEATHER_ARC_ID}`,
        startOffset: "50%",
        "text-anchor": "middle",
    }));
    svg.appendChild(defs);
    svg.appendChild(text);
    return svg;
}

/**
 * Вегвизир — подсветка активной эйкты.
 *
 * Циферблата больше нет: знак уже нарисован на самой доске (background.png),
 * и рисовать поверх него второй круг со стрелками значило бы спорить с
 * картинкой. Вместо этого поверх знака лежит прозрачный SVG ровно по его
 * месту, и в нём восемь полосок — по одной вдоль каждого луча вегвизира.
 * Видна всегда одна, та, в чьей эйкте идёт сцена.
 *
 * Координаты — в «пикселях рисунка»: квадрат 240×240 стоит серединой на
 * перекрестье знака (см. --nrn-vegvisir-* в разделе 5 стилей), полоска идёт
 * от 16 до 96 единиц от середины — это ровно длина прямой части луча, без
 * его концевых завитков. Углы не считаем: восемь эйкт — восемь румбов, и
 * каждый следующий луч просто довёрнут на 45°.
 */
const VEGVISIR_RAYS = 8;

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
        /* Две линии одна на другой: широкая тусклая — свечение вокруг луча,
           узкая яркая — сам огонёк. Фильтров нет нарочно: размытие в SVG
           считается в пикселях экрана и на широкой доске расплылось бы. */
        for (const cls of ["nrn-ray-halo", "nrn-ray-core"]) {
            ray.appendChild(svgEl("line", {
                "class": cls, x1: 120, y1: 104, x2: 120, y2: 24,
            }));
        }
        svg.appendChild(ray);
    }

    /*
     * Сердцевина круга — только для плоской раскладки.
     *
     * Там те же восемь лучей становятся циферблатом эйкт, и им нужен
     * деревянный кружок посередине: он прячет внутренние концы лучей и
     * держит стрелку со знаком времени суток. На доске сердцевина спрятана —
     * там середину знака рисует сама картинка.
     */
    const hub = $("<div>", { "class": "nrn-dial-hub" }).append(
        $("<span>", { "class": "nrn-dial-pointer" }),
        $("<span>", { "class": "nrn-dial-core" }).append(
            icon("time-eykt", "nrn-dial-icon"),
        ),
    );

    return $("<div>", { id: "nrn-vegvisir", "class": "nrn-vegvisir" }).append(svg, hub);
}

/**
 * Фигурка на правой странице книги — кнопка листа.
 *
 * Три таких кнопки правят левой страницей: {{user}}, нить Фрейи (медальон)
 * и {{char}}. Подписей под ними больше нет — фигурку узнают в лицо, — поэтому
 * имя уехало в подсказку под курсором и в aria-label.
 *
 * Внутри кнопки лежит «горячее место», и ловит клики именно оно, а сама
 * кнопка помечена pointer-events: none. Причина в шнурках: рисунки висят
 * на них внахлёст, и прямоугольник медальона накрывает пустой угол фигурки
 * хозяйки. По прямоугольникам клик уходил бы не туда, куда указывает глаз.
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
        $("<span>", { "class": "nrn-fig-hit", title: label }),
        /* Подпись — для плоской раскладки: там фигурок нет, а есть
           деревяшка с именем, и узнать её можно только по нему. */
        $("<span>", { "class": "nrn-fig-name", text: label }),
    );
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
             * Знаков у них больше нет. На доске, где всё нарисовано, знак
             * рядом с надписью — это второй рисунок поверх первого.
             */
            $("<div>", { id: "nrn-beam", "class": "nrn-beam" }).append(
                /* Погода и время — одной стопкой, а не двумя надписями по
                   своим местам: длинная погода занимает две строки, и время
                   должно съехать вниз вместе с ней, а не оказаться под ней. */
                $("<div>", { "class": "nrn-beam-left" }).append(
                    /* Дуга и знаки нужны только плоской раскладке — там это
                       круглый медальон с надписью по дуге. На доске они
                       спрятаны стилями, и погода читается прямой строкой. */
                    $("<div>", { id: "nrn-weather-text", "class": "nrn-beam-line" }).append(
                        weatherArc(),
                        icon("scene-weather", "nrn-medallion-icon"),
                        $("<span>", { id: "nrn-weather-value" }),
                    ),
                    $("<div>", { id: "nrn-time-line", "class": "nrn-beam-line" }).append(
                        $("<span>", { id: "nrn-eykt-name" }),
                        $("<span>", { id: "nrn-eykt-num" }),
                    ),
                ),
                $("<div>", { id: "nrn-location-text", "class": "nrn-beam-line" }).append(
                    icon("scene-location", "nrn-plate-icon"),
                    $("<span>", { id: "nrn-location-value" }),
                ),
            ),

            /*
             * Левая половина доски — счёт времени, прямо по дереву.
             *
             * Вегвизир на ней уже нарисован; сверху лежит только подсветка
             * активной эйкты. Под знаком дата, у нижнего края — календарик.
             */
            $("<div>", { id: "nrn-wood", "class": "nrn-wood" }).append(
                vegvisirOverlay(),

                $("<div>", { id: "nrn-datebox" }).append(
                    $("<div>", { id: "nrn-sun", "class": "nrn-sun-line" }),
                    $("<div>", { id: "nrn-week", "class": "nrn-cal-line" }),
                    $("<div>", { id: "nrn-date", "class": "nrn-cal-line" }),
                    $("<div>", { id: "nrn-moon", "class": "nrn-cal-line" }),

                    /* Праздник — прямо над календариком, где он и покрашен. */
                    $("<div>", { id: "nrn-feast", "class": "nrn-cal-line" }),
                ),

                $("<div>", { id: "nrn-grid" }),
            ),

            /*
             * Книга — вместо разворота из отдельных листов.
             *
             * Левая страница видна целиком, и на ней вся сводка. Правая
             * обрезана краем доски, и на ней то, чем сводку переключают:
             * фигурки {{user}} и {{char}}, медальон нити Фрейи и дети.
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

                        /* Нить Фрейи — то, ради чего расширение и писалось.
                           Отвар и слово повитухи живут здесь же: они про
                           утробу, и на чужом листе им делать нечего. */
                        /*
                         * Лист нити разложен по смыслу, а не по тому, откуда
                         * какое поле пришло.
                         *
                         * Раньше «Отец» стоял пятой строкой, а признание
                         * отцовства, ранг дитяти и имя — двенадцатой, хотя это
                         * один и тот же вопрос: чей ребёнок и кем он будет в
                         * роду. Теперь род собран в одну кучку, дом и
                         * приготовления — в другую, а приметы, которых к концу
                         * срока набирается десяток, стоят своим столбцом
                         * напротив: так лист выходит вдвое короче.
                         */
                        $("<div>", { id: "nrn-page-freyja", "class": "nrn-leaf", "data-leaf": "freyja" }).append(
                            $("<div>", { id: "nrn-cycle", "class": "nrn-cycle" }).append(
                                /* Фаза со счётом — заголовок листа, слова о теле
                                   под ним подзаголовком. */
                                $("<div>", { id: "nrn-cycle-text", "class": "nrn-cycle-head" }),
                                $("<div>", { id: "nrn-cycle-status", "class": "nrn-cycle-sub" }),
                                /* Шевеления — во всю ширину и сразу под словами
                                   о теле: затишье дитяти единственное, о чём
                                   здесь тревожатся, и прятать его в столбец
                                   значило бы обменять тревогу на стройность. */
                                $("<div>", { id: "nrn-cycle-kicks", "class": "nrn-cycle-line nrn-cycle-dim" }),
                                /* Срок и размер дитяти — часть заголовка: это
                                   тот же счёт, что и «Ношение: 6/9», только
                                   словами. */
                                $("<div>", { id: "nrn-cycle-extra", "class": "nrn-cycle-dim" }),
                            ),
                            /* Род и дом — двумя столбцами сразу под сроком:
                               это короткие «подпись: значение», и они дают
                               обзор быстрее длинных примет. */
                            $("<div>", { id: "nrn-cycle-cols", "class": "nrn-cycle-cols" }).append(
                                $("<div>", { "class": "nrn-cycle-col" }).append(
                                    $("<div>", { id: "nrn-cycle-kin", "class": "nrn-cycle-group" }),
                                ),
                                $("<div>", { "class": "nrn-cycle-col" }).append(
                                    $("<div>", { id: "nrn-cycle-house", "class": "nrn-cycle-group" }),
                                ),
                            ),
                            /* Приметы — под ними и во всю ширину листа: к концу
                               срока их десяток, и целыми фразами они ложатся
                               лучше в широкую строку, чем в узкий столбец. */
                            $("<div>", { id: "nrn-cycle-signs", "class": "nrn-cycle-dim" }),
                            $("<div>", { id: "nrn-cycle-debug", "class": "nrn-cycle-line nrn-cycle-debug" }),
                            $("<div>", { id: "nrn-draught", "class": "nrn-draught" }).append(
                                icon("draught", "nrn-draught-icon"),
                                $("<span>", { id: "nrn-draught-name" }),
                                $("<span>", { id: "nrn-draught-text", "class": "nrn-draught-text" }),
                            ),
                            $("<div>", { id: "nrn-advice", "class": "nrn-advice" }).append(
                                icon("advice", "nrn-advice-icon"),
                                $("<span>", { id: "nrn-advice-text" }),
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

                /* Дети вписаны в саму книгу, под фигурками, и видны на любой
                   странице: дитя не перестаёт просить есть оттого, что
                   смотрят на {{char}}. */
                $("<div>", { id: "nrn-children", "class": "nrn-children" }),
            ),

            $("<div>", { id: "nrn-stub", text: `ᚱ ${t`Waiting for the infoblock…`}` }),
        ),
    );

    $widget.attr({
        "data-theme": s.theme || "default",
        "data-skin": s.skin || "board",
    });

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
        if (!TABS.includes(tab)) return;
        settings().activeTab = tab;
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
    default: () => t`Default (dark)`,
    midnight: () => t`Midnight`,
    ember: () => t`Ember`,
    blood: () => t`Blood and iron`,
    forest: () => t`Deep woods`,
    stone: () => t`Grey stone`,
    light: () => t`Light`,
    frost: () => t`Hoarfrost`,
    parchment: () => t`Parchment`,
};

const SKIN_LABELS = {
    board: () => t`Carved board`,
    flat: () => t`Plain panel`,
};

function themeLabel(theme) {
    return (THEME_LABELS[theme] ?? (() => theme))();
}

function currentTheme() {
    return THEME_LABELS[settings().theme] ? settings().theme : "default";
}

function currentSkin() {
    return SKIN_LABELS[settings().skin] ? settings().skin : "board";
}

/*
 * localStorage бывает недоступен: приватное окно, запрет на сторонние
 * данные, переполнение квоты. Тогда правки просто не сохраняются — окно
 * скажет об этом словом, а блок продолжит работать на своих цветах.
 */
function readUserCss(theme) {
    try {
        return localStorage.getItem(`${USER_CSS_PREFIX}${theme || "default"}`);
    } catch {
        return null;
    }
}

function writeUserCss(theme, text) {
    const key = `${USER_CSS_PREFIX}${theme || "default"}`;
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
 * чьём селекторе стоит эта тема, — то есть и общий блок переменных, и
 * поправки вроде «светлые темы на доске пишут по дереву светлым».
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
    const marker = `[data-theme="${theme || "default"}"]`;
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

    return {
        skins: list(SKIN_LABELS),
        themes: list(THEME_LABELS),
        skin: () => currentSkin(),
        theme: () => currentTheme(),
        themeLabel,

        setSkin: (id) => {
            settings().skin = SKIN_LABELS[id] ? id : "board";
            saveSettingsDebounced();
            applySkin(settings().skin);
        },

        setTheme: (id) => {
            settings().theme = THEME_LABELS[id] ? id : "default";
            saveSettingsDebounced();
            applyTheme(settings().theme);
            /* Окно справочника красится той же темой, что и блок: иначе
               выбор пришлось бы сверять с чатом за спиной у окна. */
            const dlg = getDialog?.();
            if (dlg) dlg.dataset.theme = settings().theme;
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
    const shell = document.createElement("div");
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
    paint();

    // Popup, а не callGenericPopup: нужен доступ к <dialog> ДО показа, чтобы
    // покрасить подложку своей темой без мигания таверновской.
    const popup = new Popup(shell, POPUP_TYPE.DISPLAY, "", {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
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
            // Массивы копируем: иначе настройки получат ссылку на сам
            // defaultSettings, и первый же push испортит константу.
            extension_settings[extensionName][key] = Array.isArray(value) ? [...value] : value;
        }
    }
    // Наследие прежней схемы, где хранился список скрытых колонок.
    delete extension_settings[extensionName].timatalHiddenColumns;
    /* Сетка дней больше не сворачивается: кнопку убрали, блок всегда открыт. */
    delete extension_settings[extensionName].collapsed;
    /*
     * Раздел уведомлений появился позже прочих.
     *
     * У тех, кто ставил расширение раньше, список свёрнутых разделов уже
     * сохранён, и нового ключа в нём нет — раздел открылся бы развёрнутым,
     * а «Сбросить вид» повис бы в шапке навсегда: вид ведь и правда не
     * совпадает с исходным. Досыпаем ключ один раз и запоминаем это, иначе
     * раздел закрывался бы обратно при каждой загрузке.
     */
    const s = extension_settings[extensionName];
    if (!s.notifySeeded) {
        if (Array.isArray(s.timatalClosedSections) && !s.timatalClosedSections.includes("notify")) {
            s.timatalClosedSections.push("notify");
        }
        s.notifySeeded = true;
        /* Записываем сразу: иначе у того, кто ничего в настройках не тронул,
           досыпка не сохранилась бы и повторялась при каждой загрузке — а на
           второй раз она закрывала бы раздел, который читатель открыл сам. */
        saveSettingsDebounced();
    }
    /* Длина цикла была настройкой и успела сохраниться со значением 30.
       Теперь она всегда 28, а забытая тридцатка давала ровный оборот на
       таймскипе в три месяца — цикл возвращался на тот же день. */
    delete extension_settings[extensionName].cycleLength;
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

/**
 * Применяет раскладку (атрибут data-skin).
 *
 * Пересобирать виджет не нужно: разметка у раскладок одна, различие целиком
 * в стилях. Поэтому переключение мгновенное и не теряет ни выбранной
 * страницы, ни прокрутки.
 */
function applySkin(skin) {
    if ($widget) $widget.attr("data-skin", skin || "board");
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
    bindCheckbox("#nrn_body_debug", "bodyDebug", () => refresh());
    bindCheckbox("#nrn_herb_death", "herbDeath", () => { injectPrompt(); refresh(); });

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
