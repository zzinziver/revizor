# Слова → флаги (общий словарь команд Ревизора)

Файл одинаковый во всех папках `skills/*/`. Им пользуется оркестратор, когда человек пишет команду словами: «/revizor:full example.ru для чужой команды, бета, без вопросов, с оценками, PDF» или «/revizor:full example.ru for a client, beta, no questions».

## Как читать
- Регистр, ё/е и форма слова не важны: «чужой команде», «для чужой команды», «чужая команда» — одно и то же. Английские слова — так же.
- Флаг в команде сильнее слова. Слово сильнее `~/.revizor/config.json`.
- Адрес сайта — первое, что похоже на домен или URL (`example.ru`, `https://example.ru/menu`). Схему и метки (`utm_*`, `yclid`…) `init-run.mjs` поправит сам.
- Число рядом со словом «страниц» (pages) → `--pages N`; путь рядом со словом «страница» (page) → `--page <путь>`.
- Распознано не всё или слово подходит к двум флагам → одна строка «Понял так: аудитория — чужая команда, стадия — бета, оценки — нет. Верно?» и ждать ответа. Всё распознано → не переспрашивать.
- Рискованные флаги только по явной просьбе, словами не включать: `--probe` (ещё и с подтверждением «это ваш сайт?»), `--allow-load-posts`.

## Подписка → `--subscription`
| Слова | Флаг |
|---|---|
| у меня Pro, подписка Pro, на Pro, I have Pro, on Pro | `--subscription pro` |
| Max 5, Max 5×, max5 | `--subscription max5` |
| Max 20, Max 20×, max20 | `--subscription max20` |
| API, по API, Team, Enterprise, корпоративная | `--subscription api` |

Pro по умолчанию — облегчённый объём, все агенты на Sonnet, 3 агента одновременно. Слова об объёме и моделях в той же команде сильнее подписки.

## Кому отчёт → `--audience`
| Слова | Флаг |
|---|---|
| себе, мне, для себя, я владелец, владельцу, для руководства, для директора, for me, for myself, owner | `--audience owner` |
| своей команде, разработчику, подрядчику, технический, с техническими деталями, for my team, for developers, technical | `--audience team` |
| чужой команде, клиенту, заказчику, другому отделу, наружу, вежливо, без внутренней кухни, for a client, for another team, client-facing, external | `--audience external` |

## Объём → `--depth`, модели → `--models`, по частям → `--parts`
| Слова | Флаг |
|---|---|
| облегчённо, лёгкий, покороче, бережно к лимиту, lite, light, short | `--depth lite` |
| обычно, стандартно, standard, normal | `--depth standard` |
| глубоко, подробно, по полной, максимально подробно, deep, thorough, in depth | `--depth deep` |
| только быстрые проверки, только замеры, только здоровье сайта, quick checks only | в `full` — после создания прогона `--answer depth=quick` (замеры и короткий отчёт); в `quick` — тема `health` |
| по частям, частями, в несколько заходов, в N захода, in parts, in N parts | `--parts 3` (или N: 2–4); только `full` |
| дёшево, экономно по лимиту, на sonnet, economy, cheap | `--models economy` |
| сбалансированно, balanced | `--models balanced` |
| лучшими моделями, максимум качества, на opus, max, best models | `--models max` |

## Строгость → `--profile`
| Слова | Флаг |
|---|---|
| строго, строгий вкус, придирчиво, strict, picky | `--profile strict` |
| обычный профиль, без строгого вкуса, standard profile | `--profile standard` |

## Стадия → `--stage`
| Слова | Флаг |
|---|---|
| бета, beta, тестовый стенд, перед запуском, предрелиз, staging, pre-launch | `--stage beta` |
| прототип, макет, черновик сайта, prototype, mockup | `--stage prototype` |
| боевой, живой, рабочий, в эфире, live, production | `--stage live` |

## Язык, рынок, тип сайта
| Слова | Флаг |
|---|---|
| по-английски, на английском, in English, English report | `--lang en` |
| по-русски, на русском, in Russian | `--lang ru` |
| для России, РФ, под Яндекс, Russian market | `--market ru` |
| зарубежный, международный, для Европы, для США, под Google, international | `--market intl` |
| лендинг, одностраничник, landing page | `--vertical landing` |
| услуги, салон, студия, кофейня, ремонт, местный бизнес, local business | `--vertical local-services` |
| интернет-магазин, магазин с корзиной, online store, e-commerce | `--vertical shop` |
| сервис, SaaS, веб-приложение, web app | `--vertical saas` |
| банк, финансы, страхование, кредиты, вклады, брокер, bank, finance | `--vertical finance` |
| СМИ, блог, журнал, новости, media, blog | `--vertical media` |
| портфолио, личный сайт, portfolio | `--vertical portfolio` |
| фонд, НКО, благотворительность, charity, nonprofit | `--vertical nonprofit` |
| клиника, медицина, врач, clinic, medical | `--vertical medical` |
| школа, курсы, обучение, school, courses | `--vertical education` |
| госсайт, ведомство, госуслуги, government | `--vertical gov` |

