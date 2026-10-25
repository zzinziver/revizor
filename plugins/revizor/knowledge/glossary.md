# Словарь терминов

`report.mjs` берёт отсюда пояснения: первое упоминание термина в тексте отчёта получает всплывающую подсказку (`<abbr title>`), а в конце отчёта — раздел «Термины» с теми словами, что встретились. Источник для отчёта — машиночитаемые блоки в конце файла: `revizor:glossary` (русский) и `revizor:glossary-en` (английский). Таблицы ниже — те же данные для людей.

Правила словаря:
- пояснение — 5–10 простых слов; если без другого термина не обойтись, он тоже есть в словаре;
- термин пишется так, как его пишут в находках: `LCP`, `canonical`, `152-ФЗ`;
- термин из одних заглавных (`LCP`, `HTTP/2`) ищется с учётом регистра, остальные — без;
- форма слова одна: `бургер` найдётся, `бургера` — нет; поэтому в словаре — частые формы терминов;
- новый термин, который встречается в отчётах владельцу, добавляется в обе таблицы и в оба блока (самопроверка отчёта владельцу: незнакомых терминов вне словаря в нём нет).

## Русский

| Термин | Что значит |
|---|---|
| LCP | когда показался главный блок первого экрана |
| CLS | насколько страница прыгает и сдвигается при загрузке |
| INP | как быстро страница откликается на нажатие или ввод |
| TBT | сколько времени скрипты занимают страницу и она не отвечает |
| FCP | когда на экране появилось первое содержимое |
| TTFB | сколько сервер готовит ответ до первого байта |
| Core Web Vitals | три главных показателя скорости страницы по Google |
| CWV | три главных показателя скорости по Google |
| PageSpeed Insights | сервис Google для замера скорости страницы |
| PSI | PageSpeed Insights, сервис Google для замера скорости |
| CrUX | скорость сайта у настоящих посетителей по данным Google |
| Lighthouse | встроенный в Chrome замер скорости и качества страницы |
| canonical | подсказка поисковику, какой адрес страницы считать главным |
| hreflang | связь языковых версий страницы для поисковиков |
| noindex | запрет показывать страницу в поиске |
| robots.txt | файл с правилами для поисковых роботов |
| sitemap | список адресов сайта для поисковых роботов |
| sitemap.xml | файл со списком адресов сайта для поисковиков |
| soft-404 | несуществующая страница отвечает так, будто она есть |
| редирект | автоматический переход со старого адреса на новый (301 — постоянный) |
| title | заголовок страницы во вкладке браузера и в поиске |
| description | описание страницы, которое поиск показывает под заголовком |
| H1 | главный заголовок на самой странице |
| JSON-LD | скрытые данные о компании и ценах для поисковиков |
| микроразметка | скрытые данные о ценах, адресе, отзывах для поиска |
| Schema.org | общий словарь скрытой разметки для поисковиков |
| FAQPage | разметка вопросов и ответов для поисковиков |
| LocalBusiness | разметка с адресом, часами и телефоном компании |
| хлебные крошки | строка пути вида «Главная → Раздел → Страница» |
| Open Graph | данные для превью ссылки в мессенджерах и соцсетях |
| OG | данные для превью ссылки в мессенджерах |
| og:image | картинка в превью ссылки в мессенджерах |
| alt | описание картинки для незрячих людей и поисковиков |
| сниппет | блок сайта в выдаче: заголовок, описание, ссылка |
| интент | что на самом деле хочет человек, вводя запрос |
| каннибализация | две страницы сайта борются за один запрос |
| МПК | фильтр Яндекса за малополезное содержимое |
| E-E-A-T | признаки опыта и надёжности автора, которые ценит Google |
| YMYL | темы о деньгах и здоровье, где поиск строже |
| IndexNow | способ сразу сообщить поисковикам об изменённых страницах |
| llms.txt | файл с описанием сайта для ИИ-ассистентов |
| Clean-param | правило Яндекса: какие метки в адресах не учитывать |
| X-Robots-Tag | запрет индексации в ответе сервера |
| Вебмастер | кабинет Яндекса для владельца: индексация и ошибки |
| Search Console | кабинет Google для владельца: индексация и ошибки |
| SEO | работа над тем, чтобы сайт находили в поиске |
| UX | удобство сайта для посетителя |
| UI | внешний вид и элементы интерфейса |
| CTA | кнопка главного действия: «Записаться», «Купить» |
| первый экран | то, что видно сразу без прокрутки |
| бургер | кнопка из трёх полосок, открывает меню на телефоне |
| брейкпоинт | ширина экрана, на которой меняется раскладка |
| viewport | видимая часть страницы в окне браузера |
| DPR | плотность пикселей экрана, у телефонов обычно 2–3 |
| hover | наведение курсора мыши на элемент |
| hit-test | проверка, какой элемент окажется под пальцем |
| rescale | скрипт ужимает всю страницу под ширину окна |
| 100vh | высота «на весь экран», на iPhone работает с ошибками |
| WCAG | международный стандарт доступности сайтов |
| AA | основной уровень требований стандарта доступности WCAG |
| AAA | высший, необязательный уровень требований WCAG |
| ARIA | атрибуты-подсказки о роли элементов для программ чтения экрана |
| axe | автоматическая проверка доступности страницы |
| скринридер | программа, которая читает экран вслух незрячим людям |
| фокус | выделение элемента, на котором сейчас клавиатура |
| skip-link | ссылка «к содержанию» для перехода с клавиатуры |
| reflow | страница перестраивается при увеличении без прокрутки вбок |
| forced-colors | режим высокой контрастности в Windows |
| prefers-reduced-motion | настройка системы «уменьшить движение» |
| APCA | способ считать контраст с учётом тёмного фона и толщины букв; цифра Lc, у светлого текста на тёмном — с минусом; порог по модулю: основной текст 75, крупный 60, тонкий и мелкий 90 |
| ПДн | персональные данные: имя, телефон, почта человека |
| 152-ФЗ | российский закон о персональных данных |
| 38-ФЗ | российский закон о рекламе |
| GDPR | европейский закон о защите персональных данных |
| РКН | Роскомнадзор, ведомство по персональным данным и связи |
| трансграничная передача | передача персональных данных на серверы за рубежом |
| маркировка рекламы | обязательная пометка «Реклама» с данными рекламодателя |
| erid | номер рекламы для маркировки по закону |
| cookie | небольшие записи, которые сайт хранит в браузере |
| коллтрекинг | подменные номера телефона для учёта звонков по источникам |
| UTM | метки в ссылке, по которым видно источник посетителя |
| ClientID | номер посетителя в системе аналитики |
| Вебвизор | запись действий посетителей в Яндекс Метрике |
| GTM | Google Tag Manager, менеджер счётчиков на сайте |
| dataLayer | данные страницы для счётчиков и рекламы |
| honeypot | скрытое поле-ловушка для спам-ботов в форме |
| капча | проверка «я не робот» |
| HTTPS | защищённое соединение с сайтом |
| TLS | шифрование соединения между браузером и сайтом |
| HSTS | заголовок: открывать сайт только по защищённому соединению |
| CSP | заголовок: откуда странице можно грузить скрипты |
| CORS | правила: каким чужим сайтам можно читать данные сервера |
| SRI | проверка, что чужой скрипт на странице не подменили |
| XSS | внедрение чужого скрипта на страницу |
| mixed content | незащищённые файлы на защищённой странице |
| source map | карта исходного кода, открытая раскрывает код сайта |
| HttpOnly | флаг cookie: скрипты страницы её не читают |
| SameSite | флаг cookie против отправки с чужих сайтов |
| security.txt | файл с контактом для сообщений об уязвимостях |
| SPF | запись домена: какие серверы могут слать его почту |
| DKIM | подпись писем домена против подделки |
| DMARC | правило домена для поддельных писем |
| CAA | запись домена: кто может выпускать ему сертификаты |
| MX | запись домена: какой сервер принимает почту |
| DNS | система, которая находит сервер по имени сайта |
| WHOIS | сведения о регистрации и сроке домена |
| RDAP | служба сведений о регистрации домена |
| CDN | сеть серверов, которая быстро раздаёт файлы сайта |
| HTTP/2 | современная версия протокола, быстрее грузит много файлов |
| HTTP/3 | новейшая версия протокола, быстрее на мобильной сети |
| gzip | сжатие файлов при передаче |
| brotli | сжатие файлов при передаче, сильнее gzip |
| Cache-Control | заголовок: сколько браузер хранит файл |
| CMS | система управления сайтом, где правят страницы |
| SPA | сайт, где страницы рисует скрипт в браузере |
| SSR | страница собирается на сервере и приходит готовой |
| гидратация | готовая страница «оживает» после загрузки скрипта |
| DOM | устройство страницы так, как его видит браузер |
| JS | JavaScript, язык скриптов на страницах |
| iframe | окно с другой страницей внутри сайта |
| User-Agent | как браузер или робот называет себя сайту |
| lazy-load | картинки грузятся только при прокрутке к ним |
| preload | команда браузеру заранее скачать важный файл |
| font-display | правило: показывать ли текст до загрузки шрифта |
| woff2 | сжатый формат файлов шрифта для сайтов |
| WebP | современный формат картинок, легче JPEG и PNG |
| AVIF | новый формат картинок, обычно легче WebP |
| SVG | векторный формат картинок, чёткий на любом экране |
| bfcache | быстрый возврат кнопкой «Назад» без перезагрузки |
| PWA | сайт, который ставится на телефон как приложение |
| service worker | фоновый скрипт сайта для работы без сети |
| favicon | маленькая иконка сайта во вкладке браузера |
| apple-touch-icon | иконка сайта на экране iPhone |
| manifest | файл с названием и иконками для установки сайта |
| theme-color | цвет панели браузера на телефоне |
| HTML | язык разметки, из которого состоит страница сайта |
| H2 | заголовок второго уровня внутри страницы |
| CSS | правила внешнего вида страницы: цвета, размеры, отступы |
| URL | полный адрес страницы в строке браузера |
| API | способ, которым программы обмениваются данными с сервером |
| IP | числовой адрес сервера или устройства в сети |
| IPv6 | новая версия адресов устройств в интернете |
| CNAME | запись домена: имя ссылается на другой адрес |
| SSL | старое название защищённого соединения, теперь его называют TLS |
| SSL-сертификат | файл, который подтверждает защищённое соединение с сайтом |
| TLS-сертификат | файл, который подтверждает защищённое соединение с сайтом |
| CRM | система, где компания ведёт заявки и клиентов |
| Яндекс Метрика | счётчик Яндекса: посещения и действия посетителей сайта |
| Яндекс Метрики | счётчик Яндекса: посещения и действия посетителей сайта |
| Яндекс Метрике | счётчик Яндекса: посещения и действия посетителей сайта |
| Метрика | счётчик Яндекса: посещения и действия посетителей сайта |
| Метрике | счётчик Яндекса: посещения и действия посетителей сайта |
| Яндекс Вебмастер | кабинет Яндекса для владельца: индексация и ошибки |
| Google Analytics | счётчик Google: посещения и действия посетителей сайта |
| конверсия | доля посетителей, которые оставили заявку или купили |
| конверсию | доля посетителей, которые оставили заявку или купили |
| конверсии | доля посетителей, которые оставили заявку или купили |
| оффер | главное предложение сайта: что, кому, за сколько |
| оффера | главное предложение сайта: что, кому, за сколько |
| лендинг | одностраничный сайт под одно предложение |
| лендинга | одностраничный сайт под одно предложение |
| попап | всплывающее окно поверх страницы, например с формой |
| попапа | всплывающее окно поверх страницы, например с формой |
| попапе | всплывающее окно поверх страницы, например с формой |
| плейсхолдер | серый текст-подсказка внутри пустого поля формы |
| плейсхолдера | серый текст-подсказка внутри пустого поля формы |
| чекбокс | квадратик в форме, в котором ставят галочку |
| чекбокса | квадратик в форме, в котором ставят галочку |
| дизайн-токены | общие значения цветов, размеров и отступов сайта |
| кегль | размер букв шрифта, обычно в пикселях |
| кегля | размер букв шрифта, обычно в пикселях |
| глиф | рисунок отдельной буквы или знака в шрифте |
| глифы | рисунки отдельных букв и знаков в шрифте |
| неразрывный пробел | пробел, на котором строка не переносится |
| неразрывные пробелы | пробелы, на которых строка не переносится |
| висячий предлог | предлог в конце строки, оторванный от своего слова |
| висячие предлоги | предлоги в конце строки, оторванные от своих слов |
| редиректа | автоматический переход со старого адреса на новый |
| редиректы | автоматические переходы со старых адресов на новые |
| редиректов | автоматических переходов со старых адресов на новые |
| бургера | кнопка из трёх полосок, открывает меню на телефоне |
| бургере | кнопка из трёх полосок, открывает меню на телефоне |
| куки | небольшие записи, которые сайт хранит в браузере |
| фавикон | маленькая иконка сайта во вкладке браузера |
| JPEG | обычный формат фотографий, сжимает с потерей качества |
| PNG | формат картинок без потери качества, часто тяжёлый |
| WebView | встроенный браузер внутри приложения, например в Telegram |
| LIFT | разбор страницы: ценность, понятность, тревога, отвлечение, срочность |
| ICE | оценка идеи: влияние, уверенность, простота, каждая от 1 до 10 |
| GEO | работа над тем, чтобы ИИ-ассистенты находили и советовали сайт |
| EAA | европейский закон о доступности товаров и услуг |
| Impressum | обязательная страница с данными владельца сайта в Германии |
| ePrivacy | правила ЕС о cookie и электронной переписке |
| CCPA | закон Калифорнии о персональных данных потребителей |

