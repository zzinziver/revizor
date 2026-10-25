# Платформа: свой код и прочие CMS

**Для:** `brief.platform.name = "custom"`, `null` и все платформы без своего файла (таблица ниже).
**Кто читает:** все линзы; больше всего — `security`, `stability`, `seo-tech`, `perf`.
**Сверено:** 24.10.2026.

## 0. Какой справочник читать

### Платформа

Имя из `brief.platform.name` (оно же `pages.json → stack.cms`) → файл в `knowledge/platforms/`:

| `platform.name` | Файл |
|---|---|
| `Tilda` | `tilda.md` (магазин Tilda Store — там же, раздел «Магазин Tilda Store») |
| `WordPress` | `wordpress.md` |
| `Bitrix` | `bitrix.md` |
| `Webflow` | `webflow.md` |
| `Wix` | `wix.md` |
| `Next.js`, `Nuxt`, `React SPA`, `Vue SPA`, `Angular`, `Gatsby` | `nextjs-spa.md` |
| `Shopify` | `shopify.md` |
| `InSales` | `insales.md` |
| `Readymag` | `readymag.md` |
| `Taplink` | `taplink.md` |
| `Craftum` | `craftum.md` |
| `OpenCart`, `Webasyst` | этот файл §2 + `verticals/shop.md` |
| `Flexbe`, `Nethouse`, `uKit`, `LPgenerator`, `Framer`, `Squarespace` | этот файл §3 |
| `ГосВеб` | этот файл §5 + `verticals/gov.md` |
| `Ecwid` | `stack.cms: "Ecwid"` — этот файл §4; `stack.store: "Ecwid"` — файл основной платформы; в обоих случаях + `verticals/shop.md` |
| `Joomla`, `Drupal`, `MODX`, `Ghost` | этот файл §2 |
| `custom`, `null`, `Hugo`, `Jekyll`, `Astro`, `Docusaurus` и всё прочее | этот файл (§1–§5) |

`platform.confidence: "low"` — читай этот файл и файл догадки; правку пиши так, чтобы она подходила обоим, или спрашивай платформу в `open_questions`.

### Рынок и вертикаль

Файлов `markets/mixed.md` и `verticals/other.md` нет. Правило:

| Поле `brief` | Что читать |
|---|---|
| `market.value = "ru"` | `markets/ru.md` |
| `market.value = "intl"` | `markets/intl.md` |
| `market.value = "mixed"` | `markets/ru.md` и `markets/intl.md`: каждый — для своей части аудитории (`market.countries`, языки и валюты сайта) |
| `vertical = "<id>"` | `verticals/<id>.md`, свой раздел (заголовок — id линзы) и «Не баг» |
| `vertical = "other"` | вертикаль не читать: у сайта нет признаков ни одной (`pages.json → vertical_scores` пуст или нулевой); работать по своему чек-листу. Видишь по тексту, что тип всё же есть (например, магазин без корзины на главной), — вопрос в `open_questions`, вертикаль не подменять |
| госучреждение-школа или больница | `verticals/gov.md` и `education.md` или `medical.md` |

## 1. Сайт на своём коде

Признаки: CMS не определена, в коде нет следов конструктора; статический HTML, сборщик сайтов (Hugo, Jekyll, Astro, Eleventy) или своё приложение на сервере. Владелец (через разработчика) правит всё: шаблоны, сервер, заголовки. Скидки «платформа» нет — важность по влиянию, `owner: "разработчик"`.

| Линза | Что проверить | Где в замерах | Важность |
|---|---|---|---|
| `security` | Служебные файлы в веб-корне: `/.git/`, `/.env`, резервные копии, дампы, `phpinfo.php` | `headers.json → probe` (только `--probe` на своём сайте) | открыт `.env` или `.git` — P0 |
| `security` | Карты исходников, HTML-комментарии с путями, именами и внутренними адресами | `headers.json → sourcemaps`, `page.json → comments` | P2; ключи и пароли — P0 |
| `security` | Раскрытие версий сервера (`Server`, `X-Powered-By`), стектрейсы на странице ошибки | `headers.json → home.disclosure`, `error_page.traces` | P2–P3 |
| `security` | Заголовки безопасности, HSTS, флаги cookie, срок сертификата и автопродление | `headers.json → home.*`, `tls.cert.days_left` | по `security` |
| `stability` | Выкладка «распаковать поверх»: удалённые страницы, формы, `/api/` остаются на сервере и отвечают | `links.json`, `seo.json → site.url_variants`; вопрос владельцу о способе выкладки | P1, если живёт удалённая форма или API |
| `stability` | HTML без `no-cache`, статика без хэша в имени: после выкладки посетители видят старую версию | `headers.json → items[].html_cache`, `items[].first_party.Script.short_cache`, `first_party.Stylesheet.short_cache`; имена файлов — в тех же списках | P2 |
| `seo-tech` | Страница 404 отдаёт код 200 (часто на статическом хостинге при `404.html`) | `seo.json → site.soft404[].status` | P1 |
| `seo-tech` | Слэш в конце, `index.html` в адресах, регистр — несколько адресов одной страницы | `site.url_variants` | P2 |
| `seo-tech` | Нет `sitemap.xml`, `robots.txt`, canonical — их никто не сгенерировал | `site.sitemap`, `site.robots`, `items[].canonical` | P1–P2 |
| `forms` | Свой обработчик форм: серверная проверка полей, защита от спама, куда уходят данные, «спасибо» | `forms.json` | по `forms` |
| `perf` | Нет сжатия для JS, CSS, SVG; нет долгого кэша статики; HTTP/2 | `headers.json → items[].first_party` (`uncompressed`, `encodings`, `short_cache` по типам; флаги `no-compression`, `short-cache`), `tls.http2` | P2 |

