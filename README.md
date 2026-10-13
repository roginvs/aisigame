# Своя игра

Голосовой прототип. Как устроен проект и что уже решено — в `AGENTS.md` и `docs/CONTEXT.md`. Все состояния партии и переходы между ними — в [docs/STATES.md](docs/STATES.md).

## Локально

```bash
npm install
npm run packs
npm run dev
npm test
```

`npm run dev` открывает игру на `http://127.0.0.1:5173/`. `npm run look` смотрит тот же адрес с `?mock=1`, без ключа и без запроса к OpenAI.

Если порт dev-сервера занят, браузерные проверки можно запустить отдельно: `AISIGAME_TEST_PORT=5184 npm run look`.

Ключ выбранного провайдера вводится в браузере и в репозиторий не кладётся.

Единственный встроенный пакет для демо и тестов — `public/packs/builtin/demo.siq`; исходник — `packs/demo.xml` и медиа в `packs/demo/`. `npm run packs` собирает его. Внешние `.siq` кладите в `public/packs/external/`: весь каталог в `.gitignore`, в меню файлы появляются после запуска Vite. В чистом checkout доступны только демо и выбор своего файла.

## Сайт

Живая сборка публикуется на GitHub Pages: https://roginvs.github.io/aisigame/

На pull request и на push в `master` workflow `.github/workflows/ci.yml` ставит зависимости из lockfile, гоняет `npm test` и `npx tsc -b`. Push в `master` ещё запускает `.github/workflows/pages.yml`: те же проверки, `npm run build` и выкладка на Pages.

Каталог раньше лежал в `playground/aisigame` и скопирован в этот репозиторий без той истории git. Локальный путь — `~/aisigame`, remote — https://github.com/roginvs/aisigame.

## Документация и планы

- [GAME](docs/GAME.md) и [STATES](docs/STATES.md): текущие правила и машина.
- [ONLINE](docs/ONLINE.md) и [JITSI](docs/JITSI.md): реализованная конференция и инструкция сервера.
- [PLAYOUT](docs/PLAYOUT.md): реализованная раскладка и приёмка.
- [UNIFY_MODES](docs/UNIFY_MODES.md): будущая унификация режимов и несколько мест на устройстве; код не начат.
- [to-do](to-do.md): задачи/проверки; [CONTEXT](docs/CONTEXT.md): решения и историческое ТЗ.
- [Типы вопросов](to-do-question-types.md): найденные типы по популярности, состав содержимого и очередь согласования правил.
- [CAT](docs/CAT.md): «Кот в мешке» (`cat` + `bagcat`): правила, реализация и отклонения от плана.
- [AUCTION](docs/AUCTION.md): аукцион (`auction` + `stake`): правила, реализация и отклонения от плана.
- [Аудит документации](docs/DOCS_AUDIT.md): обнаруженные противоречия и проверка планов от 13 октября 2026.

- [AUDIO_JUDGMENT](docs/AUDIO_JUDGMENT.md): нативная аудиооценка обычных ответов реализована; включение `?judge=audio`, сравнение `?judge=shadow`. По умолчанию аудио; переключатель «Оценивать по аудио» возвращает прежний текстовый путь. Live-приёмка ещё впереди.