## English

| Term | Meaning |
|---|---|
| LCP | when the main block of the first screen appears |
| CLS | how much the page jumps while loading |
| INP | how fast the page reacts to a tap or input |
| TBT | how long scripts keep the page busy and unresponsive |
| FCP | when the first content appears on screen |
| TTFB | how long the server takes to start answering |
| Core Web Vitals | Google's three main speed metrics: LCP, INP, CLS |
| CWV | Google's three main speed metrics |
| PageSpeed Insights | Google's service for measuring page speed |
| PSI | PageSpeed Insights, Google's page speed service |
| CrUX | site speed for real visitors, from Google data |
| Lighthouse | Chrome's built-in page speed and quality test |
| canonical | tells search engines which page address is the main one |
| hreflang | links language versions of a page for search engines |
| noindex | keeps the page out of search results |
| robots.txt | file with rules for search engine crawlers |
| sitemap | list of site addresses for search engine crawlers |
| sitemap.xml | file listing site addresses for search engines |
| soft-404 | a missing page answers as if it exists |
| redirect | automatic jump from an old address to a new one |
| title | page name in the browser tab and in search |
| description | page summary shown under the title in search |
| H1 | the main heading on the page itself |
| JSON-LD | hidden company and price data for search engines |
| structured data | hidden data about prices, address, reviews for search |
| Schema.org | shared vocabulary of structured data for search engines |
| FAQPage | markup of questions and answers for search engines |
| LocalBusiness | markup with company address, hours and phone |
| breadcrumbs | path line like "Home → Section → Page" |
| Open Graph | data for link previews in messengers and social networks |
| OG | data for link previews in messengers |
| og:image | the picture in a link preview |
| alt | picture description for blind people and search engines |
| snippet | the site's block in search: title, description, link |
| search intent | what a person really wants when typing a query |
| cannibalization | two pages of the site compete for one query |
| E-E-A-T | signs of author experience and trust valued by Google |
| YMYL | money and health topics where search is stricter |
| IndexNow | way to tell search engines about changed pages at once |
| llms.txt | file describing the site for AI assistants |
| X-Robots-Tag | indexing ban sent in the server response |
| Search Console | Google's dashboard for site owners: indexing and errors |
| SEO | work to make the site found in search |
| UX | how easy the site is for a visitor |
| UI | look and controls of the interface |
| CTA | main action button: "Book", "Buy" |
| first screen | what is visible without scrolling |
| above the fold | what is visible without scrolling |
| burger menu | three-line button that opens the menu on phones |
| breakpoint | screen width where the layout changes |
| viewport | visible part of the page in the browser window |
| DPR | screen pixel density, usually 2–3 on phones |
| hover | pointing the mouse at an element |
| hit-test | check which element ends up under the finger |
| 100vh | "full screen" height, buggy on iPhone |
| WCAG | international website accessibility standard |
| AA | main requirement level of the WCAG standard |
| AAA | highest, optional requirement level of WCAG |
| ARIA | hints about element roles for screen readers |
| axe | automatic accessibility test of a page |
| screen reader | program that reads the screen aloud to blind people |
| focus | highlight of the element the keyboard is on |
| skip link | "skip to content" link for keyboard users |
| reflow | page re-flows when zoomed, without sideways scrolling |
| forced-colors | Windows high contrast mode |
| prefers-reduced-motion | system setting "reduce motion" |
| APCA | contrast method that accounts for dark backgrounds and stroke weight; Lc is negative for light text on dark; threshold by absolute value: body text 75, large 60, thin and small 90 |
| personal data | name, phone, email and other data about a person |
| GDPR | EU law on personal data protection |
| CCPA | California law on consumer personal data |
| ePrivacy | EU rules on cookies and electronic communications |
| cookie | small records a site keeps in the browser |
| call tracking | substitute phone numbers to count calls by source |
| UTM | link tags that show where a visitor came from |
| GTM | Google Tag Manager, manager of site trackers |
| dataLayer | page data for analytics and ads |
| honeypot | hidden trap field for spam bots in a form |
| CAPTCHA | "I am not a robot" check |
| HTTPS | secure connection to the site |
| TLS | encryption between the browser and the site |
| HSTS | header: open the site over a secure connection only |
| CSP | header: where the page may load scripts from |
| CORS | rules for which other sites may read server data |
| SRI | check that a third-party script was not replaced |
| XSS | injection of a foreign script into the page |
| mixed content | insecure files on a secure page |
| source map | source code map; public ones expose the code |
| HttpOnly | cookie flag: page scripts cannot read it |
| SameSite | cookie flag against sending from other sites |
| security.txt | file with a contact for vulnerability reports |
| SPF | domain record: which servers may send its mail |
| DKIM | signature of the domain's mail against forgery |
| DMARC | domain rule for forged mail |
| CAA | domain record: who may issue its certificates |
| MX | domain record: which server receives mail |
| DNS | system that finds the server by the site name |
| WHOIS | domain registration and expiry details |
| RDAP | service with domain registration details |
| CDN | server network that delivers site files quickly |
| HTTP/2 | modern protocol version, faster with many files |
| HTTP/3 | newest protocol version, faster on mobile networks |
| gzip | compression of files in transfer |
| brotli | compression of files in transfer, stronger than gzip |
| Cache-Control | header: how long the browser keeps a file |
| CMS | content management system where pages are edited |
| SPA | site whose pages a browser script draws |
| SSR | page is built on the server and arrives ready |
| hydration | the ready page comes alive after the script loads |
| DOM | page structure as the browser sees it |
| JS | JavaScript, the scripting language of pages |
| iframe | window with another page inside the site |
| User-Agent | how a browser or bot names itself to the site |
| lazy loading | pictures load only when scrolled to |
| preload | tells the browser to fetch an important file early |
| font-display | rule: show text before the font loads or not |
| woff2 | compressed font file format for websites |
| WebP | modern picture format, lighter than JPEG and PNG |
| AVIF | new picture format, usually lighter than WebP |
| SVG | vector picture format, sharp on any screen |
| bfcache | instant return with the Back button, no reload |
| PWA | site that installs on a phone like an app |
| service worker | background script of a site for offline work |
| favicon | small site icon in the browser tab |
| apple-touch-icon | site icon on the iPhone home screen |
| manifest | file with the name and icons for installing the site |
| theme-color | color of the browser bar on phones |
| HTML | markup language that web pages are made of |
| H2 | second-level heading inside a page |
| CSS | page style rules: colors, sizes, spacing |
| URL | full page address in the browser bar |
| API | way programs exchange data with a server |
| IP | numeric address of a server or device |
| IPv6 | newer version of internet device addresses |
| CNAME | domain record that points a name to another address |
| SSL | old name of the secure connection, now called TLS |
| SSL certificate | file that proves a secure connection to the site |
| CRM | system where a company tracks leads and clients |
| Google Analytics | Google's counter of visits and visitor actions |
| Yandex Metrica | Yandex's counter of visits and visitor actions |
| Metrica | Yandex Metrica, counter of visits and visitor actions |
| Webvisor | session recording of visitors in Yandex Metrica |
| Yandex Webmaster | Yandex dashboard for site owners: indexing and errors |
| Webmaster | Yandex Webmaster, dashboard for indexing and errors |
| Clean-param | Yandex rule: which URL parameters to ignore |
| 152-FZ | Russian law on personal data |
| 38-FZ | Russian law on advertising |
| RKN | Roskomnadzor, Russian regulator of personal data and communications |
| ad labeling | mandatory "Ad" mark with advertiser details in Russia |
| erid | ad ID for mandatory ad labeling in Russia |
| ClientID | visitor number in an analytics system |
| cross-border transfer | sending personal data to servers in another country |
| MPK | Yandex filter for low-value content |
| rescale | script that shrinks the whole page to the window |
| conversion | share of visitors who leave a request or buy |
| conversion rate | share of visitors who leave a request or buy |
| landing page | one-page site built for a single offer |
| popup | window that pops up over the page, often a form |
| popups | windows that pop up over the page, often forms |
| placeholder | hint text inside an empty field; also stub content |
| checkbox | small square in a form that you tick |
| design tokens | shared values for site colors, sizes and spacing |
| glyph | drawing of a single letter or sign in a font |
| glyphs | drawings of letters and signs in a font |
| non-breaking space | space where the line never breaks |
| redirects | automatic jumps from old addresses to new ones |
| cookies | small records a site keeps in the browser |
| JPEG | common photo format, compresses with quality loss |
| PNG | picture format without quality loss, often heavy |
| WebView | built-in browser inside an app, like Telegram |
| LIFT | page review: value, relevance, clarity, anxiety, distraction, urgency |
| ICE | idea score: impact, confidence, ease, each 1 to 10 |
| GEO | work to make AI assistants find and recommend the site |
| EAA | EU law on accessibility of products and services |
| Impressum | mandatory page with site owner details in Germany |

