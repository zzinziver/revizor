# Чек-лист линзы `typography` — шрифты и типографика на экране

Пункт: `[typography-NN] что проверить — как — норма — ложные срабатывания`. Номер идёт в `clean_checks[].check` и в `coverage.checklist_done/checklist_total`.

Граница с соседями (`_owners.md`): знаки в тексте (кавычки, тире, «ё», неразрывные пробелы как символы) — `copy`; как строки ломаются на экране, кегли, шрифты, глифы — `typography`. Вес и число файлов шрифтов — `perf`. `font-display` как поведение текста — `typography`. Лицензии — `legal`. Шрифты с серверов Google для РФ (передача данных за рубеж) — `privacy`. Поля мельче 16 px — `mobile`.

## Откуда данные

`measure/fonts.json` (коллектор `fonts`, ширины 390 и 1440):
- `items[]` — страница × ширина: `roles.<роль>` для `h1, h2, h3, text, button, nav, input, footer, price, small, body` — `family`, `family_first`, `size`, `size_on_screen` (если страница показана уменьшенной), `weight`, `style`, `line_height`, `line_ratio` (`line_ratio_estimated: true` — межстрочный `normal`, оценён по высоте строк), `letter_spacing`, `transform`, `variant_numeric`, `feature_settings`, `synthesis`, `lines`, `lines_by_rects`, `chars_per_line` (только у текста от 2 строк и 80 знаков, иначе `null`), `width_px`, `selector`, `text`, `region`;
- `items[].platform.<роль>` — кто рисует знаки на деле (CDP `CSS.getPlatformFontsForNode`): `css_first`, `drawn_by`, `drawn_custom`, `glyphs_total`, `fallback_glyphs`, `fallback_families` (какие запасные шрифты рисуют), `fonts[]` (`family`, `custom`, `glyphs`);
- `items[].glyphs.<гарнитура>` — `missing[]`, `missing_used` (каких знаков нет и они стоят в тексте этой гарнитуры), `checked` (набор: Ё ё Ж й № « » „ “ — – − ₽ × ° … ·), `loaded`; `items[].has_cyrillic`;
- `items[]`: `font_faces_count`, `font_faces_no_display` (число), `document_fonts_status` (`{ loaded: N, error: N }`), `fonts_status`, `files` (`count`, `bytes_known`, `duplicates`), `google_fonts` (`css`, `css2`, `display_swap`, `subset_cyrillic`);
- `items[].line_breaks` — `counts` и `items[]` (`selector`, `text`, `lines`, `box`, `issues[]: { type, word, line }`);
- `summary`: `families_by_chars`, `families_count`, `web_families`, `fallbacks[]` (с `fallback_families`), `missing_glyphs`, `missing_glyphs_used`, `line_breaks.counts` (`hanging`, `split_number`, `unit_alone`, `dash_starts_line`, `widow`) и `samples[]`, `font_faces[]` (все `@font-face` сайта один раз: `family`, `weight`, `style`, `display`, `src`, `used` — рисует ли страница этой гарнитурой), `font_faces_total`, `document_fonts[]` (`status`), `font_faces_no_display[]` (только используемые), `failed_faces`, `files_max`, `duplicates`, `google_fonts` (`true`, если шрифты с серверов Google есть), `sizes_px.<роль>.<ширина>` = `[мин, макс]`.

`measure/layout.json` — **единственный источник доли мелкого текста** (одна цифра на всё ревью): `items[].text` (`pct_lt12`, `pct_lt14`, `pct_lt16`, `chars_lt12`, `body_text_px`, `histogram`, `lt12_by_region`, `small_samples`, `transformed_chars`, `decorative_chars`, `decorative_lt12_chars`, `decorative_samples` — декоративный и `aria-hidden` текст, он в доли не входит; `scale_applied` и `body_text_css_px` — если страница без meta viewport показана уменьшенной: тогда на экране текст мельче CSS-кегля), `summary.small_text_narrow[]`, `summary.worst_small_text`. В `mobile.json` тоже есть доли знаков, но по другой загрузке — для мелкого текста их не используй, кроме окон ноутбуков (`items[].desktop.sizes[].text`).

