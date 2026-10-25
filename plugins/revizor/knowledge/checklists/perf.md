# Чек-лист `perf` — скорость

Формат пункта: **[perf-NN] что проверить** — как проверить (файл и поле замера, проба, кадр) — норма — ложные срабатывания.
Пути — от RUN. `perf.json` лежит в `measure/`. «Телефон» в `perf.json` — 390×844, DPR 3, CPU×4, Slow 4G (задержка 562,5 мс, 1,44 Мбит/с); «компьютер» — 1440×900 без замедления. Страницы уровня A (`tier: "A"`: главная и вторая по важности) — медиана 3 загрузок, остальные — одна загрузка.
«Главная» в командах — `home`; при строке `PAGES=` в промте — первая pid из неё (главной в таком прогоне может не быть).

Главный вопрос линзы: сколько посетитель ждёт до первого полезного экрана и до отклика, и что именно его задерживает. Главное в находках по скорости — цепочки причин (примеры вымышленные): «картинка героя скачана к 0,6 с, а LCP 3,1 с — её прячет скрипт плавного появления», «галерея на 40 фото грузится сразу: 3,6 МБ до прокрутки», «сервер сжимает только HTML: 410 КБ JS идут без сжатия».

## Подпись цифр (до любых находок)

| Источник | Как подписать в `evidence` | Что можно |
|---|---|---|
| `psi[].field` (CrUX по странице) | «CrUX p75 по странице, телефон» | P0–P3 |
| `psi[].origin_field` или `field.origin_fallback: true` | «CrUX p75 по всему сайту» | P0–P3, с оговоркой в `scenario` |
| `psi[].lab` (Lighthouse у Google) | «PSI, лаборатория Google, телефон» | до P1 при явном разрыве |
| `perf.json → items[].mobile` | «лаборатория, телефон CPU×4 + Slow 4G, медиана N загрузок» | сравнение страниц и «со сторонними / без»; P0–P1 только с явным разрывом |
| `probe --vitals --repeat 3` | «лаборатория без замедления, медиана 3 загрузок» | сравнение страниц, проверка правки |
| `page.json → perf`, проба `perf-weight.js` | «лаборатория без замедления, одна загрузка» | сравнение страниц, вес; не абсолютное время |

При `machine.slow: true` (`perf.json → machine`, `doctor.json → machine.machine_slow`) лабораторное время одно P0–P1 не даёт. Вес, число запросов, `lazy_on_lcp`, формат картинок от машины не зависят.
Нет поля CrUX ни по странице, ни по сайту — выводы о времени с `confidence: medium`.

Надёжность лабораторного времени (проверь до цифр):
- `perf.json → contended: true` (и `summary.contended`, `items[].contended`) — во время замера браузером пользовалась другая проверка. Лабораторное время (LCP, FCP, TBT, TTFB, INP) ненадёжно: `confidence` не выше `medium`, P0–P1 по нему не ставь, в `notes/perf.md` и в ответе — строка «оркестратору: перезапустить perf.mjs --fresh на свободной машине». Вес, флаги LCP и форматы от этого не зависят.
- `items[].unsettled_loads[]` непустой (`pending[]` — что не догрузилось, `vp_incomplete`), `mobile.unsettled` > 0, `summary.flags.unsettled` — часть загрузок не успокоилась к концу ожидания. Медианы посчитаны по `settled_runs`; при `mobile.unsettled_only: true` спокойных загрузок нет вовсе — время такой страницы не P0–P1, `confidence: medium`, причина в `not_checked`.
- `items[].mobile.lcp_inconsistent[]` (`unit`, `ms`, `element`, `tag`) и `summary.flags.lcp_inconsistent` — LCP по загрузкам приходился на разные элементы, поэтому `mobile.median.lcp` = `null`. «LCP null» не пиши и чужую цифру не подставляй: perf-05.

## A. Источники и надёжность

**[perf-01] Есть ли полевые данные CrUX** — `perf.json → psi[]` (`status`, `field`, `origin_field`), `summary.psi[].field` — норма: для главной есть `field` по странице или `origin_field` — ложные: `status: "quota"`, `"error"` или `"no_answer"` (не ответил за бюджет времени) значит «PSI не ответил», это не «данных нет»; запиши в `not_checked`. Малые сайты часто без CrUX: «полевых данных нет, вывод по лаборатории», время — `confidence: medium`.

