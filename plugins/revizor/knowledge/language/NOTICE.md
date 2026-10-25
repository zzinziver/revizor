# Авторство и лицензии: knowledge/language

| Файл | Основа | Лицензия основы | Что сделано |
|---|---|---|---|
| `ru-ai-markers.md` | навык avoid-ai-writing, версия 3.10.0, и его русская адаптация 3.10.0-ru.1 | MIT, © 2026 Conor Bronsdon (текст ниже) | пересказ на русском, перестройка под ревью сайтов, шкала P0–P3, словарь регулярных выражений; убран глоссарий для курсов; добавлены заглушки конструкторов, штампы коммерческих сайтов, устаревшие сервисы, исключения для отраслевых терминов |
| `en-ai-markers.md` | тот же навык | MIT, © 2026 Conor Bronsdon | сокращение под сайты, словарь регулярных выражений, исключения для терминов |
| `clarity-ru.md` | методика информационного стиля: книги М. Ильяхова и Л. Сарычевой, «Курс сильного текста» М. Ильяхова; порядок работы навыка text-writer (раздел «Поправки к навыку text-writer») | — | свой пересказ, свои примеры; цитат из книг и из конспектов навыка нет |
| `ux-copy.md` | общая практика UX-текстов; навык `design:ux-copy` из плагина design 1.2.0 (Anthropic, репозиторий github.com/anthropics/knowledge-work-plugins) | Apache-2.0 (лицензия репозитория; проверено 24.10.2026) | идеи и порядок взяты по навыку: пять принципов в том же порядке, формулы ошибки, пустого состояния и подтверждения, четыре тона по ситуации. Текст свой, примеры свои, дословных фрагментов нет; добавлены русские нормы, поля замеров Ревизора и правила находок |
| `typography-ru.md` | справочники Мильчина и Чельцовой, Розенталя; ГОСТ 8.417-2002 | — | свой текст, свои примеры |

Тем же путём сделан встроенный запасной словарь в `scripts/textscan.mjs`: правила пересказаны по avoid-ai-writing.

Автор avoid-ai-writing отмечает, что часть правил оригинала взята из проектов brandonwise/humanizer, blader/humanizer и Aboudjem/humanizer-skill. В наши файлы эти правила попали только через оригинал, в пересказе.

Исследование, на которое ссылается `ru-ai-markers.md`: Liang W., Yuksekgonul M., Mao Y., Wu E., Zou J. GPT detectors are biased against non-native English writers. Patterns, 2023.

Названия сервисов и компаний в примерах и списке устаревших маркеров (Skype, ICQ, Twitter, Google+, Яндекс, Т-Банк и другие) принадлежат их владельцам и упомянуты как факты. Главред (glvrd.ru) — сторонний сервис, Ревизор его не вызывает.

Про `design:ux-copy`: в локальной установке плагина design файла лицензии нет, а плагины того же каталога (legal, productivity, product-management) и сам репозиторий knowledge-work-plugins распространяются по Apache License 2.0. Если считать `ux-copy.md` производной работой, условия Apache-2.0 соблюдены так: автор и источник названы здесь, изменения перечислены в таблице, текст лицензии — https://www.apache.org/licenses/LICENSE-2.0 (полный текст стоит положить в `THIRD_PARTY_NOTICES.md` в корне репозитория).

Навык text-writer (в сессии — `anthropic-skills:text-writer`) содержит конспекты книг М. Ильяхова; файла лицензии у навыка нет. Конспекты и текст навыка в Ревизор не копировались: в `clarity-ru.md` методика пересказана своими словами со ссылками на книги, а поправки к навыку описывают, как Ревизор его вызывает.

Примеры сайтов в файлах вымышленные: кофейня «Зёрна», студия йоги, стоматология, интернет-магазин, ремонт квартир.

## Лицензия avoid-ai-writing

```
MIT License

Copyright (c) 2026 Conor Bronsdon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