`page.json → fonts` (`families`, `web`, `missing_glyphs`, `by_width`) — краткая сводка по странице. `text.md`: строки с меткой `[декор]` (`aria-hidden`) и `[невидимо]` на экране как текст не читаются — переносы и знаки в них не находка. Замер `<ROOT>/scripts/probe-js/typography-measure.js` через `probe --js` (готовый файл, запуск — в конце чек-листа). Кадры — `snapshot/<pid>/shots/`. `fonts.json` большой: сначала `summary`, потом Grep по `pid` и Read кусками.

Висячие слова и переносы снимает headless Chromium со шрифтами этой машины: перед находкой посмотри кадр той же страницы на той же ширине.

Нет нужного файла замера (`quick`, упавший скрипт) — пункт в `not_checked` с причиной; цифры на глаз не пишутся.

## A. Какие шрифты рисуют текст

- **[typography-01] Шрифт по ролям рисуется тем, что задумано** — как: `platform.<роль>.drawn_by` против `css_first`, `summary.fallbacks[]` — норма: `drawn_by` = задуманная гарнитура, `fallback_glyphs` = 0 — ложное: эмодзи всегда рисует системный шрифт эмодзи (`fonts[]` с системным `family` и 1–2 знаками) — не находка.
- **[typography-02] Число гарнитур** — как: `summary.families_by_chars`, `families_count` — норма: 2–3 гарнитуры с ролями (текст, заголовки, цифры или акцент); 4+ без роли — P3; гарнитура на 2 знака по всему сайту (запасной Arial в одной кнопке) — смотри, где она рисует.
- **[typography-03] Кириллица** — как: `items[].has_cyrillic`, `glyphs.<гарнитура>.missing`, `platform.h1.drawn_by` и `fallback_families` на русской странице, `items[].google_fonts.subset_cyrillic` — норма: русские заголовки и текст рисует задуманный шрифт; у шрифтов с серверов Google подключён набор `cyrillic` — нет кириллицы у шрифта заголовков, и они рисуются запасным: P1, на всей главной и в первом экране — P0 (`severity.md`).
- **[typography-04] Глифы** — как: `summary.missing_glyphs_used` и `items[].glyphs.<гарнитура>.missing_used` (знака нет в шрифте, а в тексте этой гарнитуры он стоит; пример: в декоративном шрифте нет «−» и «₽»); `summary.missing_glyphs` — нет в шрифте вообще, сверка Grep-ом по `text.md` — норма: каждый знак, который встречается в тексте этой гарнитуры, в ней есть — P2 у цен и телефонов, иначе P3 — ложное: знака нет в тексте этого шрифта — не находка.
- **[typography-05] Подмена отдельных знаков** — как: `platform.<роль>.fonts[]` — системный шрифт рисует буквы или цифры (не эмодзи) — норма: «№» не превращается в «No», «д» не похожа на латинскую g, «₽» не рисуется другим шрифтом другой высоты — P3, у цен — P2.
- **[typography-06] Фальшивый жирный и курсив** — как: вес и стиль в `roles.<роль>.weight/style` против подключённых `summary.font_faces[]` той же гарнитуры (`weight`, `style`); `synthesis` разрешает браузеру рисовать недостающее — норма: начертание подключено файлом; браузерный «жирный» размывает буквы — P3, в H1 и кнопках — P2.
- **[typography-07] Табличные цифры** — как: `typography-measure.js → prices_without_tnum`, `roles.price.variant_numeric` — норма: цены в колонку, таймеры, счётчики, таблицы — `font-variant-numeric: tabular-nums` (иначе «11:11» прыгает при смене) — P3 — ложное: одна цена в строке текста.

## B. Кегли и мелкий текст