<!-- revizor:glossary {"LCP":"когда показался главный блок первого экрана","CLS":"насколько страница прыгает и сдвигается при загрузке","INP":"как быстро страница откликается на нажатие или ввод","TBT":"сколько времени скрипты занимают страницу и она не отвечает","FCP":"когда на экране появилось первое содержимое","TTFB":"сколько сервер готовит ответ до первого байта","Core Web Vitals":"три главных показателя скорости страницы по Google","CWV":"три главных показателя скорости по Google","PageSpeed Insights":"сервис Google для замера скорости страницы","PSI":"PageSpeed Insights, сервис Google для замера скорости","CrUX":"скорость сайта у настоящих посетителей по данным Google","Lighthouse":"встроенный в Chrome замер скорости и качества страницы","canonical":"подсказка поисковику, какой адрес страницы считать главным","hreflang":"связь языковых версий страницы для поисковиков","noindex":"запрет показывать страницу в поиске","robots.txt":"файл с правилами для поисковых роботов","sitemap":"список адресов сайта для поисковых роботов","sitemap.xml":"файл со списком адресов сайта для поисковиков","soft-404":"несуществующая страница отвечает так, будто она есть","редирект":"автоматический переход со старого адреса на новый (301 — постоянный)","title":"заголовок страницы во вкладке браузера и в поиске","description":"описание страницы, которое поиск показывает под заголовком","H1":"главный заголовок на самой странице","JSON-LD":"скрытые данные о компании и ценах для поисковиков","микроразметка":"скрытые данные о ценах, адресе, отзывах для поиска","Schema.org":"общий словарь скрытой разметки для поисковиков","FAQPage":"разметка вопросов и ответов для поисковиков","LocalBusiness":"разметка с адресом, часами и телефоном компании","хлебные крошки":"строка пути вида «Главная → Раздел → Страница»","Open Graph":"данные для превью ссылки в мессенджерах и соцсетях","OG":"данные для превью ссылки в мессенджерах","og:image":"картинка в превью ссылки в мессенджерах","alt":"описание картинки для незрячих людей и поисковиков","сниппет":"блок сайта в выдаче: заголовок, описание, ссылка","интент":"что на самом деле хочет человек, вводя запрос","каннибализация":"две страницы сайта борются за один запрос","МПК":"фильтр Яндекса за малополезное содержимое","E-E-A-T":"признаки опыта и надёжности автора, которые ценит Google","YMYL":"темы о деньгах и здоровье, где поиск строже","IndexNow":"способ сразу сообщить поисковикам об изменённых страницах","llms.txt":"файл с описанием сайта для ИИ-ассистентов","Clean-param":"правило Яндекса: какие метки в адресах не учитывать","X-Robots-Tag":"запрет индексации в ответе сервера","Вебмастер":"кабинет Яндекса для владельца: индексация и ошибки","Search Console":"кабинет Google для владельца: индексация и ошибки","SEO":"работа над тем, чтобы сайт находили в поиске","UX":"удобство сайта для посетителя","UI":"внешний вид и элементы интерфейса","CTA":"кнопка главного действия: «Записаться», «Купить»","первый экран":"то, что видно сразу без прокрутки","бургер":"кнопка из трёх полосок, открывает меню на телефоне","брейкпоинт":"ширина экрана, на которой меняется раскладка","viewport":"видимая часть страницы в окне браузера","DPR":"плотность пикселей экрана, у телефонов обычно 2–3","hover":"наведение курсора мыши на элемент","hit-test":"проверка, какой элемент окажется под пальцем","rescale":"скрипт ужимает всю страницу под ширину окна","100vh":"высота «на весь экран», на iPhone работает с ошибками","WCAG":"международный стандарт доступности сайтов","AA":"основной уровень требований стандарта доступности WCAG","ARIA":"атрибуты-подсказки о роли элементов для программ чтения экрана","axe":"автоматическая проверка доступности страницы","скринридер":"программа, которая читает экран вслух незрячим людям","фокус":"выделение элемента, на котором сейчас клавиатура","skip-link":"ссылка «к содержанию» для перехода с клавиатуры","reflow":"страница перестраивается при увеличении без прокрутки вбок","forced-colors":"режим высокой контрастности в Windows","prefers-reduced-motion":"настройка системы «уменьшить движение»","APCA":"способ считать контраст с учётом тёмного фона и толщины букв; цифра Lc, у светлого текста на тёмном — с минусом; порог по модулю: основной текст 75, крупный 60, тонкий и мелкий 90","ПДн":"персональные данные: имя, телефон, почта человека","152-ФЗ":"российский закон о персональных данных","38-ФЗ":"российский закон о рекламе","GDPR":"европейский закон о защите персональных данных","РКН":"Роскомнадзор, ведомство по персональным данным и связи","трансграничная передача":"передача персональных данных на серверы за рубежом","маркировка рекламы":"обязательная пометка «Реклама» с данными рекламодателя","erid":"номер рекламы для маркировки по закону","cookie":"небольшие записи, которые сайт хранит в браузере","коллтрекинг":"подменные номера телефона для учёта звонков по источникам","UTM":"метки в ссылке, по которым видно источник посетителя","ClientID":"номер посетителя в системе аналитики","Вебвизор":"запись действий посетителей в Яндекс Метрике","GTM":"Google Tag Manager, менеджер счётчиков на сайте","dataLayer":"данные страницы для счётчиков и рекламы","honeypot":"скрытое поле-ловушка для спам-ботов в форме","капча":"проверка «я не робот»","HTTPS":"защищённое соединение с сайтом","TLS":"шифрование соединения между браузером и сайтом","HSTS":"заголовок: открывать сайт только по защищённому соединению","CSP":"заголовок: откуда странице можно грузить скрипты","CORS":"правила: каким чужим сайтам можно читать данные сервера","SRI":"проверка, что чужой скрипт на странице не подменили","XSS":"внедрение чужого скрипта на страницу","mixed content":"незащищённые файлы на защищённой странице","source map":"карта исходного кода, открытая раскрывает код сайта","HttpOnly":"флаг cookie: скрипты страницы её не читают","SameSite":"флаг cookie против отправки с чужих сайтов","security.txt":"файл с контактом для сообщений об уязвимостях","SPF":"запись домена: какие серверы могут слать его почту","DKIM":"подпись писем домена против подделки","DMARC":"правило домена для поддельных писем","CAA":"запись домена: кто может выпускать ему сертификаты","MX":"запись домена: какой сервер принимает почту","DNS":"система, которая находит сервер по имени сайта","WHOIS":"сведения о регистрации и сроке домена","RDAP":"служба сведений о регистрации домена","CDN":"сеть серверов, которая быстро раздаёт файлы сайта","HTTP/2":"современная версия протокола, быстрее грузит много файлов","HTTP/3":"новейшая версия протокола, быстрее на мобильной сети","gzip":"сжатие файлов при передаче","brotli":"сжатие файлов при передаче, сильнее gzip","Cache-Control":"заголовок: сколько браузер хранит файл","CMS":"система управления сайтом, где правят страницы","SPA":"сайт, где страницы рисует скрипт в браузере","SSR":"страница собирается на сервере и приходит готовой","гидратация":"готовая страница «оживает» после загрузки скрипта","DOM":"устройство страницы так, как его видит браузер","JS":"JavaScript, язык скриптов на страницах","iframe":"окно с другой страницей внутри сайта","User-Agent":"как браузер или робот называет себя сайту","lazy-load":"картинки грузятся только при прокрутке к ним","preload":"команда браузеру заранее скачать важный файл","font-display":"правило: показывать ли текст до загрузки шрифта","woff2":"сжатый формат файлов шрифта для сайтов","WebP":"современный формат картинок, легче JPEG и PNG","AVIF":"новый формат картинок, обычно легче WebP","SVG":"векторный формат картинок, чёткий на любом экране","bfcache":"быстрый возврат кнопкой «Назад» без перезагрузки","PWA":"сайт, который ставится на телефон как приложение","service worker":"фоновый скрипт сайта для работы без сети","favicon":"маленькая иконка сайта во вкладке браузера","apple-touch-icon":"иконка сайта на экране iPhone","manifest":"файл с названием и иконками для установки сайта","theme-color":"цвет панели браузера на телефоне","HTML":"язык разметки, из которого состоит страница сайта","H2":"заголовок второго уровня внутри страницы","CSS":"правила внешнего вида страницы: цвета, размеры, отступы","URL":"полный адрес страницы в строке браузера","API":"способ, которым программы обмениваются данными с сервером","IP":"числовой адрес сервера или устройства в сети","IPv6":"новая версия адресов устройств в интернете","CNAME":"запись домена: имя ссылается на другой адрес","SSL":"старое название защищённого соединения, теперь его называют TLS","SSL-сертификат":"файл, который подтверждает защищённое соединение с сайтом","TLS-сертификат":"файл, который подтверждает защищённое соединение с сайтом","CRM":"система, где компания ведёт заявки и клиентов","Яндекс Метрика":"счётчик Яндекса: посещения и действия посетителей сайта","Яндекс Метрики":"счётчик Яндекса: посещения и действия посетителей сайта","Яндекс Метрике":"счётчик Яндекса: посещения и действия посетителей сайта","Яндекс Вебмастер":"кабинет Яндекса для владельца: индексация и ошибки","Google Analytics":"счётчик Google: посещения и действия посетителей сайта","конверсия":"доля посетителей, которые оставили заявку или купили","конверсию":"доля посетителей, которые оставили заявку или купили","конверсии":"доля посетителей, которые оставили заявку или купили","оффер":"главное предложение сайта: что, кому, за сколько","оффера":"главное предложение сайта: что, кому, за сколько","лендинг":"одностраничный сайт под одно предложение","лендинга":"одностраничный сайт под одно предложение","попап":"всплывающее окно поверх страницы, например с формой","попапа":"всплывающее окно поверх страницы, например с формой","попапе":"всплывающее окно поверх страницы, например с формой","плейсхолдер":"серый текст-подсказка внутри пустого поля формы","плейсхолдера":"серый текст-подсказка внутри пустого поля формы","чекбокс":"квадратик в форме, в котором ставят галочку","чекбокса":"квадратик в форме, в котором ставят галочку","дизайн-токены":"общие значения цветов, размеров и отступов сайта","кегль":"размер букв шрифта, обычно в пикселях","кегля":"размер букв шрифта, обычно в пикселях","глиф":"рисунок отдельной буквы или знака в шрифте","глифы":"рисунки отдельных букв и знаков в шрифте","неразрывный пробел":"пробел, на котором строка не переносится","неразрывные пробелы":"пробелы, на которых строка не переносится","висячий предлог":"предлог в конце строки, оторванный от своего слова","висячие предлоги":"предлоги в конце строки, оторванные от своих слов","редиректа":"автоматический переход со старого адреса на новый","редиректы":"автоматические переходы со старых адресов на новые","редиректов":"автоматических переходов со старых адресов на новые","бургера":"кнопка из трёх полосок, открывает меню на телефоне","бургере":"кнопка из трёх полосок, открывает меню на телефоне","куки":"небольшие записи, которые сайт хранит в браузере","фавикон":"маленькая иконка сайта во вкладке браузера","JPEG":"обычный формат фотографий, сжимает с потерей качества","PNG":"формат картинок без потери качества, часто тяжёлый","WebView":"встроенный браузер внутри приложения, например в Telegram","LIFT":"разбор страницы: ценность, понятность, тревога, отвлечение, срочность","ICE":"оценка идеи: влияние, уверенность, простота, каждая от 1 до 10","GEO":"работа над тем, чтобы ИИ-ассистенты находили и советовали сайт","EAA":"европейский закон о доступности товаров и услуг","Impressum":"обязательная страница с данными владельца сайта в Германии","ePrivacy":"правила ЕС о cookie и электронной переписке","CCPA":"закон Калифорнии о персональных данных потребителей","AAA":"высший, необязательный уровень требований WCAG","Метрика":"счётчик Яндекса: посещения и действия посетителей сайта","Метрике":"счётчик Яндекса: посещения и действия посетителей сайта"} -->