**[perf-02] Медленная машина, перехват, занятый браузер** — `perf.json → machine.slow`, `machine.bench_ms`, `interception: true`, `blocked_by_safety`, `contended` — норма: при медленной машине в `not_checked` строка «лабораторное время завышено, P0–P1 только по полю и явным разрывам»; при `contended: true` — строка «оркестратору: перезапустить perf.mjs --fresh на свободной машине» — ложные: нет.

**[perf-03] Разброс прогонов** — `items[].mobile.range.lcp`, `mobile.runs`, `mobile.settled_runs`, `mobile.unsettled`, `mobile.timed_out`, `unsettled_loads[]` — норма: на страницах уровня A разница максимума и минимума LCP меньше 30 % медианы; больше — цифру подавать диапазоном — ложные: одиночная загрузка на странице уровня B выводом не считается; один выброс среди трёх загрузок (разовая задержка CDN) — не находка, если повторы его не подтвердили.

**[perf-04] Ошибки замера** — `partial`, `items[].errors[]`, `perf.json → errors[]`, `not_checked` — норма: ошибки перенесены в свой `not_checked` с причиной; при `partial: true` недомеренные страницы — `not_checked` и строка «оркестратору: перезапустить perf.mjs» — ложные: «no second page» у bfcache — на сайте одна страница, это не ошибка сайта.

## B. LCP — главный экран

**[perf-05] LCP телефона по полю** — `psi[].field.lcp_ms.p75` (`category`), иначе лаборатория `items[].mobile.median.lcp` и `mobile.lcp_element` — норма: p75 ≤ 2,5 с хорошо, 2,5–4 с требует улучшения, > 4 с плохо — ложные: лабораторный LCP под Slow 4G в 2–3 раза выше живого; без поля подавай как сравнение страниц. `median.lcp: null` при непустом `mobile.lcp_inconsistent[]` — медианы нет: бери поле CrUX, а без него — находку «LCP-элемент меняется от загрузки к загрузке» (обычно слайдер, баннер согласия или поздно вставленный блок) с цифрой и элементом каждой загрузки из `lcp_inconsistent[]`, `confidence: medium`.

**[perf-06] LCP-картинка с `loading="lazy"`** — `items[].lcp.mobile.flags` содержит `lazy_on_lcp`, `summary.flags.lcp_lazy`, `lcp.mobile.sel`, `loading` — норма: у LCP-картинки нет `loading=lazy` — ложные: на 1440 LCP — другой элемент без lazy; проверяй ширину. Находка P1 на главной даже без поля: это явный разрыв.

**[perf-07] Файл LCP скачан, а отрисован позже** — `lcp.mobile.render_delay_ms` (флаг `render_delay` при ≥ 800 мс), `lcp.mobile.resource.end_ms` против `lcp.mobile.ms` — норма: разрыв меньше 800 мс — ложные: разрыв из-за веб-шрифта у текстового LCP; смотри `lcp.mobile.tag` (текст или картинка). Причину ищи в perf-10 и perf-31.

**[perf-08] LCP-файл обнаружен поздно** — флаги `late_discovery` (файл запросил скрипт), `not_in_initial_html` (`lcp.mobile.in_initial_html: false`: картинки нет в HTML ответа сервера, её вставляет скрипт; `mentioned_in_html`, `html_source` — где её нашли), `css_background` (фон из CSS), `load_delay` (`load_delay_ms` ≥ 1 000: файл начал качаться через секунду и позже после TTFB), `lcp.mobile.resource.initiator`, `resource.start_ms`, `load_ms` (сама загрузка файла), `summary.flags.lcp_late_discovery`, `lcp_not_in_initial_html` — норма: загрузка LCP-файла стартует в первые ~10 % времени до FCP; картинка первого экрана — `<img>` в HTML или `preload` — ложные: слайдер, где первая картинка в HTML, а остальные скриптом, — норма.

**[perf-09] preload и fetchpriority у LCP** — `detail.mobile.preload.lcp_preloaded`, `lcp.mobile.fetchpriority`, `preload.image_preload_not_lcp[]` (preload другой картинки), `preload.unused_warnings[]` — норма: LCP-картинка с `fetchpriority="high"` или в `preload`; preload указывает на тот же файл, который браузер выбирает из `srcset` на этой ширине и DPR — ложные: preload картинки другой ширины — это вред: качаются две.

