# Своя игра

Голосовой прототип. Как устроен проект и что уже решено — в `AGENTS.md` и `docs/CONTEXT.md`.

## Локально

```bash
npm install
npm run packs
npm run dev
npm test
```

`npm run dev` открывает игру на `http://127.0.0.1:5173/`. `npm run look` смотрит тот же адрес с `?mock=1`, без ключа и без запроса к OpenAI.

Ключ OpenAI вводится в браузере и в репозиторий не кладётся.

## Сайт

Живая сборка публикуется на GitHub Pages: https://roginvs.github.io/aisigame/

На pull request и на push в `master` workflow `.github/workflows/ci.yml` ставит зависимости из lockfile, гоняет `npm test` и `npx tsc -b`. Push в `master` ещё запускает `.github/workflows/pages.yml`: те же проверки, `npm run build` и выкладка на Pages.

Каталог раньше лежал в `playground/aisigame` и скопирован в этот репозиторий без той истории git. Локальный путь — `~/aisigame`, remote — https://github.com/roginvs/aisigame.