<!-- revizor:glossary-en {"LCP":"when the main block of the first screen appears","CLS":"how much the page jumps while loading","INP":"how fast the page reacts to a tap or input","TBT":"how long scripts keep the page busy and unresponsive","FCP":"when the first content appears on screen","TTFB":"how long the server takes to start answering","Core Web Vitals":"Google's three main speed metrics: LCP, INP, CLS","CWV":"Google's three main speed metrics","PageSpeed Insights":"Google's service for measuring page speed","PSI":"PageSpeed Insights, Google's page speed service","CrUX":"site speed for real visitors, from Google data","Lighthouse":"Chrome's built-in page speed and quality test","canonical":"tells search engines which page address is the main one","hreflang":"links language versions of a page for search engines","noindex":"keeps the page out of search results","robots.txt":"file with rules for search engine crawlers","sitemap":"list of site addresses for search engine crawlers","sitemap.xml":"file listing site addresses for search engines","soft-404":"a missing page answers as if it exists","redirect":"automatic jump from an old address to a new one","title":"page name in the browser tab and in search","description":"page summary shown under the title in search","H1":"the main heading on the page itself","JSON-LD":"hidden company and price data for search engines","structured data":"hidden data about prices, address, reviews for search","Schema.org":"shared vocabulary of structured data for search engines","FAQPage":"markup of questions and answers for search engines","LocalBusiness":"markup with company address, hours and phone","breadcrumbs":"path line like \"Home → Section → Page\"","Open Graph":"data for link previews in messengers and social networks","OG":"data for link previews in messengers","og:image":"the picture in a link preview","alt":"picture description for blind people and search engines","snippet":"the site's block in search: title, description, link","search intent":"what a person really wants when typing a query","cannibalization":"two pages of the site compete for one query","E-E-A-T":"signs of author experience and trust valued by Google","YMYL":"money and health topics where search is stricter","IndexNow":"way to tell search engines about changed pages at once","llms.txt":"file describing the site for AI assistants","X-Robots-Tag":"indexing ban sent in the server response","Search Console":"Google's dashboard for site owners: indexing and errors","SEO":"work to make the site found in search","UX":"how easy the site is for a visitor","UI":"look and controls of the interface","CTA":"main action button: \"Book\", \"Buy\"","first screen":"what is visible without scrolling","above the fold":"what is visible without scrolling","burger menu":"three-line button that opens the menu on phones","breakpoint":"screen width where the layout changes","viewport":"visible part of the page in the browser window","DPR":"screen pixel density, usually 2–3 on phones","hover":"pointing the mouse at an element","hit-test":"check which element ends up under the finger","100vh":"\"full screen\" height, buggy on iPhone","WCAG":"international website accessibility standard","AA":"main requirement level of the WCAG standard","ARIA":"hints about element roles for screen readers","axe":"automatic accessibility test of a page","screen reader":"program that reads the screen aloud to blind people","focus":"highlight of the element the keyboard is on","skip link":"\"skip to content\" link for keyboard users","reflow":"page re-flows when zoomed, without sideways scrolling","forced-colors":"Windows high contrast mode","prefers-reduced-motion":"system setting \"reduce motion\"","APCA":"contrast method that accounts for dark backgrounds and stroke weight; Lc is negative for light text on dark; threshold by absolute value: body text 75, large 60, thin and small 90","personal data":"name, phone, email and other data about a person","GDPR":"EU law on personal data protection","CCPA":"California law on consumer personal data","ePrivacy":"EU rules on cookies and electronic communications","cookie":"small records a site keeps in the browser","call tracking":"substitute phone numbers to count calls by source","UTM":"link tags that show where a visitor came from","GTM":"Google Tag Manager, manager of site trackers","dataLayer":"page data for analytics and ads","honeypot":"hidden trap field for spam bots in a form","CAPTCHA":"\"I am not a robot\" check","HTTPS":"secure connection to the site","TLS":"encryption between the browser and the site","HSTS":"header: open the site over a secure connection only","CSP":"header: where the page may load scripts from","CORS":"rules for which other sites may read server data","SRI":"check that a third-party script was not replaced","XSS":"injection of a foreign script into the page","mixed content":"insecure files on a secure page","source map":"source code map; public ones expose the code","HttpOnly":"cookie flag: page scripts cannot read it","SameSite":"cookie flag against sending from other sites","security.txt":"file with a contact for vulnerability reports","SPF":"domain record: which servers may send its mail","DKIM":"signature of the domain's mail against forgery","DMARC":"domain rule for forged mail","CAA":"domain record: who may issue its certificates","MX":"domain record: which server receives mail","DNS":"system that finds the server by the site name","WHOIS":"domain registration and expiry details","RDAP":"service with domain registration details","CDN":"server network that delivers site files quickly","HTTP/2":"modern protocol version, faster with many files","HTTP/3":"newest protocol version, faster on mobile networks","gzip":"compression of files in transfer","brotli":"compression of files in transfer, stronger than gzip","Cache-Control":"header: how long the browser keeps a file","CMS":"content management system where pages are edited","SPA":"site whose pages a browser script draws","SSR":"page is built on the server and arrives ready","hydration":"the ready page comes alive after the script loads","DOM":"page structure as the browser sees it","JS":"JavaScript, the scripting language of pages","iframe":"window with another page inside the site","User-Agent":"how a browser or bot names itself to the site","lazy loading":"pictures load only when scrolled to","preload":"tells the browser to fetch an important file early","font-display":"rule: show text before the font loads or not","woff2":"compressed font file format for websites","WebP":"modern picture format, lighter than JPEG and PNG","AVIF":"new picture format, usually lighter than WebP","SVG":"vector picture format, sharp on any screen","bfcache":"instant return with the Back button, no reload","PWA":"site that installs on a phone like an app","service worker":"background script of a site for offline work","favicon":"small site icon in the browser tab","apple-touch-icon":"site icon on the iPhone home screen","manifest":"file with the name and icons for installing the site","theme-color":"color of the browser bar on phones","HTML":"markup language that web pages are made of","H2":"second-level heading inside a page","CSS":"page style rules: colors, sizes, spacing","URL":"full page address in the browser bar","API":"way programs exchange data with a server","IP":"numeric address of a server or device","IPv6":"newer version of internet device addresses","CNAME":"domain record that points a name to another address","SSL":"old name of the secure connection, now called TLS","SSL certificate":"file that proves a secure connection to the site","CRM":"system where a company tracks leads and clients","Google Analytics":"Google's counter of visits and visitor actions","Yandex Metrica":"Yandex's counter of visits and visitor actions","Metrica":"Yandex Metrica, counter of visits and visitor actions","Webvisor":"session recording of visitors in Yandex Metrica","Yandex Webmaster":"Yandex dashboard for site owners: indexing and errors","Webmaster":"Yandex Webmaster, dashboard for indexing and errors","Clean-param":"Yandex rule: which URL parameters to ignore","152-FZ":"Russian law on personal data","38-FZ":"Russian law on advertising","RKN":"Roskomnadzor, Russian regulator of personal data and communications","ad labeling":"mandatory \"Ad\" mark with advertiser details in Russia","erid":"ad ID for mandatory ad labeling in Russia","ClientID":"visitor number in an analytics system","cross-border transfer":"sending personal data to servers in another country","MPK":"Yandex filter for low-value content","rescale":"script that shrinks the whole page to the window","conversion":"share of visitors who leave a request or buy","conversion rate":"share of visitors who leave a request or buy","landing page":"one-page site built for a single offer","popup":"window that pops up over the page, often a form","popups":"windows that pop up over the page, often forms","placeholder":"hint text inside an empty field; also stub content","checkbox":"small square in a form that you tick","design tokens":"shared values for site colors, sizes and spacing","glyph":"drawing of a single letter or sign in a font","glyphs":"drawings of letters and signs in a font","non-breaking space":"space where the line never breaks","redirects":"automatic jumps from old addresses to new ones","cookies":"small records a site keeps in the browser","JPEG":"common photo format, compresses with quality loss","PNG":"picture format without quality loss, often heavy","WebView":"built-in browser inside an app, like Telegram","LIFT":"page review: value, relevance, clarity, anxiety, distraction, urgency","ICE":"idea score: impact, confidence, ease, each 1 to 10","GEO":"work to make AI assistants find and recommend the site","EAA":"EU law on accessibility of products and services","Impressum":"mandatory page with site owner details in Germany","AAA":"highest, optional requirement level of WCAG"} -->
