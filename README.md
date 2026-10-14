# Verba

Студия аудиокниг: загружаешь EPUB/DOCX/TXT/Markdown, книга озвучивается через [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) в браузере на твоём компьютере, аудио и прогресс хранятся на сервере, слушать удобно с телефона — вертикальный 9:16-плеер с пословной подсветкой субтитров.

## Как устроено

- **Генерация** — в браузере на компьютере (`src/tts/`): Supertonic 3 на onnxruntime-web (WebGPU, фолбэк WASM) в Web Worker. Модель (~400 MB) качается с Hugging Face один раз и кэшируется.
- **Сжатие** — `src/lib/opus.ts`: каждая глава кодируется в Ogg Opus 32 kbps через WebCodecs (~12 MB на час).
- **Сервер** — `apps/api` (Bun + SQLite): книги, обложки, аудио глав и позиция прослушивания. Аудио отдаётся с HTTP Range (нужно iOS Safari). Данные лежат в `apps/api/data` (или `VERBA_DATA_DIR`).
- **Синхронизация** — библиотека опрашивает сервер раз в 15 с: пока компьютер генерирует, на телефоне появляются готовые главы; позиция сохраняется каждые 5 с и при паузе.
- **AI-подготовка текста** (галочка «Enhance text with AI» на странице книги) — `apps/api/src/codex.ts` + `enhance.ts`: сервер запускает официальный `codex app-server` под твоим ChatGPT-входом (Settings → Connect ChatGPT) и перед озвучкой переписывает главу в «произносимый» вид: числа и сокращения словами, ударения U+0301, без сносок, копирайтов и иероглифов. Ответ проверяется валидатором ударений, при ошибках — повтор. Следующая глава готовится, пока озвучивается текущая.
- **Импорт** — `src/lib/importers.ts`: EPUB (оглавление, обложка), DOCX (заголовки → главы), TXT/MD («Глава N», `#`).

Генерировать можно только из secure context (`localhost` или HTTPS) — нужны WebGPU и WebCodecs. Телефон по обычному `http://<ip-компьютера>:5174` только слушает. Ogg Opus на iPhone играет с iOS 18.4.

Тайминги слов — оценка внутри фрагмента (Supertonic отдаёт длительность фрагмента, а не слов).

## Структура

- `apps/web` — Vite + React интерфейс
- `apps/api` — Bun-сервер: API + раздача собранного фронтенда
- `packages/ui` — общие shadcn/ui-компоненты и дизайн-токены
- встроенный фон и эмбиент плеера — `apps/web/public/minecraft-parkour.mp4` и `apps/web/public/ambient-background.mp3`; в репозиторий не входят (слишком большие / чужие), положи свои файлы с этими именами или загрузи фоны и звуки в Settings → Player media

## Запуск

```bash
bun install
bun run dev
```

Откроется веб на `http://localhost:5174` (порт от Vite) и API на `:8787`. С телефона в той же Wi-Fi сети: `http://<ip-компьютера>:<порт>`.

Продакшен (один процесс, API + фронтенд на `:8787`):

```bash
bun run start
```

На Linux-сервере для AI поставь Codex CLI (`npm i -g @openai/codex`) — вход в Settings пойдёт по device code (ссылка + одноразовый код). Логин Codex хранится в `apps/api/data/codex` (или `VERBA_CODEX_HOME`); `VERBA_CODEX_BINARY` — путь к бинарю, `VERBA_CODEX_LOGIN=browser|device` — режим входа.

Переменные: `PORT`, `VERBA_DATA_DIR`, `VERBA_TOKEN` (код доступа — обязательно, если сервер торчит в интернет), `VITE_SUPERTONIC_BASE_URL` (свой хост моделей с `onnx/` и `voice_styles/`).

Проверки:

```bash
bun run build
bun run lint
```

## Следующий слой

- Серверный воркер Supertonic (Python/ONNX), чтобы генерировать без открытой вкладки.
- HTTPS (Caddy/Tailscale) для доступа извне и генерации с любого устройства.
- Офлайн-прослушивание на телефоне (кэш глав в Service Worker).

Для добавления shadcn-компонентов запускайте CLI из `apps/web`:

```bash
cd apps/web
bunx --bun shadcn@latest add dialog
```
