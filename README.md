# Своя игра

Голосовой прототип. Как устроен проект и что уже решено — в `AGENTS.md` и `docs/CONTEXT.md`.

## Локально

```bash
npm install
npm run dev
npm test
```

`npm run dev` открывает игру на `http://127.0.0.1:5173/`. `npm run look` смотрит тот же адрес с `?mock=1`, без ключа и без запроса к OpenAI.

Ключ OpenAI вводится в браузере и в репозиторий не кладётся.

## Сайт

Живая сборка публикуется на GitHub Pages: https://roginvs.github.io/aisigame/

На pull request и на push в `master` GitHub Actions ставит зависимости из lockfile, гоняет `npm test` и `npx tsc -b`. Push в `master` ещё и собирает сайт и выкладывает его на Pages.