**[perf-10] Страница скрыта до загрузки скриптов** — `items[].hidden_until_js[]` (элемент, когда показан), `white_screen.hidden_until_js`, `summary.flags.hidden_until_js` — норма: основной текст и кнопка видны без ожидания скриптов; появление при прокрутке не применяется к первому экрану — ложные: плавное появление ниже первого экрана на LCP не влияет. Доказательство причины — проба без скрытия: CSS-правка, которая показывает блок сразу (`--css`, `--vitals --repeat 3`), и сравнение FCP. Если скрипт упадёт, страница останется пустой — это `for_other_lenses` → `stability`.

**[perf-11] Белый экран** — `items[].white_screen.blank_until_ms`, `first_content_ms`, `uncertain_gap_ms`; лист кадров `measure/perf/<pid>-film.jpg` (кадры раз в ~300 мс) — посмотри глазами — норма: содержимое на экране не позже FCP + 0,5 с — ложные: кадр «пустой» при однотонном фоне героя (≥ 99,3 % пикселей одного цвета) — сверяй с листом; `capture_failed` — кадры не снялись.

**[perf-12] LCP по страницам** — `summary.pages[].mobile.lcp`, `summary.worst_lcp_mobile`; для страниц вне `perf.json` — `probe --vitals --repeat 3` или `snapshot/<pid>/page.json → perf.lcp` — норма: посадочные и страницы услуг не медленнее главной больше чем в 1,5 раза — ложные: `page.json → perf` и `probe` сняты без замедления; сравнивай только с такими же цифрами других страниц.

## C. Стабильность вёрстки (CLS)

**[perf-13] CLS** — поле `psi[].field.cls.p75`; лаборатория `items[].mobile.median.cls`, `items[].shifts[]` (что сдвинулось); `page.json → perf.cls_incl_scroll` — норма: p75 ≤ 0,1 хорошо, > 0,25 плохо — ложные: `cls_incl_scroll` включает прокрутку и ленивые блоки; для нормы бери загрузку. На ноутбуках 1280–1440 сдвиг от масштабирования платформы — `mobile.json → summary.rescale_laptop` (владелец — `mobile`).

**[perf-14] Картинки и встройки без размеров** — `detail.mobile.images.no_dimensions`, `page.json → images.list[].has_dims` — норма: у видимых картинок и iframe есть `width`/`height` или `aspect-ratio` — ложные: картинка в контейнере с фиксированной высотой не сдвигает вёрстку; проверь по `shifts[]`.

## D. Отклик и главная нить

**[perf-15] TBT в лаборатории** — `items[].mobile.median.tbt`, `range.tbt`; `psi[].lab.tbt_ms` — норма: ≤ 200 мс хорошо, > 600 мс плохо (Lighthouse) — ложные: под CPU×4 на медленной машине TBT растёт кратно; подавай сравнением и вкладом сторонних (perf-45).

**[perf-16] INP** — поле `psi[].field.inp_ms.p75`; лаборатория `items[].inp.inp_ms`, `p75_ms`, `worst.target`, `taps_ok`, `error` — норма: ≤ 200 мс хорошо, > 500 мс плохо — ложные: `taps_ok: 0` или `error` — касаний не было, запиши в `not_checked`, «INP хороший» не пиши; касания с `taps[].result` `skipped:<причина>` (`covered` — кнопку закрывает слой, `consent` — баннер согласия), `refused:<причина>`, `gone` в INP не входят — перечисли их в `not_checked` с `taps[].kind` и `sel`; `inp.consent_blocks[]` непустой — баннер согласия закрывал кнопки: INP снят только по тому, что было открыто. Лабораторные касания — бургер, аккордеоны, вкладки (`kind`), без форм и ссылок.

**[perf-17] Нагрузка в простое и чьи скрипты держат нить** — `items[].main_thread` (профиль CPU одной загрузки телефона до касаний, `window: "load"`: `js_ms`, `first_party_pct`, `platform_pct`, `third_party_pct`, `other_pct`, `by_origin[]`, `top_scripts[]`; `summary.pages[].main_thread`; `error` — профиль не снялся, `not_checked`), `items[].idle.busy_pct` (5 с после загрузки, CPU×4), `detail.mobile.motion.{animations_infinite, canvases_big, will_change, videos_playing_offscreen}` — норма: ориентир Ревизора — в простое главная нить занята меньше 10 %; вечные анимации и видео вне экрана останавливаются — ложные: один короткий таймер аналитики — шум. `main_thread.platform_pct` больше половины `js_ms` — время съедают скрипты платформы: одна находка P3 «ограничение платформы» (perf-51); находки по влиянию ищи в `first_party_pct` и `third_party_pct` с файлами из `top_scripts[]`. Анимацию как дизайн оценивает `visual`.

