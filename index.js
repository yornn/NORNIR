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
 * Чат читается ОДНИМ вызовом readChat() на такт, и результат кэшируется до
 * следующего refresh() или инжекта. Раньше дату, тело и снимок брали разными
 * функциями, каждая шла по истории сама, и делали они это с разными
 * настройками — см. комментарий к readState().
 *
 * Лор и разбор маркера живут в parser.js, счёт цикла и беременности —
 * в body.js. Оба не зависят от SillyTavern и покрыты тестами в test-*.mjs.
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
    AUK_AFTER_MONTH,
    MONTHS_LORE,
    WEEKDAYS_LORE,
    WEEKDAYS_SHORT_NORSE,
    WEEKDAY_DESC_RU,
    WEEKDAYS_FULL_RU,
    EYKTIR,
    addDays,
    aukDays,
    dayOfYear,
    eyktForHour,
    isSumaraukiYear,
    vikaOf,
    weeksInYear,
    yearLength,
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
    cycleAnchor,
    herbAnchor,
    labourAnchor,
    pregnancyAnchor,
    readChat,
    setSceneDate,
    syncWholeChat,
} from "./chat-state.js";

import { CYCLE_DEFAULT, DIVINATION_ACCURACY, bodyView, pregnancyTerm } from "./body.js";

const extensionName = "Norse-Calendar";
const extensionFolderName = `third-party/${extensionName}`;

/* По умолчанию в Tímatal открыты только Эйкты: с телефона незачем листать
   весь справочник, а нужный раздел разворачивается одним касанием. */
const DEFAULT_CLOSED_SECTIONS = ["month", "vika", "week", "moon", "block"];

/* Постоянные колонки (номер и др.-сканд. написание) здесь не перечисляются —
   они всегда на месте. Русский включён, чтобы при первом открытии сразу было
   видно, что есть что; остальное добирается облачками. */
const DEFAULT_VISIBLE_COLUMNS = ["ru"];