- **[typography-08] Основной текст на телефоне** — как: `layout.json → items[].text.body_text_px` на 390, `fonts.json → roles.text.size` @390, `summary.sizes_px.text.390` — норма: от 16 px (ниже iOS-пользователи увеличивают страницу пальцами); 14–15 px — P2, 12–13 px у основного текста — P1 (`severity.md` §5).
- **[typography-09] Доля мелких знаков на 390** — как: `layout.json → items[].text.pct_lt12`, `pct_lt14`, `pct_lt16`, `chars_lt12`, `lt12_by_region`, `summary.small_text_narrow[]`, `summary.worst_small_text` — норма: мельче 12 px — до 5 % знаков страницы, мельче 14 px — только подписи и сноски; пиши долей и числом знаков (пример: «2 310 из 3 960 знаков мельче 12 px — 58 %») — ложное: декоративные надписи, логотипы-тексты, `transformed_chars` (уменьшено через `transform`), юридические сноски мелким (P3).
- **[typography-10] Мелкий текст на десктопе и ноутбуках** — как: `layout.json → items[].text.pct_lt12` на 1440, `mobile.json → items[].desktop.sizes[].text` (`lt12`, `lt14`) — норма как на телефоне; текст, который мельчает только в окнах ноутбуков из-за масштабирования страницы скриптом, — находка `mobile` (`rescale_laptop`), здесь — строка в `for_other_lenses`.
- **[typography-11] Шкала кеглей** — как: `summary.sizes_px.<роль>.<ширина>`, роли по страницам — норма: шкала с шагом 1,2–1,33 между уровнями; у одной роли на одной ширине разброс не больше 2 px между шаблонами (пример: H1 от 18 до 44 px на 390 — ролью H1 размечено разное) — P3; иерархия заголовков между шаблонами — `visual-13`.
- **[typography-12] Кнопки и меню** — как: `roles.button.size`, `roles.nav.size`, `summary.sizes_px.button`, `nav` на 390 — норма: от 14 px; 12 px капсом с разрядкой на кнопке действия — P2.
- **[typography-13] Длинный текст капсом** — как: `typography-measure.js → long_caps`, `roles.<роль>.transform` — норма: капсом — до 5 слов (кнопки, надзаголовки); абзац капсом читается медленнее — P3.
- **[typography-14] Поля ввода мельче 16 px** — владелец `mobile` (iOS увеличивает страницу при фокусе). Твой пункт, только если `mobile` нет в прогоне: `layout.json → items[].fields.lt16`, `fonts.json → roles.input.size` — P2.

## C. Межстрочный, длина строки, строки заголовков и кнопок

- **[typography-15] Межстрочный** — как: `roles.text.line_ratio` (`line_ratio_estimated: true` — в CSS стоит `normal`, число оценено по высоте строк), `typography-measure.js → tight_leading` (абзацы от 2 строк с межстрочным меньше 1,5; `line-height: normal` считается как 1,2 с пометкой `line_height_normal: true` — у большинства шрифтов это 1,1–1,25) — норма: наборный текст 1,5–1,75; заголовки 1,1–1,3; наборный текст 1,0–1,49 (в том числе `normal`) — P3; многострочный текст с межстрочным меньше 1,0 налезает строками — P2 — ложное: однострочная надпись, крупный заголовок, подписи в 1–2 строки.
- **[typography-16] Длина строки** — как: `typography-measure.js → chars_per_line_median`, `long_lines`, `lines_100_plus`, `measured` (сколько абзацев от 2 строк вошло в замер; поле `roles.text.chars_per_line` бывает `null`). Знаков в строке — по ширине полной строки абзаца, поэтому абзац из двух строк на 1440 тоже меряется — норма: 35–60 знаков на телефоне, 60–75 на десктопе; 76–99 — P3; 100+ — P2. `measured: 0` — длинных абзацев нет, пункт в `clean_checks` с этой оговоркой.
- **[typography-17] Строк в H1** — как: `roles.h1.lines_by_rects`, `layout.json → items[].fold.h1.lines_by_rects`, кадр — норма: до 2–3 строк на 1440, до 4 на 390; 5 строк и больше на телефоне — P2. Строки считай по `lines_by_rects`: поле `lines` — оценка высотой и с внутренними отступами завышает.
- **[typography-18] Кнопка в две строки на десктопе** — как: `layout.json → items[].fold.ctas[]` на 1440 (`lines`), `fonts.json → roles.button.lines_by_rects`, `visual-tokens.js → cta_two_lines` — норма: подпись кнопки в одну строку на 1440; перенос — P2 (на 390 перенос длинной подписи допустим, если кнопка во всю ширину).
- **[typography-19] Италик в крупном заголовке** — как: `roles.h1.style` = italic и `line_ratio` меньше 1,1; кадр — норма: хвосты «у д р ф» не обрезаны — P3.
- **[typography-20] Разрядка** — как: `roles.<роль>.letter_spacing` — норма: разрядка капса 0,05–0,15 em; разрядка строчных и отрицательная разрядка мелкого текста (до 14 px) мешают читать — P3.
- **[typography-21] Выключка по ширине без переносов** — как: `typography-measure.js → justify_no_hyphens` на 390 — норма: на телефоне `text-align: left` или `hyphens: auto` с `lang="ru"`; «реки» пробелов — P3.