**[perf-18] Тяжёлый DOM** — `detail.mobile.dom.nodes`, `dom.depth`, `summary.flags.dom_nodes_max`, `mobile.json → summary.heavy_dom` — норма: Lighthouse предупреждает с 800 узлов, ошибкой считает больше 1 400 — ложные: скрытые дубли блоков платформы для разных ширин — тоже узлы, но правка — в настройках платформы (P3).

**[perf-19] Память** — `items[].memory.mobile.heap_mb`, `memory.mobile_after_scroll` — норма: куча после прокрутки растёт не больше чем в 2 раза; ориентир — до ~50 МБ на лендинге — ложные: галерея с полноразмерными фото после прокрутки — норма, если фото нужны.

## E. Вес и картинки

**[perf-20] Вес первой загрузки на телефоне** — `items[].weight.mobile.bytes`, `requests`, `bytes_3s`, `by_type`, `weight.mobile.settled` (`false` — загрузка не успокоилась, вес занижен); бюджет `items[].budget.{bytes,bytes_limit,bytes_ok}`, `summary.flags.budget_over[]` (pid сверх бюджета веса или JS) — норма: ориентир Ревизора — до прокрутки на телефоне ≤ 1,5 МБ, лендинг ≤ 1 МБ — ложные: видео, которое грузится только по нажатию, в вес не входит; проверь по `by_type.Media`.

**[perf-21] JavaScript** — `weight.mobile.by_type.Script`, `budget.{js_bytes,js_limit,js_ok}`, `render_blocking.js`, `detail.mobile.top[]` (тип Script), `main_thread.top_scripts[]` (время, не вес) — норма: ориентир Ревизора — ≤ 300 КБ сжатого JS на лендинге — ложные: скрипты платформы, которые нельзя убрать, — P3 «платформа».

**[perf-22] Топ-15 ресурсов** — `detail.mobile.top[]` (`file`, `bytes`, `third_party`, `encoding`, `cache`) — норма: в топе нет файлов, которые не нужны первому экрану — ложные: шрифт основного текста — нужен.

**[perf-23] Тяжёлые картинки** — `detail.mobile.images.heavy[]` (> 200 КБ), `summary.flags.heavy_images` — норма: картинка контента ≤ 200 КБ на телефоне, фон героя ≤ 300 КБ — ложные: фото в лайтбоксе по нажатию на первой загрузке не качаются.

**[perf-24] Старые форматы** — `detail.mobile.images.not_modern[]` (JPEG/PNG больше 50 КБ), `page.json → images.list[].format` — норма: WebP или AVIF для фото; PNG только для графики с прозрачностью — ложные: платформа сама отдаёт WebP по `Accept` — смотри `mime` ответа: расширение файла формат не доказывает.

**[perf-25] Картинки крупнее показа** — `detail.mobile.images.oversized[]` (`natural`, `shown`, `dpr`, `srcset`), `page.json → images.list[].oversize` — норма: пикселей не больше чем в 2,5 раза больше нужного на этой ширине и DPR; есть `srcset` и `sizes` — ложные: SVG и картинка, которую увеличивают по нажатию.

**[perf-26] lazy в первом экране и eager ниже** — `detail.mobile.images.lazy_in_fold[]`, `eager_below_fold`, `summary.flags.lazy_in_fold` — норма: картинки первого экрана без `lazy`; ниже двух экранов — с `loading="lazy"` — ложные: `loading=lazy` ниже первого экрана — правильно, находкой не считается.

**[perf-27] Вес после прокрутки** — `weight.mobile.after_scroll` против `weight.mobile.bytes`; `weight.desktop.after_scroll` — норма: прокрутка догружает только то, что показывает — ложные: бесконечная лента — норма. Галерея, которая при прокрутке качает фото полного размера вместо превью, — находка с цифрой веса.

**[perf-28] Видео** — `detail.mobile.videos[]` (`preload`, `poster`, `bytes`, `autoplay`), `page.json → videos[]` — норма: фоновое видео ≤ 2–3 МБ, с постером; у видео ниже экрана `preload="none"` или `metadata`; `preload="auto"` только у ролика первого экрана — ложные: ролик, который играет после нажатия, — норма. Постеры при `preload="none"` грузятся сразу — их вес тоже считай.