## Включить и выключить
| Слова | Флаг |
|---|---|
| с оценками, оценить, баллы, «из 10», with scores, rate it, score it | `--scores` |
| без оценок, no scores | `--no-scores` |
| стратегия, план развития, SEO-стратегия, strategy | `--strategy` |
| PDF, пдф | `--pdf` |
| без вопросов, не спрашивай, сам реши, no questions, don't ask | `--no-questions` |
| без конкурентов, no competitors | `--no-rivals` |
| проверь орфографию через Спеллер, spell check | `--spell` |
| без Спеллера, текст наружу не отправлять, no spell check | `--no-spell` |
| оставь все кадры, не чисти, keep screenshots | `--keep-raw` |
| N страниц, до N страниц, N pages | `--pages N` |
| только страница /x (можно несколько), only page /x | `--page /x` |
| по N агентов одновременно, N agents at once | `--parallel N` |
| только линзы X, Y, only X, Y | `--lenses X,Y` (имена — таблица ниже) |
| без X, кроме X, skip X | `--skip X` |
| переезд, старый сайт <адрес>, было <адрес>, old site <адрес> | `--baseline <адрес>` |
| решения или факты в файле <путь> | `--brief "<путь>"` |
| сохранить в папку <путь>, save to <путь> | `--out "<путь>"` |
| продолжить, продолжи, возобнови, доделай, continue, resume | `--resume [хост или папка]` |
| проверь служебные пути, открытые файлы на моём сайте | `--probe` (только после «да, это мой сайт») |

## Линзы и темы (`quick <тема>`, `--lenses`, `--skip`)
| id | Слова |
|---|---|
| `product` | продукт, оффер, путь к заявке, конверсия, воронка, offer, conversion |
| `facts` | факты, цены, противоречия, калькулятор, facts, prices |
| `visitor` | глазами посетителя, первое впечатление, 5 секунд, first impression |
| `ux` | удобство, UX, навигация, меню, сценарии, usability, navigation |
| `visual` | дизайн, визуал, внешний вид, design, look |
| `typography` | шрифты, типографика, fonts, typography |
| `color` | цвет, контраст, яркость, дальтонизм, тёмная тема, color, contrast, dark mode |
| `mobile` | мобильная, телефон, смартфон, адаптив, планшет, ноутбук, mobile, phone, responsive |
| `a11y` | доступность, WCAG, скринридер, клавиатура, accessibility, screen reader, keyboard |
| `copy` | тексты, язык, орфография, грамматика, нейрослоп, редактура, texts, copy, grammar, spelling |
| `seo` | SEO, поиск, продвижение (в quick — техническое и контентное вместе) |
| `seo-tech` | техническое SEO, индексация, robots, sitemap, редиректы, canonical, битые ссылки, 404, broken links, indexing, redirects |
| `seo-content` | контентное SEO, запросы, title и description, сниппеты, соцпревью, titles, snippets |
| `perf` | скорость, загрузка, тормозит, долго грузится, медленно, Core Web Vitals, LCP, speed, slow, performance |
| `stability` | ошибки, консоль, JS-ошибки, что сломано, errors, console, broken |
| `forms` | формы, заявки, аналитика, счётчики, цели, forms, leads, analytics |
| `security` | безопасность, SSL, https, сертификат, замок в браузере, заголовки, домен, почта домена, security, certificate |
| `privacy` | cookie, куки, приватность, персональные данные, трекеры, cookies, privacy, trackers |
| `legal` | право, закон, 152-ФЗ, реклама, маркировка, GDPR, оферта, legal, law |
| `ecommerce` | корзина, каталог, карточка товара, cart, catalog, checkout |
| `i18n` | языки, переводы, языковые версии, hreflang, languages, translations |
| `health` | здоровье сайта, мониторинг, всё ли работает, health, monitoring, uptime (только quick) |

## /revizor:rivals
| Слова | Что делать |
|---|---|
| первый адрес | наш сайт → `--url` |
| остальные адреса, «конкуренты: a, b», competitors | файлом: `"urls"` в `<RUN>/answers/rivals.json`, затем `init-run.mjs --answer-file` (см. SKILL.md; в командную строку адреса конкурентов не пишем) |
| «a — прямой», «b — ориентир», «c — похожий» | в том же файле: `"groups": { "a": "прямой", "b": "ориентир", "c": "сопоставимый" }` |
| «беру: …», «нет: …», «обсудить: …», «мои решения» + текст | режим решений: `memory.mjs … --decisions-file` (см. SKILL.md) |
| конкуренты, разбор конкурентов, competitors (в `full` или `quick`) | подсказать команду `/revizor:rivals <адрес>` |

## /revizor:recheck
| Слова | Что делать |
|---|---|
| ничего | список последних прогонов и вопрос |
| домен или адрес | `--from <хост>` — последний завершённый полный прогон хоста |
| путь к папке прогона или к `registry*.xlsx` | `--from "<путь>"` |

## Примеры
- «/revizor:full example.ru для чужой команды, бета, без вопросов, с оценками, PDF» → `--url "example.ru" --audience external --stage beta --no-questions --scores --pdf`. Оценки для чужой команды недоступны: `init-run.mjs` выключит их и напишет предупреждение — покажите его одной строкой.
- «/revizor:full example.ru у меня Pro, по частям» → `--subscription pro --parts 3`.
- «/revizor:full example.ru глубоко, строго, стратегия, 30 страниц» → `--depth deep --profile strict --strategy --pages 30`.
- «/revizor:full example.com for a client, thorough, no questions» → `--audience external --depth deep --no-questions`, отвечать по-английски и `--lang en`.
- «/revizor:quick example.ru мобильная» → `--mode quick --topic mobile`.
- «/revizor:quick example.ru битые ссылки» → `--mode quick --topic seo-tech`.
- «/revizor:quick example.ru/menu цены» → `--mode quick --url "example.ru/menu" --topic facts --page "/menu"`.
- «/revizor:rivals example.ru a-example.ru b-example.ru» → `--mode rivals --url "example.ru"`, затем файл `answers/rivals.json`: `{ "urls": ["https://a-example.ru/", "https://b-example.ru/"] }` и `--answer-file`.
- «/revizor:recheck example.ru» → `--mode recheck --from "example.ru"`.