## D. Как строки ломаются на экране

- **[typography-22] Висячие предлоги и союзы** — как: `summary.line_breaks.counts.hanging`, `samples[]` с `type: hanging`, `items[].line_breaks.items[]` (с `box`) — норма: в заголовках, кнопках, ценах предлог или союз в конце строки не висит — P3, в H1 и первом экране — P2 — ложное: шрифты машины ≠ шрифты посетителя; без кадра той же ширины не пиши.
- **[typography-23] Одно слово в последней строке** — как: `counts.widow`, `samples[]` с `type: widow` — норма: в заголовке от 4 слов последняя строка не из одного короткого слова — P3 — ложное: заголовок из 2–3 слов, который не влезает в строку (там одиночное слово неизбежно).
- **[typography-24] Разрыв числа и единицы** — как: `counts.split_number`, `counts.unit_alone`, `samples[]` — норма: «3 000 ₽», «10–20 минут», номер телефона, «24/7» не рвутся между строками; «₽» не стоит один на строке — P2 у цен и телефонов, иначе P3.
- **[typography-25] Тире в начале строки** — как: `counts.dash_starts_line` — норма: тире остаётся в конце предыдущей строки — P3.
- **[typography-26] Правка неразрывными пробелами** — как: правку проверяй `probe --inject-html` или `--css` на 320 и 390 — норма: склейка двух длинных слов неразрывным пробелом не вылезает за карточку на узких ширинах — в `fix_check` ширины, на которых проверил (320, 390 и 1440).

## E. Загрузка шрифтов

- **[typography-27] `font-display`** — как: `summary.font_faces_no_display[]` (только гарнитуры, которыми страница рисует), `summary.font_faces[].display`, `items[].google_fonts.display_swap` — норма: `swap` или `optional` у шрифтов текста первого экрана; `block` или пусто — текст невидим, пока шрифт грузится (на медленной сети кнопка несколько секунд стоит без подписи) — P2, у кнопки действия — P1. Правка: в `@font-face` — `font-display: swap`; для CSS с серверов Google — `&display=swap` в адресе того же `<link>`. Рецепт проверь подменой: второй `<link>` с `display=swap` рядом со старым не помогает — грузятся оба набора, и старый по-прежнему прячет текст.
- **[typography-28] Шрифт не загрузился** — как: `summary.failed_faces`, `items[].fonts_status`, `items[].document_fonts_status.error`, `summary.document_fonts[].status` = `error` — норма: все подключённые начертания загружаются — P1, если это шрифт текста.
- **[typography-29] Запасной шрифт** — как: `probe --pid <pid> --width 390 --block "*.woff2,*.woff,*.ttf,*.otf" --shot nofonts-390.jpg` и Read кадра — норма: без веб-шрифтов текст виден, в стеке есть запасной с кириллицей (`sans-serif`, `serif`), заголовки и кнопки не разваливаются на строки — P3; при развале первого экрана — P2.
- **[typography-30] Вес, файлы, сторонний сервер** — как: `summary.files_max`, `summary.duplicates`, `items[].files.bytes_known`, `summary.google_fonts`, `items[].google_fonts.css` — норма: решает `perf` (вес, дубли — один файл шрифта под несколькими адресами качается несколько раз) и `privacy` (шрифты с серверов Google на сайте для РФ). Ты пишешь строку в `for_other_lenses` с цифрами.
- **[typography-35] Шрифт меняется посреди анимации появления** — как: `summary.font_faces[].display` = `swap` у шрифта заголовков и текста первого экрана, `fonts_status`, анимации появления этих блоков (`mobile.json → code.motion.keyframes_samples`, `a11y.json → pages[].motion.moving[]`); кадр это не ловит — норма: шрифт готов до старта анимации (предзагрузка `<link rel="preload" as="font">`, старт после `document.fonts.ready` или `font-display: optional`), иначе текст проявляется запасным шрифтом и перескакивает в середине движения — P3 с `needs_device_check: true` (проверка: медленная сеть в браузере телефона, первый заход); без признаков в коде — строка в `not_checked`.