**[perf-29] Дубли файлов** — `detail.mobile.duplicates[]` — норма: один файл грузится один раз — ложные: одинаковое имя у разных версий файла с разным размером — скрипт их не склеит.

**[perf-30] iframe карт и видео** — `detail.mobile.dom.iframes[]` (`loading`, `y`) — норма: встройки ниже первого экрана с `loading="lazy"` или по нажатию (заглушка-картинка) — ложные: iframe-форма заявки в первом экране — нужна сразу.

## F. Шрифты

**[perf-31] font-display** — `detail.mobile.fonts.no_display[]` (`auto` или `block`), `summary.flags.fonts_no_display` — норма: `font-display: swap` или `optional` у текстовых шрифтов — ложные: иконочный шрифт с `block` — норма. Поведение текста на экране (мигание, подмена) — `typography`.

**[perf-32] Формат и число шрифтов** — `fonts.files`, `fonts.bytes`, `fonts.not_woff2[]`, `fonts.list[].preloaded`, `fonts.failed[]` — норма: WOFF2; ориентир — не больше 4–6 файлов и ~200 КБ на первой загрузке; шрифт первого экрана в `preload` — ложные: кириллица и латиница отдельными подмножествами — экономия, такие файлы лишними не считаются.

**[perf-33] Шрифты со стороннего хоста** — `fonts.third_party_hosts[]`, `preload.preconnect[]` — норма: к хосту шрифтов есть `preconnect`, или шрифты лежат на своём домене — ложные: правовую сторону (передача IP посетителя) ведёт `privacy`, здесь только скорость.

## G. Блокирующие ресурсы и подсказки

**[perf-34] CSS и JS в head блокируют показ** — `detail.mobile.render_blocking.css[]`, `.js[]` (`bytes`, `end_ms`), `body_sync_scripts`, `summary.flags.render_blocking` — норма: в `<head>` нет синхронных скриптов без `defer`/`async`, кроме нужных для первого экрана; CSS первого экрана небольшой — ложные: скрипт согласия на cookie или A/B-теста иногда обязан быть синхронным — тогда P3.

**[perf-35] preconnect к нужным хостам** — `detail.mobile.preload.preconnect[]`, `third_party.hosts[]` — норма: к хостам с ресурсами первого экрана (CDN картинок, шрифты) есть `preconnect`; лишних (больше 4–6) нет — ложные: preconnect к счётчику, заблокированному страховкой, — не ошибка сайта.

**[perf-36] preload без использования** — `preload.unused_warnings[]`, `summary.flags.unused_preload` — норма: каждый preload используется в первые секунды — ложные: шрифт, подгруженный для второго экрана, — допустимо.

## H. Сервер, сеть, кэш

**[perf-37] TTFB** — поле `psi[].field.ttfb_ms.p75`; лаборатория `items[].mobile.median.ttfb`, `ttfb_p90`, `desktop.median.ttfb` — норма: ≤ 0,8 с хорошо, > 1,8 с плохо — ложные: единичные выбросы, пока на машине работают другие агенты; одинаковое большое время в нескольких загрузках похоже на тайм-аут защиты от ботов. Без серии повторов это гипотеза — `confidence: medium`.

**[perf-38] Сжатие текстовых ответов** — `detail.mobile.cache_compression.uncompressed[]`, `uncompressed_first_party`, `html_encoding`; `headers.json → flags[]` с кодом `no-compression` — норма: HTML, CSS, JS, SVG, JSON отдаются с `gzip` или `br` — ложные: файл меньше ~1,4 КБ; сжатие сторонних — их дело. Частый случай: сервер сжимает HTML, а JS и CSS отдаёт как есть — в находке сумма несжатых байтов своих файлов.

**[perf-39] Кэш статики** — `cache_compression.weak_cache[]` (`ttl_s`, `cache_control`), `weak_cache_first_party`; `headers.json → flags[]` `short-cache` — норма: CSS, JS, шрифты, картинки с хэшем в имени — `max-age` от недели (лучше год с `immutable`) — ложные: файлы без версии в имени с коротким кэшем — осознанный выбор; правка — «версия в имени + длинный кэш».