**Что исправимо и где:** всё — в шаблонах и конфиге сервера (`fix_place`: `шаблон`, `общий CSS`, `сервер`). В `fix` — готовый фрагмент конфига или кода и способ проверить. Команды сервера Ревизор не выполняет: только текст правки.

## 2. Другие CMS на своём сервере (Joomla, Drupal, MODX, OpenCart, Webasyst, Ghost и подобные)

Устроены как WordPress (`wordpress.md`): ядро, расширения, шаблон, свой сервер.
- `security`: версия в `<meta name="generator">` и заголовках, устаревшее ядро и расширения (только сопоставление версии с бюллетенями), адрес входа в админку открыт всем — наличие видно по ссылкам в коде; служебные пути отдельно не открывать.
- `seo-tech`: дубли адресов с параметрами CMS (`index.php?route=…`, `?option=com_…`), служебные страницы (поиск, теги, авторы, сравнение товаров) в индексе. Адреса с `?` — `seo.json → items[].links.param_links` (`route=`, `option=` попадают в `other`; `samples`), запасной путь — `measure/links.json → items[]` (`internal: true`); `items[].links.tracking_params` их не ловит.
- Магазины на таких CMS (OpenCart, Webasyst Shop-Script) — плюс `verticals/shop.md`: фильтры, сортировки, «быстрый просмотр», карточка доступна по адресу с ЧПУ и без него.
- Правки — в админке (настройки SEO, расширения) и на сервере.

## 3. Другие конструкторы (Framer, Squarespace, Flexbe, Nethouse, uKit, LPgenerator и подобные)

Устроены как Тильда, Webflow, Wix, Craftum (`tilda.md`, `webflow.md`, `wix.md`, `craftum.md`): хостинг у платформы, правки в редакторе и настройках.
- Сервер и заголовки — P3 «платформа».
- title, description, редиректы, `robots.txt`, свой код в head — в настройках платформы, доступность зависит от тарифа: правку пиши двумя путями («если в настройках есть X — там; иначе — …»).
- Технический домен платформы не должен оставаться открытым для индекса рядом с основным.
- Плашка платформы и технический адрес на бесплатном тарифе — минус доверию (P1–P2 для коммерческого сайта, `needs_decision`).

## 4. Платформа не определена

- `pages.json → stack.signals` и `headers.json → cms` дают подсказки — сверь с кодом страницы (`raw.html`).
- `crawl.mjs` распознаёт эти признаки как `stack.cms` (Vue и Angular — только когда других сигналов нет), магазин-виджет — как `stack.store` (`Ecwid`). Метки нет, а признак в `raw.html` есть (замер обрезан, признак в другом шаблоне) — пользуйся таблицей. Нашёл в `raw.html` — читай указанный справочник и укажи в находке, по какому признаку определил (`confidence: "medium"`). Признаки — по опыту сборки, сверь в коде страницы:

| Признак в коде | Что это | Читать |
|---|---|---|
| `data-v-app`, `__NUXT__`, `/_nuxt/`, пустой `<div id="app">` | Vue, Nuxt | `nextjs-spa.md` |
| `ng-version`, `<app-root>` | Angular | `nextjs-spa.md` |
| пустой `<div id="root">` и текст только после JS | React SPA | `nextjs-spa.md` |
| `catalog/view/theme`, `index.php?route=` | OpenCart | этот файл §2 + `verticals/shop.md` |
| `/wa-apps/`, `/wa-content/`, `/wa-data/` | Webasyst (Shop-Script) | этот файл §2 + `verticals/shop.md` |
| `app.ecwid.com`, классы `ec-store`, `ecwid` | Ecwid — магазин-виджет внутри сайта на другой платформе | файл основной платформы + `verticals/shop.md`; товары часто приходят скриптом — проверь `items[].text.js_only` на страницах каталога |
| `flexbe` в адресах файлов | Flexbe | этот файл §3 |
| `nethouse` в адресах файлов, технический домен платформы | Nethouse | этот файл §3 |
| `ukit` в адресах файлов, технический домен платформы | uKit | этот файл §3 |
| `lpgenerator` в адресах файлов | LPgenerator | этот файл §3 |
| домен или ссылки `*.gosweb.gosuslugi.ru`, `netcat_files` в путях | ГосВеб — платформа для сайтов госорганов | этот файл §5 + `verticals/gov.md` |
| `t-store`, `js-store`, `t706`, `/tproduct/` | Tilda Store | `tilda.md` |

- Не угадывай платформу в `fix`: пиши правку через результат («у страницы должен быть один H1 в исходном HTML; на конструкторе — тег заголовка в настройках элемента, в коде — `<h1>`»).
- Вопрос владельцу «на чём сделан сайт и кто его правит» — в `open_questions`.

## 5. ГосВеб (платформа для сайтов госорганов и учреждений)

- Шаблон, структура разделов, сервер, заголовки, версия для слабовидящих — у платформы: что учреждение не может изменить само — P3 «платформа», `fix_place: "настройки платформы"`, в `fix` — «заявка оператору платформы».
- У учреждения в руках: тексты, документы (PDF с текстовым слоем), новости, контакты, alt у своих картинок, порядок пунктов меню, если платформа его даёт. Это важность по влиянию.
- Требования к доступности и составу разделов — `verticals/gov.md` и `markets/ru.md` §4.4 (ПП № 102). Возможности администрирования сверить в справке платформы.