const defaultSettings = {
    enabled: true,
    inject: true,
    theme: "default",
    /* Какой лист разворота открыт. Нить Фрейи первой не по алфавиту:
       ради неё расширение и писалось. */
    activeTab: "freyja",
    timatalClosedSections: DEFAULT_CLOSED_SECTIONS,
    timatalVisibleColumns: DEFAULT_VISIBLE_COLUMNS,
    loreHints: false,
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
 *  - эталон состояния приходит инжектом ([NORSE CALENDAR STATE]), а не из
 *    истории: старые маркеры из чата вырезаны, модели их взять неоткуда.
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
 *  - формулировки собираем из MONTHS_LORE и прочих таблиц, чтобы промпт не
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
 * Объясняем только то, чего модель не угадает: эйкты и лорный календарь.
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
    "[SYSTEM CHANNEL — Norse Calendar. This configures a UI panel and stands outside the fiction. Characters cannot perceive it, and nothing written here happens in the scene.]",
    "",
    "Alongside the roleplay you keep a calendar panel up to date for the reader. It refreshes from a single hidden block that you place after your prose, every single time.",
    "Wrapped in <!-- and -->, the block is a comment: the chat renders nothing for it, so not one word of it reaches the reader. Treat it as machine-readable output that sits apart from the narrative — do not restate its contents in prose and do not turn it into a visible status header.",
    "",
    /* Главная строка всей перестройки. Любое число, посчитанное моделью,
       она считает вслух в рассуждениях — и в каждом свайпе по-своему.
       Раньше строка отсылала за посчитанным к [NORSE CALENDAR STATE] — то есть
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
 * а ВЫЧИСЛЯЛА: переводила современный месяц в лорный, спорила сама с собой,
 * сольмануд это июль или сентябрь, и делала это вслух — по-разному в каждом
 * свайпе. Полтабличных 472 символа объяснений уходили только на то, чтобы она
 * могла посчитать то, что мы и так знаем.
 *
 * Теперь дату ставит пользователь через Tímatal, расширение везёт её вперёд
 * и перелистывает по смене эйкты, а модели она приезжает готовой строкой
 * в [NORSE CALENDAR STATE] — чтобы персонажи могли на неё ссылаться в речи.
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
    "<!-- [YORNI:",
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
        "<!-- [YORNI:",
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
    if (settings().loreHints) out.push(loreHints(s));
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
        "The year runs twelve months of thirty days, winter first: гормануд, юлир, морсугур, торри, гоа, эйнмануд, then харпа, скерпла, сольмануд, хейаннир, твимануд, хаустмануд. Four аукнэтр stand at midsummer, between сольмануд and хейаннир. The half-years are Vetr and Sumar; a week is a vika.",
        "The day runs eight eyktir of three hours: миднатти, отта, моргун, дагмал, хадеги, ундорн, мидафтан, наттмал. Хадеги is noon and the sun stands due south; наттмал is the late evening.",
    ];

    const d = sceneDate();
    if (d) {
        const name = isAuk(d.month) ? "аукнэтр" : MONTHS_LORE[d.month - 1].ru.toLowerCase();
        const weekday = WEEKDAYS_LORE[weekdayOf(d.year, d.month, d.day)].ru.toLowerCase();
        const { phase } = moonPhase(d.year, d.month, d.day);
        out.push(
            "",
            `Today is ${d.day} ${name} ${d.year} — ${weekday}, ${seasonOf(d.month).ru.toLowerCase()}, ${phase.ru.toLowerCase()}. Written in numbers, ${numericDate(d)}.`,
            "The panel keeps this count and moves it along with the scene. Take the day as given and let the characters speak of it as people of their time would.",
            "When the story skips ahead, say how much time went by in the marker's passed line and the panel will move the date; working the new date out yourself is not needed.",
        );
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

/**
 * Ручная запись о теле — в метаданных чата, рядом с датой начала.
 *
 * На сообщении она не держится: свайп подставляет копию extra из swipe_info,
 * перегенерация заводит свою, удаление уносит целиком. Дата начала лежит
 * в метаданных с самого начала и работает исправно — ручное состояние тела
 * такой же авторский акт, ему туда же.
 */
const META_BODY = "norseManualBody";

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
 * Теперь чтение одно на такт. Такт открывают refresh() и injectNorsePrompt();
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
        injectNorsePrompt();
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
 * Наш маркер принимает лорную дату, но рядом живут трекеры, которым нужен
 * числовой формат. Модель, зная только «5 сольмануд 1015», переводит его
 * сама — и делает это вслух, посреди рассуждений: «сольмануд седьмой месяц,
 * значит 05.07». В прогонах пользователя один и тот же день превращался то
 * в 05.07.1015, то в 05.06.1015, то в 05.09.1015 — три разных ответа на один
 * вопрос, и каждый со своим абзацем размышлений.
 *
 * Номер известен нам из MONTHS_LORE, так что арифметику делаем здесь.
 * Аукнэтр в григорианский месяц не ложится вовсе — отдаём номер сольмануда,
 * после которого эти дни и стоят.
 */
function numericDate(s) {
    const month = isAuk(s.month) ? MONTHS_LORE[AUK_AFTER_MONTH - 1] : MONTHS_LORE[s.month - 1];
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
function loreHints(s) {
    const bits = [];
    if (hasDate(s)) {
        const { year, month, day } = s;
        bits.push(WEEKDAYS_LORE[weekdayOf(year, month, day)].ru.toLowerCase());
        bits.push(`неделя ${vikaOf(year, month, day)} из ${weeksInYear(year)}`);
        bits.push(seasonOf(month).ru.toLowerCase());
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
 * Раньше эта строка стояла последней в [NORSE CALENDAR STATE], между погодой
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
function injectNorsePrompt() {
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
const META_START = "norseStartDate";

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
             * Ищем начало маркера, а не просто слово «yorni».
             *
             * Прежняя проверка срабатывала на любое вхождение в любом регистре —
             * в том числе на слово посреди прозы. А дальше шло переприсвоение
             * innerHTML, которое сносит обработчики и узлы соседних расширений
             * внутри сообщения. Теперь нужен именно открывающий комментарий,
             * хоть сырой, хоть экранированный таверной.
             */
            if (!MARKER_IN_DOM_RE.test(html)) continue;
            const clean = stripYorniMarkers(html.replace(/&lt;!--/g, "<!--").replace(/--&gt;/g, "-->"));
            if (clean !== html) el.innerHTML = clean;
        }
    } catch (e) {
        console.error(`[${extensionName}] не удалось подчистить маркер в сообщении:`, e);
    }
}

/* Начало маркера в уже отрисованном HTML: сырое, экранированное Encode Tags
   и старый видимый блок. Регистр не важен, «yorni» само по себе — важно. */
const MARKER_IN_DOM_RE = /(?:<|&lt;)!--\s*\[YORNI:|<yorni>/i;

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

/**
 * Знак поля — квадратный SVG из папки `icons/`, подложенный маской.
 *
 * Пустой элемент нарочно: файл подставляет CSS по `data-icon`, а цвет знак
 * берёт из строки, в которой стоит. Отсюда два даровых свойства — он сам
 * попадает в тему и сам краснеет вместе с `.ncw-alarm`, — и ни одного пути
 * к файлу в коде: из JS папку расширения видно только через
 * `renderExtensionTemplateAsync`, а CSS считает `url()` от себя, как уже
 * делает `@font-face`.
 *
 * Имени нет в CSS — покажется `_fallback.svg`, и вёрстка этого не заметит.
 * Поэтому иконки можно доносить в папку по одной, а не все разом.
 */
function icon(name, extraClass) {
    return $("<span>", {
        "class": extraClass ? `ncw-icon ${extraClass}` : "ncw-icon",
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
    const row = $("<div>", { "class": "ncw-fact" }).append(icon(iconName));
    if (label) row.append($("<span>", { "class": "ncw-fact-label", text: `${label}:` }));
    row.append(hint
        ? hintSpan(`fact-${label ?? iconName}`, value, hint).addClass("ncw-fact-value")
        : $("<span>", { "class": "ncw-fact-value", text: value }));
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
    box.append($("<div>", { "class": "ncw-group-title", text: title }), ...rows).show();
    return true;
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
        grid.append(
            $("<div>", { "class": "ncw-auk-title" }).append(
                icon("cal-auknaetr"),
                plainSpan(t`Sumarauki · Auknætr`),
            ),
        );
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
        const tip = `${WEEKDAY_DESC_RU[i]} — ${WEEKDAYS_FULL_RU[i]}`;
        headRow.append($("<div>", { "class": "ncw-cell ncw-wd", text: WEEKDAYS_SHORT_NORSE[i], title: tip }));
    }
    grid.append(headRow);

    // weekdayOf уже считает от понедельника — пересчитывать нечего
    const offsetToday = weekdayOf(year, month, day);
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

    const stub = el("#ncw-stub");
    if (!showTime && !showDate && !showDetails) {
        // Чистим содержимое, а не только прячем: иначе прошлая сцена остаётся
        // в DOM и попадает в текст сообщения при копировании или озвучке.
        el("#ncw-eykt-name, #ncw-week, #ncw-date, #ncw-lore, #ncw-grid, #ncw-mood-chips, #ncw-children, #ncw-draught-name").empty();
        el("#ncw-sun, #ncw-eykt-num, #ncw-weather-text, #ncw-location-text").text("");
        el("#ncw-attire-user-text, #ncw-attire-char-text, #ncw-thought-text, #ncw-cycle-text, #ncw-cycle-status, #ncw-cycle-kicks, #ncw-cycle-extra, #ncw-cycle-kin, #ncw-cycle-house, #ncw-cycle-signs, #ncw-cycle-debug, #ncw-char-state-text, #ncw-user-state-text, #ncw-advice-text").text("");
        /* Погоду в медальоне чистим отдельно: она живёт в SVG, и jQuery
           её текстом не достать. */
        const arc = el("#ncw-medallion").find("textPath")[0];
        if (arc) arc.textContent = "";
        el("#ncw-crown, #ncw-left, #ncw-page, #ncw-rail").hide();
        el("#ncw-grid").addClass("ncw-hidden");
        stub.show();
        return;
    }
    stub.hide();
    /* Навершие и разворот показываем целиком: что в них пусто, решают
       сами плашки и листы — каждая своим toggle. */
    el("#ncw-crown, #ncw-page, #ncw-rail").show();

    renderTimeAndDate(showTime, showDate);
    renderExtraFields();
    buildGrid();
}

/** Левая колонка: эйкта, положение солнца, дата, день недели и фаза Луны. */
function renderTimeAndDate(showTime, showDate) {
    el("#ncw-left").toggle(showTime || showDate);

    const plate = el("#ncw-plate-eykt");
    const dial = el("#ncw-dial");
    const sunEl = el("#ncw-sun");
    if (showTime) {
        const idx = eyktForHour(state.hour);
        const e = EYKTIR[idx];
        const hh = String(state.hour).padStart(2, "0");
        const mm = String(state.minute ?? 0).padStart(2, "0");

        el("#ncw-eykt-name").empty().append(hintSpan("eykt", e.ru, `${hh}:${mm}`));
        el("#ncw-eykt-num").text(t`eykt ${idx + 1}`);
        plate.show();

        /* Круг знает свою эйкту одним числом: по нему CSS и подсвечивает
           нужный луч, и доворачивает указатель. Считать углы в JS незачем. */
        dial.attr("data-eykt", idx).show();

        /* Восемь эйкт — восемь румбов, ровно по кругу: знак солнца рисуется
           один, стрелкой на север, а поворот докручивает CSS по `data-dir`.
           Восьми файлов на одну и ту же стрелку заводить незачем. */
        sunEl.empty().append(
            icon("time-sun").attr("data-dir", idx),
            plainSpan(e.dirText),
        ).show();
    } else {
        plate.hide();
        dial.hide();
        sunEl.hide();
    }

    const weekEl = el("#ncw-week").empty();
    const dateEl = el("#ncw-date").empty();
    const loreEl = el("#ncw-lore").empty();
    if (!showDate) {
        weekEl.hide();
        dateEl.hide();
        loreEl.hide();
        return;
    }

    const { year, month, day } = state;
    const season = seasonOf(month);

    /* Строка 1 — где мы в неделе: «Frjádagr · vika 48».
       Точек-разделителей больше нет: факты разводит знак перед каждым,
       а не серая точка между ними. */
    const wd = WEEKDAYS_LORE[weekdayOf(year, month, day)];
    const vika = vikaOf(year, month, day);
    weekEl.append(
        icon("cal-weekday"),
        hintSpan("wd", wd.norse, wd.ru),
        icon("cal-vika"),
        hintSpan("vika", `vika ${vika}`, `${t`day`} ${dayOfYear(year, month, day)}/${yearLength(year)}`),
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
            hintSpan("date", MONTHS_LORE[month - 1].norse, MONTHS_RU_NOM[month - 1]),
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
    loreEl.append(
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
    textRow("#ncw-advice", "#ncw-advice-text", state.advice || bodySummary()?.advice || null);
}

function renderCycle() {
    const row = el("#ncw-cycle");
    const s = bodySummary();
    if (!s) { row.hide(); el("#ncw-cycle-cols").hide(); return; }

    /* Две обязательные строки: где мы в счёте и что с телом. Обе кликабельны.
       Ещё две необязательные — приметы и гадание — появляются только когда
       героиня знает о дитяти. Что показывать, решено в bodyView(): здесь
       только раскладка, иначе панель и промпт разъедутся. */
    el("#ncw-cycle-text").empty().append(
        icon(s.icon),
        hintSpan("cyclePhase", s.title, s.titleHint),
        ...(s.count ? [plainSpan(` · ${s.count}`)] : []),
    );
    el("#ncw-cycle-status").empty().append(hintSpan("cycleStatus", s.status, s.statusHint));

    /* Шевеления — во всю ширину, сразу под словами о теле. Тревога висит на
       самой строке, а не на соседях: раньше затишье дитяти красило заодно и
       обереги, и имя, и число женщин в доме — восемь строк кричали об одном,
       и кричать переставало быть заметным. */
    const kicks = el("#ncw-cycle-kicks").empty();
    if (s.kicks) {
        kicks.append(
            factRow("watch-kicks", null, s.kicks.text).toggleClass("ncw-alarm", !!s.kicks.alarm),
        ).show();
    } else {
        kicks.hide();
    }

    const extra = el("#ncw-cycle-extra").empty();
    if (s.extra) extra.append(factRow(s.extraIcon, null, s.extra)).show(); else extra.hide();

    /* Род. Отец и гадание — двумя строками, не одной: признание отцовства
       это правовой факт, а толкование живота — присказка повитухи, и
       подсказка «гадание, а не знание» относится только ко второму. */
    const kin = [];
    if (s.father) kin.push(factRow("body-father", "Отец", s.father));
    if (s.guess) {
        kin.push($("<div>", { "class": "ncw-fact" }).append(
            icon("body-divination"),
            $("<span>", { "class": "ncw-fact-label", text: "Толкуют:" }),
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
    const hasKin = fillGroup("#ncw-cycle-kin", "Род", kin);

    const house = HOUSE_FIELDS
        .filter(([, , key]) => state[key])
        .map(([iconName, label, key]) => factRow(iconName, label, state[key]));
    const hasHouse = fillGroup("#ncw-cycle-house", "Дом", house);

    /* Приметы — по строке на примету, каждая со своим знаком. Вид приметы
       считает bodyView(): что грудь, что дурнота, что кровь — знать это
       раскладке неоткуда. Своим столбцом напротив рода и дома: к девятой
       части их набирается десяток, и в общем потоке они топили всё под собой. */
    const signs = el("#ncw-cycle-signs").empty();
    if (s.signs?.length) {
        for (const sign of s.signs) signs.append(factRow(`sign-${sign.kind}`, null, sign.text));
        signs.show();
    } else {
        signs.hide();
    }

    el("#ncw-cycle-cols").toggle(!!(s.signs?.length || s.extra || hasKin || hasHouse));

    const debug = el("#ncw-cycle-debug").empty();
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
    const row = el("#ncw-draught");
    const d = bodySummary()?.draught;
    if (!d) { row.hide(); return; }

    el("#ncw-draught-name").empty().append(
        hintSpan("draught", d.title, `${d.herb.ru} · ${d.toll.ru} откат`),
    );
    const text = el("#ncw-draught-text").text(d.status);
    text.toggleClass("ncw-alarm", d.fatal || d.toll.id === "dire");
    row.show();
}

function renderChildren() {
    const box = el("#ncw-children").empty();
    const kids = bodySummary()?.children;
    if (!kids?.length) { box.hide(); return; }

    for (const kid of kids) {
        const line = $("<div>", { "class": "ncw-child" });
        line.append(
            icon("child", "ncw-child-icon"),
            hintSpan(`child-${kid.title}`, kid.title, kid.stage.ru),
            plainSpan(` · ${kid.age}`),
        );
        if (kid.need) {
            const need = factRow("child-need", null, kid.need).addClass("ncw-child-need");
            if (kid.alarm) need.addClass("ncw-alarm");
            line.append(need);
        }
        for (const mark of kid.marks) {
            line.append(factRow("child-mark", null, mark).addClass("ncw-child-mark"));
        }
        box.append(line);
    }
    box.show();
}

/**
 * Сколько букв погоды ещё ложится на дугу медальона.
 *
 * «Лютый мороз» ложится, «метель с моря, к ночи заворачивает» — уже нет:
 * буквы пришлось бы жать вдвое. Такая погода уходит прямой строкой под круг.
 */
const WEATHER_CURVE_MAX = 19;

/** Навершие доски: погода в круге, место на железной вставке. */
function renderScene() {
    const medallion = el("#ncw-medallion");
    const straight = el("#ncw-weather-text");
    const arc = medallion.find("textPath")[0] ?? null;

    if (state.weather) {
        const curved = state.weather.length <= WEATHER_CURVE_MAX;
        if (arc) arc.textContent = curved ? state.weather : "";
        straight.text(curved ? "" : state.weather).toggle(!curved);
        medallion.show();
    } else {
        if (arc) arc.textContent = "";
        straight.text("").hide();
        medallion.hide();
    }

    const locPlate = el("#ncw-plate-loc");
    if (state.location) {
        el("#ncw-location-text").text(state.location);
        locPlate.show();
    } else {
        locPlate.hide();
    }
}

/**
 * Листы разворота: {{user}}, нить Фрейи, {{char}}.
 *
 * Рисуем все три всегда, а показываем один — тот, что выбран деревяшкой.
 * Прятать по «есть ли что показать» тут нельзя: кнопка должна открывать
 * лист и тогда, когда сцена о человеке смолчала, иначе нажатие выглядит
 * сломанным. Пустой лист говорит об этом словами.
 */
function renderExtraFields() {
    const context = getContext();
    const userName = context?.name1 || "{{user}}";
    const charName = context?.name2 || "{{char}}";

    renderScene();

    /* --- лист {{user}} --- */
    el("#ncw-user-name").text(userName);
    textRow("#ncw-attire-user", "#ncw-attire-user-text", state.userAttire);
    textRow("#ncw-user-state", "#ncw-user-state-text", state.userState);
    leafEmpty("#ncw-user-empty", !!(state.userAttire || state.userState),
        "Сцена о ней ничего не сказала.");

    /* --- лист нити Фрейи --- */
    renderCycle();
    renderDraught();
    renderAdvice();
    renderChildren();
    const hasBody = !!bodySummary();
    const hasAdvice = !!(state.advice || bodySummary()?.advice);
    leafEmpty("#ncw-freyja-empty", hasBody || hasAdvice,
        settings().bodyTracking ? "Счёт тела ещё не начат." : "Счёт тела выключен в настройках.");

    /* --- лист {{char}} --- */
    el("#ncw-char-name").text(charName);
    const moods = state.charMood
        ? state.charMood.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const moodEl = el("#ncw-mood-chips").empty();
    for (const m of moods) {
        moodEl.append($("<span>", { "class": "ncw-chip", text: m }));
    }
    moodEl.toggle(moods.length > 0);

    textRow("#ncw-attire-char", "#ncw-attire-char-text", state.charAttire);
    textRow("#ncw-char-state", "#ncw-char-state-text", state.charState);
    textRow("#ncw-thought", "#ncw-thought-text", state.thought);
    leafEmpty("#ncw-char-empty",
        moods.length > 0 || !!state.charAttire || !!state.thought || !!state.charState,
        "Сцена о нём ничего не сказала.");

    applyTab();
}

/** Слово вместо пустого листа: кнопка нажалась, а показать нечего. */
function leafEmpty(selector, hasContent, words) {
    el(selector).text(hasContent ? "" : words).toggle(!hasContent);
}

/* --- деревяшки: какой лист открыт --- */

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
    el("#ncw-page").attr("data-tab", tab);
    el(".ncw-plank").each(function () {
        const plank = $(this);
        plank.toggleClass("ncw-plank-on", plank.attr("data-tab") === tab);
    });
    el("#ncw-thread").toggleClass("ncw-thread-on", tab === "freyja");
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
    if (lastBot.querySelector("#norse-calendar-widget")) return; // уже на месте
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
 * Медальон погоды — круг в навершии доски.
 *
 * Текст погоды ложится по дуге внутри круга: путь-дуга в <defs>, надпись на
 * ней через <textPath>. Дуга идёт слева направо понизу — тогда «верх» букв
 * смотрит в середину круга и надпись читается как обычно.
 *
 * Длинную погоду по дуге не уложить, поэтому она уходит прямой строкой под
 * круг: см. WEATHER_CURVE_MAX в renderScene().
 */
const WEATHER_ARC_ID = "ncw-weather-arc";

function weatherMedallion() {
    const svg = svgEl("svg", {
        "class": "ncw-medallion-svg",
        viewBox: "0 0 120 120",
        "aria-hidden": "true",
    });
    const defs = svgEl("defs");
    defs.appendChild(svgEl("path", {
        id: WEATHER_ARC_ID,
        d: "M 18 62 A 42 42 0 0 0 102 62",
        fill: "none",
    }));
    const text = svgEl("text", { "class": "ncw-medallion-text" });
    const path = svgEl("textPath", {
        href: `#${WEATHER_ARC_ID}`,
        startOffset: "50%",
        "text-anchor": "middle",
    });
    text.appendChild(path);
    svg.appendChild(defs);
    svg.appendChild(text);
    return svg;
}

/**
 * Циферблат эйкт — восемь чёрных лучей по кругу.
 *
 * Сутки здесь делятся не на часы, а на восемь эйкт, и круг показывает это
 * прямо: луч на каждую, подсвечен тот, в котором сцена. В сердцевине
 * треугольник-указатель и знак времени суток.
 */
function eyktDial() {
    const ring = $("<div>", { "class": "ncw-dial-ring" });
    for (let i = 0; i < EYKTIR.length; i++) {
        ring.append($("<span>", { "class": "ncw-dial-ray", "data-ray": i }));
    }
    return $("<div>", { id: "ncw-dial", "class": "ncw-dial" }).append(
        ring,
        $("<div>", { "class": "ncw-dial-hub" }).append(
            $("<span>", { id: "ncw-dial-pointer", "class": "ncw-dial-pointer" }),
            $("<span>", { "class": "ncw-dial-core" }).append(
                icon("time-eykt", "ncw-dial-icon"),
            ),
        ),
    );
}

/**
 * Деревяшка на кожаных подвязках — кнопка листа.
 *
 * Три такие кнопки правят левым листом: {{user}}, нить Фрейи и {{char}}.
 * Нить висит на деревяшке хозяйки не по прихоти раскладки: это её тело,
 * и отдельной доски оно не просит.
 */
function tabPlank(tab, nameId, extra) {
    const plank = $("<div>", { "class": "ncw-plank", "data-tab": tab }).append(
        $("<span>", { "class": "ncw-strap ncw-strap-left" }),
        $("<span>", { "class": "ncw-strap ncw-strap-right" }),
        $("<button>", { "class": "ncw-plank-btn", type: "button", "data-tab": tab }).append(
            $("<span>", { id: nameId, "class": "ncw-plank-name" }),
        ),
    );
    if (extra) plank.append(extra);
    return plank;
}

/** Создаёт DOM-структуру виджета (detached — вставит mountWidget). */
function buildWidget() {
    if ($widget) return $widget;

    const s = settings();

    $widget = $("<div>", { id: "norse-calendar-widget", "class": "nc-themed" }).append(
        $("<div>", { id: "ncw-board", "class": "ncw-board" }).append(

            /* Навершие: обстановка сцены. Погода в круге посередине, время
               слева на дереве, место справа на железе — по разным углам,
               потому что это три разных вопроса к сцене, а не один список. */
            $("<div>", { id: "ncw-crown", "class": "ncw-crown" }).append(
                $("<div>", { id: "ncw-plate-eykt", "class": "ncw-plate ncw-plate-wood" }).append(
                    $("<span>", { id: "ncw-eykt-name", "class": "ncw-plate-text" }),
                    $("<span>", { id: "ncw-eykt-num", "class": "ncw-plate-sub" }),
                ),
                $("<div>", { id: "ncw-medallion", "class": "ncw-medallion" }).append(
                    weatherMedallion(),
                    icon("scene-weather", "ncw-medallion-icon"),
                ),
                $("<div>", { id: "ncw-plate-loc", "class": "ncw-plate ncw-plate-metal" }).append(
                    icon("scene-location", "ncw-plate-icon"),
                    $("<span>", { id: "ncw-location-text", "class": "ncw-plate-text" }),
                ),
            ),
            /* Длинная погода на дугу не ложится и уходит сюда, под круг. */
            $("<div>", { id: "ncw-weather-text", "class": "ncw-weather-straight" }),

            $("<div>", { id: "ncw-stub", text: `ᚱ ${t`Waiting for the infoblock…`}` }),

            $("<div>", { id: "ncw-columns" }).append(

                /* Треть первая — счёт времени: круг эйкт, дата, луна, неделя. */
                $("<div>", { id: "ncw-left" }).append(
                    eyktDial(),
                    $("<div>", { id: "ncw-sun", "class": "ncw-sun-line" }),
                    $("<div>", { id: "ncw-week", "class": "ncw-cal-line" }),
                    $("<div>", { id: "ncw-date", "class": "ncw-cal-line" }),
                    $("<div>", { id: "ncw-lore", "class": "ncw-cal-line" }),

                    /*
                     * Сводка о теле переехала сюда с листа нити.
                     *
                     * Фаза, счёт и слова о теле — это заголовок всего блока,
                     * а не одна из трёх вкладок: они верны и когда смотришь
                     * на {{char}}. На листе им место было только потому, что
                     * оттуда они родом. Совет — следом: он о том же теле.
                     */
                    $("<div>", { id: "ncw-summary", "class": "ncw-summary-block" }).append(
                        $("<div>", { id: "ncw-cycle-text", "class": "ncw-summary-line" }),
                        $("<div>", { id: "ncw-cycle-status", "class": "ncw-summary-line" }),
                        $("<div>", { id: "ncw-advice", "class": "ncw-advice" }).append(
                            icon("advice", "ncw-advice-icon"),
                            $("<span>", { id: "ncw-advice-text" }),
                        ),
                    ),

                    /* Календарик стоит последним в колонке и прижат к её низу
                       (margin-top: auto). Колонка тянется на всю высоту доски,
                       поэтому неделя всегда у нижнего края и не скачет вслед
                       за длиной сводки о теле. */
                    $("<div>", { id: "ncw-grid" }),
                ),

                /*
                 * Части вторая и третья — лист и деревяшки.
                 *
                 * Лежат прямо в #ncw-columns, без обёртки-разворота: только
                 * тогда сеткой можно задать крайним частям одинаковую ширину,
                 * а листу — всё остальное. От этого лист сам собой встаёт
                 * серединой под круг погоды, который тоже по центру доски.
                 */
                $("<div>", { id: "ncw-page", "class": "ncw-page", "data-tab": "freyja" }).append(

                        $("<div>", { id: "ncw-page-user", "class": "ncw-leaf", "data-leaf": "user" }).append(
                            $("<div>", { id: "ncw-attire-user", "class": "ncw-attire" }).append(
                                icon("char-attire", "ncw-attire-icon"),
                                $("<span>", { id: "ncw-attire-user-text" }),
                            ),
                            $("<div>", { id: "ncw-user-state", "class": "ncw-state" }).append(
                                icon("char-state", "ncw-state-icon"),
                                $("<span>", { id: "ncw-user-state-text" }),
                            ),
                            $("<div>", { id: "ncw-user-empty", "class": "ncw-leaf-empty" }),
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
                        $("<div>", { id: "ncw-page-freyja", "class": "ncw-leaf", "data-leaf": "freyja" }).append(
                            $("<div>", { id: "ncw-cycle", "class": "ncw-cycle" }).append(
                                $("<div>", { id: "ncw-cycle-text", "class": "ncw-cycle-line" }),
                                $("<div>", { id: "ncw-cycle-status", "class": "ncw-cycle-line" }),
                                /* Шевеления — во всю ширину и сразу под словами
                                   о теле: затишье дитяти единственное, о чём
                                   здесь тревожатся, и прятать его в столбец
                                   значило бы обменять тревогу на стройность. */
                                $("<div>", { id: "ncw-cycle-kicks", "class": "ncw-cycle-line ncw-cycle-dim" }),
                            ),
                            $("<div>", { id: "ncw-cycle-cols", "class": "ncw-cycle-cols" }).append(
                                $("<div>", { "class": "ncw-cycle-col" }).append(
                                    $("<div>", { id: "ncw-cycle-signs", "class": "ncw-cycle-dim" }),
                                ),
                                $("<div>", { "class": "ncw-cycle-col" }).append(
                                    $("<div>", { id: "ncw-cycle-extra", "class": "ncw-cycle-dim" }),
                                    $("<div>", { id: "ncw-cycle-kin", "class": "ncw-cycle-group" }),
                                    $("<div>", { id: "ncw-cycle-house", "class": "ncw-cycle-group" }),
                                ),
                            ),
                            $("<div>", { id: "ncw-cycle-debug", "class": "ncw-cycle-line ncw-cycle-debug" }),
                            $("<div>", { id: "ncw-draught", "class": "ncw-draught" }).append(
                                icon("draught", "ncw-draught-icon"),
                                $("<span>", { id: "ncw-draught-name" }),
                                $("<span>", { id: "ncw-draught-text", "class": "ncw-draught-text" }),
                            ),
                            $("<div>", { id: "ncw-advice", "class": "ncw-advice" }).append(
                                icon("advice", "ncw-advice-icon"),
                                $("<span>", { id: "ncw-advice-text" }),
                            ),
                            $("<div>", { id: "ncw-freyja-empty", "class": "ncw-leaf-empty" }),
                        ),

                        $("<div>", { id: "ncw-page-char", "class": "ncw-leaf", "data-leaf": "char" }).append(
                            $("<div>", { id: "ncw-mood-chips", "class": "ncw-chips" }),
                            $("<div>", { id: "ncw-attire-char", "class": "ncw-attire" }).append(
                                icon("char-attire", "ncw-attire-icon"),
                                $("<span>", { id: "ncw-attire-char-text" }),
                            ),
                            $("<div>", { id: "ncw-char-state", "class": "ncw-state" }).append(
                                icon("char-state", "ncw-state-icon"),
                                $("<span>", { id: "ncw-char-state-text" }),
                            ),
                            $("<div>", { id: "ncw-thought", "class": "ncw-thought" }).append(
                                icon("char-thought", "ncw-thought-icon"),
                                $("<span>", { id: "ncw-thought-text" }),
                            ),
                            $("<div>", { id: "ncw-char-empty", "class": "ncw-leaf-empty" }),
                        ),
                ),

                $("<div>", { id: "ncw-rail", "class": "ncw-rail" }).append(
                    tabPlank("user", "ncw-user-name",
                        $("<button>", {
                            id: "ncw-thread",
                            "class": "ncw-thread",
                            type: "button",
                            "data-tab": "freyja",
                            text: "Нить Фрейи",
                        })),
                    tabPlank("char", "ncw-char-name"),
                    $("<div>", { id: "ncw-children", "class": "ncw-children ncw-sheet" }),
                ),
            ),
        ),
    );

    $widget.attr("data-theme", s.theme || "default");

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

    $(document).on("click", "#norse-calendar-widget .ncw-hintable", function () {
        swapHint($(this));
    });

    /* Деревяшки и нить Фрейи. Ловим только кнопки: сама деревяшка тоже
       помечена data-tab, и без сужения клик считался бы дважды. */
    $(document).on("click", "#norse-calendar-widget button[data-tab]", function () {
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

/** Открывает окно Tímatal. */
async function openTimatal() {
    const theme = settings().theme || "default";

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
    const paint = () => {
        shell.replaceChildren(
            buildReference(state, theme, timatalPrefs(), onSetDate, cycleControls(paint)),
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
 * 8. SLASH COMMANDS (STscript)
 * ============================================================ */

/** Дата строкой в формате YORNIE, либо пустая строка. */
function formatDate() {
    if (!hasDate(state)) return "";
    const { year, month, day } = state;
    if (isAuk(month)) return `Sumarauki ${day} из ${aukDays(year)}, ${year}`;
    return `${day} ${MONTHS_LORE[month - 1].ru} ${year}`;
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
            helpString: "Возвращает дату сцены (например «13 Гормануд 1015»).",
        },
        {
            name: "norse-eykt",
            callback: () => formatEykt(),
            returns: "название текущей эйкты, либо пустая строка",
            helpString: "Возвращает эйкту из последнего маркера (например «Хадеги»).",
        },
        {
            name: "norse-state",
            callback: () => JSON.stringify(state),
            returns: "весь распознанный инфоблок в JSON",
            helpString: "Возвращает всё состояние панели: дату, время, погоду, локацию, настроение, одежду, мысль, состояния тел, совет и всё, что сказано про дитя.",
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
    /* Сетка дней больше не сворачивается: кнопку убрали, блок всегда открыт. */
    delete extension_settings[extensionName].collapsed;
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

function bindSettings() {
    bindCheckbox("#nc_enabled", "enabled", (v) => {
        if (v) {
            refresh();
        } else if ($widget) {
            $widget.detach();
        }
    });

    bindCheckbox("#nc_inject", "inject", () => injectNorsePrompt());
    bindCheckbox("#nc_lore_hints", "loreHints", () => injectNorsePrompt());
    bindCheckbox("#nc_body", "bodyTracking", () => { injectNorsePrompt(); refresh(); });
    bindCheckbox("#nc_body_debug", "bodyDebug", () => refresh());
    bindCheckbox("#nc_herb_death", "herbDeath", () => { injectNorsePrompt(); refresh(); });

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
        forgetChat();
        const context = getContext();
        if (!chatHasRawMarkers(context?.chat)) return;
        const n = syncWholeChat(context?.chat, { keepMarker: settings().debugKeepMarkers });
        if (n && typeof context?.saveChat === "function") {
            try { context.saveChat(); } catch (e) {
                console.error(`[${extensionName}] не удалось сохранить чат после миграции:`, e);
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