**[perf-40] Кэш HTML** — `cache_compression.html_cache_control`, `html_etag`, `html_last_modified` — норма: HTML `no-cache` или короткий кэш с ревалидацией, чтобы правки и цены доходили сразу — ложные: CDN с очисткой кэша при публикации — норма, если это видно по заголовкам CDN.

**[perf-41] Повторный заход** — `items[].warm` (`lcp`, `bytes`, `from_cache`, `revalidated_304`, `network_200`) — норма: при повторном заходе статика берётся из кэша, качается меньше 20 % веса — ложные: HTML всегда идёт в сеть — норма.

**[perf-42] HTTP/2 и HTTP/3** — `cache_compression.protocols`, `headers.json → tls.http2`, `http3.h3_advertised` — норма: свой домен отдаёт по HTTP/2; HTTP/3 — плюс — ложные: нет HTTP/3 — P3, не выше; не советовать HTTP/2, если `protocols` уже показывает `h2`.

**[perf-43] bfcache: «Назад» без перезагрузки** — `items[].bfcache.restored`, `page_reasons[]`, `no_store`, `unload_listeners`, `summary.flags.bfcache_blocked` — норма: `restored: true` — ложные: причины `Circumstantial` (их скрипт отбрасывает) и отказ из-за нашего профиля — не ошибка сайта.

## I. Сторонние скрипты

**[perf-44] Сколько сторонних и сколько весят** — `items[].third_party.host_count`, `bytes`, `share_bytes_pct`, `hosts[]` (`name`, `category`) — норма: доля сторонних по весу и что это за сервисы записана в `notes/perf.md` — ложные: хосты платформы и CDN самого сайта — свои (`kept` с причиной `platform`).

**[perf-45] Что отнимают сторонние** — `third_party.block_test`: `delta_unreliable`, `delta_significant.{lcp,fcp,tbt}`, `delta.{lcp,fcp,tbt,bytes,requests}`, `median_blocked`, `blocked_hosts`, `kept[]`, `weight` (вес заблокированных по обычной загрузке), `noise_pct`, `slower_without_third_party`, `lcp_elements[]` — норма, по шагам: (1) `delta_unreliable` не `null` (разные LCP-элементы — список в `lcp_elements[]`, или незавершённые загрузки) — `delta` = `null`, разницы по времени нет: пункт в `not_checked` с этой причиной; вес сторонних из `weight` подавать можно. (2) `delta_significant.<метрика>: false` — разница в пределах шума `noise_pct`, не находка. (3) `true` — находка с названием сервиса и цифрой «LCP 5,1 → 3,4 с без N сервисов». (4) `slower_without_third_party: true` — без сторонних LCP стал хуже: показ ждёт их скрипты; это зависимость от стороннего сервиса, ускорением не подавай — ложные: `lcp_same_element: false` — сравнение неточное; 1–2 загрузки против медианы — `confidence: medium`.

**[perf-46] Счётчики, коллтрекинг, чаты** — `items[].blocked_by_safety` (`analytics`, `widget`), `psi[].opportunities[]` — норма: их цена берётся только из PSI (третьи стороны в `opportunities`); своих выводов о них по лаборатории не делать — ложные: «счётчик тормозит», когда он заблокирован в замере, — неверно.

## J. PageSpeed Insights

**[perf-47] Возможности PSI** — `psi[].opportunities[]` (`title`, `savings_ms`, `savings_bytes`), `psi[].lcp_element` — норма: каждая возможность — кандидат; находкой становится после сверки со своим замером (тот же файл в `top[]`, тот же элемент) — ложные: «устраните блокирующие ресурсы» про CSS первого экрана платформы — P3 «платформа».

**[perf-48] PSI не смог померить** — `psi[].runtime_error.code` (например `NO_LCP`, `FAILED_DOCUMENT_REQUEST`), `status` — норма: `NO_LCP` — находка: у Google нет LCP (часто страница скрыта до действия или полностью на canvas) — ложные: `quota` и `error` из-за сети — `not_checked`.

## K. Регионы и прочее

**[perf-49] Доступность из регионов** — `domain.json → regions.nodes[]` (`country`, `ok`, `message`), флаг `region-fail` — норма: главная открывается из стран аудитории — ложные: одна неудачная проверка узла — повтор не делали, `confidence: medium`; без `--regions` или без `domain.json` — `not_checked`. Доступность по IPv6: `domain.json → dns.ipv6_reach.{checked, ok, ip, port, error}`, флаг `ipv6-unreachable` (AAAA-запись есть, порт по IPv6 не отвечает; приходит и строкой от `security`) — P2 `sitewide: true`: браузеры обычно переключаются на IPv4 с задержкой, а часть клиентов (сети только с IPv6, приложения, боты) сайт не откроет; в `fix` — убрать AAAA-запись или включить IPv6 на сервере; `checked: false` — `not_checked` с причиной из `why`.