## F. Права и выбор шрифта

- **[typography-31] Лицензии** — как: `summary.font_faces[].src` (хост, имя файла) — коммерческая гарнитура на своём сервере или с чужого CDN — строкой в `for_other_lenses` для `legal`; находку не пишешь.
- **[typography-32] Гарнитура подходит жанру** — как: кадры, `design_read` — норма: выбор шрифта — вкус, P3 `taste`, вариантом на решение владельца. Шрифты, которые генераторы ставят по умолчанию, — примета шаблонного вида с замером: пункт [typography-36] во всех профилях, без `taste`.
- **[typography-33] Как предлагать новый шрифт** — 2–3 варианта по ролям (текст, заголовки, цифры), рекомендуемый первым со ★; у каждого есть кириллица и знаки Ёё № ₽ « » — −, табличные цифры, нужные начертания. Варианты из массовых подборок нейросетей и из рекомендаций дизайн-навыков не брать. Показать можно кадром: `probe --css` с `@font-face` и новым `font-family` для H1 и текста на настоящей странице 1440 и 390; кадр — в `fix_check`. Специмен без запасного шрифта врёт: подмену запасным видно только на настоящей странице. В `strict` (D12) так обязательно: каждый вариант — кадром подмены `probe --pid <pid> --width 390 --css "<RUN>/probe-js/<id>-a.css" --shot <id>-a-390.jpg` и то же на 1440, в светлой теме; в `where` — отдельными местами с теми же `pid` и `url`: первым текущий вид, вторым рекомендованный (`state: "вариант А ★"`, `shot: "probe/<файл>"`); вариант без кадра — не вариант.
- **[typography-36] Шрифты, которые генераторы ставят по умолчанию** — все профили; часть проверки шаблонного вида [visual-52] — как: `fonts.json → items[].roles.<роль>.family_first` (`h1`, `h2`, `text`, `button`) и `platform.<роль>.drawn_by` (что рисует на деле), `summary.families_by_chars`, `summary.web_families`; подсказка — `visual-ai-look.js → fonts_default`, `mono_caps` (код в `checklists/visual.md`); кадр первого экрана 1440 и 390 — приметы: (1) гарнитура заголовков или основного текста из списка: Inter, Manrope, Montserrat, Unbounded, Golos, Onest, Roboto, Rubik, Nunito, Space Grotesk, IBM Plex, Geist, JetBrains Mono (strict D3), Plus Jakarta Sans, DM Sans, Poppins; Playfair Display — примета в паре с гротеском из списка; (2) мелкие надзаголовки моноширинным капсом (`mono_caps.count` от 1, примеры в `mono_caps.ex`; моноширинный шрифт из списка — та же примета, считается один раз). Считается по CSS и по тому, что рисует: системный шрифт телефона (`system-ui`, который на Android рисует Roboto) приметой не считается — важность: `standard` — P3 за примету, `taste: false`, `category: "ai-look"`, в `evidence` поле замера и кадр; от 3 примет на сайте (с палитрой и компонентами) сводную P2 пишет `visual`, твоя находка остаётся и несёт варианты шрифтов; `strict` — P2 (D3, D14), `needs_decision: true`, тег `profile:strict`. Правка: 2–3 непривычных шрифта с кириллицей и нужными знаками, показанные картинкой на настоящей странице ([typography-33], strict D12). Шрифты из списка в правках не предлагать ни в одном профиле. Слова: «шрифт, который ставят по умолчанию генераторы сайтов», не «сделано нейросетью» — ложное: шрифт из брендбука или логотипа проекта; решение владельца (`owner_decisions`, `do_not_suggest`); гарнитура только в подвале или в виджете чужого сервиса.