**[perf-50] Страницы вне `perf.json`** — `snapshot/<pid>/page.json → perf` (`lcp`, `resources.transfer_bytes`, `resources.by_initiator`), проба `--vitals --repeat 3` с `perf-weight.js` (не больше 3 страниц) — норма: посадочные не тяжелее главной больше чем в 2 раза — ложные: цифры без замедления; абсолютными не подавать.

**[perf-51] Потолок платформы** — `brief.platform.name`, свой раздел `platforms/<id>.md` — норма: что исправимо (картинки, свои виджеты, блоки) — находки по влиянию; скрипты и CSS платформы — одной находкой P3 «ограничение платформы» — ложные: «перейти на другую платформу» — совет вне ревью, только в `open_questions`.

## Готовые пробы (probe-js)

Готовые замеры лежат в плагине, копировать их не нужно: `--js` берёт файл из `<ROOT>/scripts/probe-js/` как есть. Свою пробу пиши Write-ом в `<RUN>/probe-js/`. Запуск: `node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 390 --js "<ROOT>/scripts/probe-js/<файл>" --no-shot`. Загрузка в пробе — без замедления: сравнивай страницы между собой. Пробы — по одной, не в фоне.

### perf-weight.js — вес по типам, сторонние, топ-10, LCP

`zero_size_cross_origin` — сторонние файлы без `Timing-Allow-Origin`: их вес браузер не сообщает (0), реальный вес выше.

### Проверка правки LCP подменой (A/A, медианы)

Шум одиночной загрузки на локальной машине — десятки процентов: правка-пустышка «улучшает» или «ухудшает» LCP на 20–40 %. Поэтому одна загрузка «до» и одна «после» ничего не доказывают. Протокол:

1. Файл правки в `<RUN>/probe-js/`. Вставка — только в `</head>` (или `<head>`): `--at "</head>"`. Замену тега по селектору для скорости не используй: подмена по селектору задерживает ответ и даёт ложное ухудшение.
   - preload картинки первого экрана — `perf-preload.html`: `<link rel="preload" as="image" href="/img/hero-800.webp" fetchpriority="high">` (адрес — тот, что выбирает `srcset` на 390 и DPR 2–3);
   - снять `loading="lazy"` с LCP-картинки — `perf-unlazy.html` (ниже); `SEL` — селектор картинки из `lcp.mobile.sel`.
2. Команда: `node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 390 --inject-html "<RUN>/probe-js/perf-preload.html" --at "</head>" --vitals --repeat 3 --js "<ROOT>/scripts/probe-js/perf-lcp-start.js" --no-shot`
   Скрипт делает 3 загрузки «до» через ту же подмену без изменений (A/A) и 3 «после» с правкой, считает медианы от конца ответа документа (`lcp_from_response`, `fcp_from_response`) и шум — разброс загрузок «до».
3. Итог — `fix.speed`: по каждой метрике `median_before`, `median_after`, `aa_noise`, `threshold` = max(15 % от «до», 2 × шум), `verdict` (`improved`, `noise`, `worse`); общий `fix.speed.verdict` и `fix.speed.fix_verified`. `--js perf-lcp-start.js` — объяснение для `evidence`: когда стартовал файл картинки от конца ответа в первой загрузке «до» (`before.result`) и «после» (`result`).
4. В находку: `fix_verified` = `fix.speed.fix_verified`; `fix_check`: «probe --inject-html perf-preload.html --vitals --repeat 3 @390, без замедления: LCP от ответа, медиана 1 240 → 610 мс, шум A/A 90 мс, порог 186 мс → improved; старт файла героя 640 → 30 мс». `noise` — `fix_verified: false`, «разница в пределах шума». `worse` — правку не предлагай в этом виде. `fix.applied: false` (`blocked_by: "csp"`) — правка в таком виде не заработает и на сайте.
5. В `probe.mjs --help` нет `--vitals` — протокол недоступен: `fix_verified: false`, `fix_check`: «проверка человеком: после выкладки PSI, телефон, 3 запуска до и после, медиана LCP».

`perf-lcp-start.js` — когда стартовал файл LCP-картинки от конца ответа документа: часть имени файла — `--js-args '{"file":"hero-800"}'` (без неё ищется «hero»).

`perf-unlazy.html` (правка «убрать lazy у LCP-картинки» без замены тега):
```html
<script>
/* drop loading=lazy on the LCP image while the parser inserts it; SEL = selector of the LCP image */
(function () {
  var SEL = '.hero img';
  new MutationObserver(function (ms) {
    for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) {
      var n = ms[i].addedNodes[j];
      if (n.nodeType === 1 && n.matches && n.matches(SEL)) { n.loading = 'eager'; n.fetchPriority = 'high'; }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>
```
CSP сайта без `unsafe-inline` не пустит этот скрипт (`fix.applied: false`) — тогда проверяй только preload; в `fix` правка всё равно атрибутом: `loading="eager"` (или без `loading`) и `fetchpriority="high"` у тега картинки.

### Вклад одного стороннего сервиса

Основная цифра — `third_party.block_test` из `perf.json`. Для одного сервиса: `node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid главной> --width 390 --block "*widget-host.example*" --vitals --repeat 3 --no-shot` и тот же вызов без `--block` → сравни `vitals_runs.median.lcp_from_response`. Порог — max(15 %, 2 × разброс `vitals_runs.values` вызова без блокировки); меньше — шум. Подпись: «без замедления, медиана 3 загрузок».

## Шаблон notes/perf.md

```
| pid | LCP тел. | FCP тел. | CLS | TBT | вес тел. (3 с / после прокрутки) | LCP комп. | источник |
Цепочка LCP главной: элемент → файл (вес) → старт → конец → LCP → что держит.
Сторонние: N хостов, X МБ (Y %); без них LCP A → B, TBT C → D.
Проверка правок: id → verdict, медианы до/после, шум A/A.
Кадры: пути просмотренных кадров.
Главная нить (main_thread): JS N мс — свой код X %, платформа Y %, сторонние Z %; топ скриптов.
Надёжность: contended, незавершённые загрузки (pid, что не догрузилось), страницы с lcp_inconsistent.
Не меряет Ревизор: покрытие CSS, недособранные кадры первого показа, дубли заголовков ответа.
Не проверено: …
Оркестратору: перезапустить perf.mjs для … — причина (если нужно).
```

## Самопроверка (quick)

- [ ] Каждая цифра времени подписана источником: поле CrUX, PSI-лаборатория, своя лаборатория с замедлением или без.
- [ ] Нет P0–P1 только по лаборатории при `machine.slow: true`; без поля CrUX время — `confidence: medium`.
- [ ] Цепочка LCP главной разобрана до причины (lazy, позднее обнаружение, скрытие до JS, шрифт, тяжёлый файл).
- [ ] Вклад сторонних — из `block_test`: при `delta_unreliable` — `not_checked`, при `delta_significant: false` — не находка; `slower_without_third_party: true` не подан как ускорение.
- [ ] При `contended: true` или незавершённых загрузках лабораторное время не дало P0–P1; строка оркестратору про `--fresh` есть.
- [ ] `median.lcp: null` при `lcp_inconsistent` не записан как «LCP null».
- [ ] Ограничения платформы — одной находкой P3.
- [ ] Не советую то, что уже есть (HTTP/2, сжатие, preload).
- [ ] `fix_verified: true` только при `fix.speed.verdict: improved` (A/A, `--repeat 3`); одиночные загрузки правку не доказывают.
- [ ] Скрипты замеров не запускал; недостающее — в `not_checked` и строкой оркестратору.

## Что владелец заметит руками

- Открывает сайт с телефона по мобильной сети: первый экран «собирается» 3–5 секунд, сначала белый лист или прыгающая вёрстка.
- Нажимает «Назад» из карточки в каталог — страница грузится заново и сбрасывает прокрутку (нет bfcache).
- Галерея или лента фото: телефон греется, прокрутка дёргается.
- После правки цен в CMS видит старую цену ещё час (кэш HTML или CDN).
- Видео в первом экране не стартует на мобильной сети или сначала показывает чёрный прямоугольник без постера.
- Шрифт заголовков меняется на глазах через секунду после загрузки.
- Чат или виджет отзывов появляется последним и сдвигает кнопку под пальцем.