## G. Знаки на экране

- **[typography-34] Знаки русской типографики рисуются** — как: `glyphs.<гарнитура>.missing` для « » „ “ — – − …, кадр — норма: кавычки-«ёлочки» и длинное тире есть в шрифте и не выглядят чужими. Сами знаки в тексте (прямые кавычки, дефис вместо тире, «...») — находка `copy`, здесь строка в `for_other_lenses`.

## Поправки к навыкам

- Правила Vercel (web-design-guidelines): Title Case в заголовках, “английские кавычки” и «пиши во втором лице» к русскому сайту не применять; `…` вместо `...` и неразрывные пробелы в «3 000 ₽» подходят.
- taste-skill: запрет длинного тире к русскому тексту не относится; его шрифтовые рекомендации (Geist, Satoshi, Outfit, моноширинные) не переносить.
- ui-ux-pro-max: пары шрифтов из его базы (Inter, Space Grotesk, Plus Jakarta Sans, JetBrains Mono) не предлагать; файл `google-fonts.csv` годится для вопроса «есть ли у шрифта кириллица».
- Рейтинги популярности Google Fonts «шрифты как у всех» не ловят: шрифты, которые нейросети ставят по умолчанию, в этих рейтингах далеко от верха.
- Как брать навык: web-design-guidelines и ui-ux-pro-max — инструментом Skill, в аргументах сразу задача («типографика: правила для проверки отрисованной страницы»); ui-ux-pro-max можно и файлом — `<папка .claude>/skills/ui-ux-pro-max/data/google-fonts.csv` (`<папка .claude>` — начало пути `<ROOT>` до `/.claude/` включительно), Grep по имени гарнитуры. Навыка нет — работай по чек-листу, `skills_used: []`.

## Самопроверка (quick)

Для `/revizor:quick typography`: `typography-01`, `-03`, `-04`, `-08`, `-09`, `-15`, `-16`, `-17`, `-18`, `-22`, `-24`, `-27`, `-36`. Кадров — не меньше 10 (fold и куски 390 и 1440).

## Что владелец заметит руками

- Висячий предлог в H1 или в кнопке на своём телефоне.
- Кнопка первого экрана в две строки на ноутбуке.
- «₽» или «−» другим шрифтом, «№» как «No».
- Мелкий серый текст подписей и цен на телефоне.
- Первый экран секунду показывает голые кнопки без подписей.
- Шрифт заголовков на русском выглядит иначе, чем на английском (рисуется запасной).

## Код замера `typography-measure.js`

Готовый замер `<ROOT>/scripts/probe-js/typography-measure.js`; запуск: `node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 390 --js "<ROOT>/scripts/probe-js/typography-measure.js" --no-shot` (и `--width 1440`). Ответ — в `result`.

Поля ответа: `paragraphs` (абзацы `p`, `li`, `dd`, `blockquote` от 80 знаков, без вложенных абзацев, до 60), `measured` (сколько из них от 2 строк — по ним считается длина строки), `chars_per_line_median` и `norm` (по ширине окна), `long_lines` (абзацы от 2 строк длиннее нормы, знаков в строке — по ширине полной строки), `lines_100_plus`, `tight_leading` (абзацы от 2 строк с межстрочным меньше 1,5; `line_height_normal: true` — в CSS `normal`, взято 1,2), `justify_no_hyphens`, `long_caps` (капс от 6 слов), `prices_without_tnum` (короткие элементы с ценой без табличных цифр).
