# ТЗ: монитор распространения DNS («Сходкон» — рабочее имя, переименуй под бренд)

> Назначение: следить, как изменённая DNS-запись расходится по публичным рекурсивным
> резолверам в разных регионах, и присылать в Telegram уведомление в момент схождения
> (или по таймауту). Опрос идёт с убывающей частотой (backoff): часто в начале, реже к концу.
>
> Документ — исполняемая спецификация для Claude Code. Архитектурные решения приняты,
> не пересматривай их без явной причины. Открытые вопросы и значения по умолчанию — в конце.

---

## 1. Контекст и ключевое архитектурное решение

Боль: при правке DNS разные резолверы переключаются на новое значение в разное время
(от секунд до 48 ч, диктуется старым TTL и слоями кэша). Хочется точно знать момент,
когда «у всех» уже новое — и не дёргать `dig` руками.

**Главное ограничение, которое определяет архитектуру:** GitHub Actions cron имеет
минимум 5 минут и плавающий старт (опоздание до 10–20 мин под нагрузкой). Sub-minute
backoff (старт с 30 с) там физически недостижим. Поэтому:

- **runtime-цикл опроса живёт в Cloudflare Durable Object** (механизм `alarm()` — DO будит
  сам себя в произвольный момент, опрашивает, переставляет следующий alarm по формуле backoff);
- **GitHub Actions — только CI** (валидация схемы + `wrangler deploy`), НЕ рантайм.

> ⛔ Анти-требование: не добавляй workflow с `schedule:` cron для опроса резолверов.
> Любой опрос — внутри Worker/DO.

Архитектура — два контура (как в домконе):

- **Декларативный контур → git.** Определения watch'ей (что отслеживаем) — YAML-файлы в репо.
  Медленно-меняющиеся, человекочитаемые, под код-ревью, аудит через историю коммитов.
- **Рантайм-контур → DO storage / KV.** Состояние опроса (какой резолвер сошёлся, текущий
  шаг backoff, счётчики) — быстрое, эфемерное, **в git не коммитится** (иначе спам апдейтами
  каждые 30 с). В git попадает только финальный результат — закрывающая запись в лог.

---

## 2. Структура репозитория

```
/watches/<id>.yaml            # декларации watch'ей (git-as-database)
/schema/watch.schema.json     # JSON Schema для валидации
/resolvers/registry.yaml      # реестр резолверов и гео-пресетов (ECS)
/worker/
  wrangler.toml
  src/
    index.ts                  # HTTP-роутер Worker: API + webhook + отдача Mini App
    watch-do.ts               # Durable Object: alarm-цикл, состояние одного watch
    poller.ts                 # опрос резолверов через DoH, парсинг ответов
    resolvers.ts              # загрузка реестра, раскрытие ECS-пресетов
    compare.ts                # нормализация RRset и проверка схождения
    backoff.ts                # расписание backoff + jitter + таймаут
    telegram.ts               # Bot API: send/edit message, валидация initData
    github.ts                 # чтение watch'ей и запись финального лога через Git Data API
    auth.ts                   # HMAC: Telegram initData + GitHub webhook signature
/miniapp/                     # Telegram Mini App (статика + Telegram WebApp SDK)
/.github/workflows/
  validate.yml                # на PR в /watches/ и /resolvers/ — валидация
  deploy.yml                  # на merge в main — wrangler deploy + деплой Mini App
/spec/                        # этот документ и производные решения (SDD)
```

---

## 3. Доменная модель: watch

Один YAML = одна отслеживаемая правка. Пример `/watches/app-a-record.yaml`:

```yaml
id: app-a-record                # уникальный, = имя DO и имя файла
domain: app.example.com
type: A                         # A | AAAA | CNAME | MX | TXT | NS
expected:                       # эталон = что ты ВЫСТАВИЛ (не тянем с authoritative)
  values: ["203.0.113.10", "203.0.113.11"]
  match: exact-set              # exact-set (RRset == expected) | contains
resolvers: preset:global-8      # имя пресета из registry.yaml или явный список
convergence:
  mode: all                     # all | quorum
  quorum: 8                     # учитывается при mode=quorum
  confirmations: 1              # сколько подряд раундов «все сошлись» нужно (анти-флап)
backoff:
  schedule_sec: [30, 30, 60, 60, 120, 300, 600, 1800, 3600]
  hold_last: true               # после конца расписания держать последний интервал
  jitter_pct: 10
  timeout_sec: 172800           # 48 ч — общий дедлайн
precheck_authoritative: true    # перед стартом убедиться, что NS зоны уже отдают expected
notify:
  telegram_chat_ids: [123456789]
  progress: edit-in-place       # off | edit-in-place (1 сообщение, editMessageText) | every-round
status: active                  # active | done | timeout | error | paused (ставит рантайм/CI)
```

Требования к схеме (`watch.schema.json`):
- `id` ∈ `^[a-z0-9-]{1,40}$`, совпадает с именем файла;
- `expected.values` непустой; формат значений валидируется по `type`
  (A → IPv4, AAAA → IPv6, MX → `priority host`, TXT → строка, CNAME/NS → FQDN; IDN → punycode);
- `resolvers` — либо `preset:<name>` (есть в registry), либо инлайн-массив записей резолверов;
- backoff: все интервалы > 0, `timeout_sec` ≥ первого интервала.

---

## 4. Реестр резолверов и честная геогеография (ECS)

**Засада anycast:** `8.8.8.8` — сотни нод за одним IP. Один успешный ответ ≠ «весь Google
сошёлся»: соседняя нода в другой стране может ещё отдавать старое. Честный гео-срез делается
не «разными IP», а **EDNS Client Subnet** — просим резолвер ответить «как для подсети региона X».

Факты, которые надо заложить:
- **Google** (`https://dns.google/resolve`, JSON) — **honor ECS**. Основной источник гео-срезов:
  один провайдер, N разных `edns_client_subnet` = N региональных видов.
- **Cloudflare** (`https://cloudflare-dns.com/dns-query`, `Accept: application/dns-json`) —
  **strip ECS** (приватность). Даёт один глобальный независимый вид, ECS не задавай.
- Quad9, OpenDNS — для P1 (см. фазы): JSON не у всех, нужен wireformat-путь.

`/resolvers/registry.yaml` — пресеты. «Резолвер» в нашей модели = пара (провайдер, ECS-регион):

```yaml
presets:
  global-8:
    - { name: google-de,  provider: google,     ecs: "85.214.0.0/24",   region: EU/DE }
    - { name: google-us,  provider: google,     ecs: "23.252.0.0/24",   region: US }
    - { name: google-jp,  provider: google,     ecs: "126.0.0.0/24",    region: JP }
    - { name: google-br,  provider: google,     ecs: "200.160.0.0/24",  region: BR }
    - { name: google-ru,  provider: google,     ecs: "77.88.8.0/24",    region: RU }
    - { name: google-au,  provider: google,     ecs: "1.128.0.0/24",    region: AU }
    - { name: cloudflare, provider: cloudflare, ecs: null,              region: GLOBAL }
    - { name: quad9,      provider: quad9,      ecs: null,              region: GLOBAL }  # P1
providers:
  google:     { kind: doh-json, url: "https://dns.google/resolve", ecs: true }
  cloudflare: { kind: doh-json, url: "https://cloudflare-dns.com/dns-query", ecs: false }
  quad9:      { kind: doh-wire, url: "https://dns.quad9.net/dns-query", ecs: false }  # P1
```

ECS-подсети — иллюстративные, держи их конфигурируемыми (это «откуда смотрим», не «кого спрашиваем»).
Валидатор должен проверять: если `provider.ecs == false`, у резолвера `ecs` обязан быть `null`.

---

## 5. Алгоритм опроса и схождение

### 5.1. Один раунд опроса (`poller.ts`)
Для каждого резолвера watch'а параллельно:
1. `fetch` DoH-эндпоинт провайдера с `name=domain&type=type` (+ `edns_client_subnet=ecs`, если задан).
2. Распарсить ответ. Результат раунда для резолвера — один из:
   - `match` — RRset совпал с `expected` по `match`-режиму;
   - `mismatch` — ответ получен, но не совпал (старое значение / частичная пропагация);
   - `error` — таймаут/сетевая ошибка/rate-limit/невалидный ответ.
3. Записать наблюдаемый TTL ответа (диагностика: видно, сколько старого TTL ещё «висит»).

`error` ≠ `mismatch`: ошибочный резолвер не считается «не сошёлся» — он считается «нет данных»,
по нему делается retry в следующем раунде, и он не блокирует схождение по `quorum`-режиму,
но блокирует по `all`. Логируй ошибки отдельно.

### 5.2. Нормализация и сравнение (`compare.ts`)
- A/AAAA: ответ может содержать цепочку CNAME → flatten до финального A/AAAA-набора, сравнивать
  как **множество** (round-robin переставляет порядок — порядок игнорировать).
- IP нормализовать (IPv6 в каноничную форму), FQDN — нижний регистр + завершающая точка.
- MX: сравнивать множество пар `(priority, host)`.
- TXT: склейка чанков, сравнение по строкам.
- `exact-set`: множество ответа == множество expected. `contains`: expected ⊆ ответ.

### 5.3. Схождение watch'а
- Резолвер «converged» в раунде, если его результат `match`.
- Раунд «полный», если: `mode=all` → все резолверы `match`; `mode=quorum` → ≥ `quorum` резолверов `match`.
- Watch объявляется **converged** только если «полный» раунд повторился `confirmations` раз
  подряд (анти-флап для anycast). По умолчанию `confirmations: 1`.
- Прогресс для UI — кумулятивный «N из M сошлись», но финальное решение — по правилу раундов выше.

### 5.4. Backoff (`backoff.ts`)
- Следующий интервал берётся из `schedule_sec` по номеру раунда; после конца — последний (при `hold_last`).
- К интервалу добавляется случайный jitter ±`jitter_pct`%.
- Перед каждым раундом проверяется общий `timeout_sec` от старта watch'а.

### 5.5. Precheck authoritative
Если `precheck_authoritative: true` — перед первым раундом резолвим NS зоны и спрашиваем
**authoritative-сервер напрямую**. Если он сам ещё не отдаёт `expected` — статус `error` +
уведомление «источник ещё не отдаёт новое, мониторить нечего», watch не стартует (или ждёт
authoritative, по флагу). Защищает от бесконечного мониторинга недокаченной правки.

---

## 6. Durable Object (`watch-do.ts`)

Один DO на watch, имя DO = `watch.id`. Storage DO держит: `definition`, `startedAt`,
`roundNo`, `perResolverState` (последний результат + observed TTL по каждому), `consecutiveFullRounds`,
`status`, `progressMessageId` (для edit-in-place).

Методы:
- `init(definition)` — сохранить определение, сделать precheck, поставить первый `alarm`.
- `alarm()` — отработать раунд: опрос → сравнение → обновить состояние → решить:
  - converged → уведомить успех, `status=done`, записать финальный лог в git, alarm не ставить;
  - timeout превышен → уведомить таймаут, `status=timeout`, финальный лог, стоп;
  - иначе → переставить `alarm` на следующий backoff-интервал, при `progress != off` — обновить
    сообщение в Telegram.
- `state()` — вернуть текущее состояние для Mini App.
- `pause()` / `resume()` / `cancel()` — управление; `cancel` снимает alarm и ставит `status=paused`.

После `done`/`timeout` DO остаётся с финальным состоянием (storage дёшев) для просмотра истории;
ретенция — см. открытые вопросы.

---

## 7. HTTP-контракт Worker (`index.ts`)

Все ответы JSON. Аутентификация — см. §9.

- `POST /api/watches/:id/start` — Mini App активирует watch: Worker читает `/watches/:id.yaml`
  из git (через GitHub API), валидирует, получает DO-стаб по `:id`, зовёт `init()`. Идемпотентно.
- `GET  /api/watches` — список watch'ей со статусами (читает git + опрашивает DO за прогрессом).
- `GET  /api/watches/:id` — детальное состояние (проксирует в `DO.state()`).
- `POST /api/watches/:id/(pause|resume|cancel)` — управление.
- `POST /webhook/github` — приём push-события (валидация `X-Hub-Signature-256`). На изменение
  в `/watches/` — авто-`init()` для новых/`active` watch'ей. Альтернатива ручному `/start`.
- `GET  /` и `/miniapp/*` — отдача статики Mini App.

Поток создания watch'а:
1. Mini App коммитит YAML в репо через Git Data API (домконовский механизм) — это аудит/источник правды.
2. Mini App дёргает `POST /api/watches/:id/start` — немедленная активация, не ждём webhook.
   (webhook — резервный путь и для правок мимо Mini App.)

---

## 8. Telegram Mini App (`/miniapp`)

Статика + Telegram WebApp SDK. Экраны:
- **Список** — карточки watch'ей: домен/тип, статус (active/done/timeout), прогресс «N/M»,
  время с момента старта.
- **Создание** — форма: домен, тип, expected-значения, `match`-режим, пресет резолверов,
  пресет backoff, chat для уведомлений, флаг precheck. Submit → коммит YAML + `/start`.
- **Детализация** — живой прогресс: сетка резолверов (регион → match/mismatch/error + observed TTL),
  текущий шаг backoff, время до таймаута, кнопки pause/resume/cancel.

Прогресс тянуть поллингом `GET /api/watches/:id` (раз в несколько секунд, пока открыт экран).

---

## 9. Безопасность (`auth.ts`)

- **Mini App → Worker:** валидация Telegram `initData` — HMAC-SHA256 по схеме Telegram
  (secret_key = HMAC-SHA256("WebAppData", bot_token), проверка `hash` над отсортированными полями).
  Невалидный initData → 401.
- **GitHub webhook → Worker:** проверка `X-Hub-Signature-256` (HMAC-SHA256 тела webhook-секретом).
- **Worker → GitHub:** fine-grained PAT или GitHub App token (scope: contents RW на этот репо) —
  секрет Worker'а.
- **Worker → Telegram:** bot token — секрет Worker'а.
- Секреты только через `wrangler secret` / dashboard, никогда в репо и не в KV.
- В Mini App пускать только `telegram_chat_ids`, перечисленные в watch'е / allowlist.

---

## 10. CI/CD (Actions — только это)

- `validate.yml` (на PR, меняющий `/watches/**` или `/resolvers/**`):
  - валидировать каждый YAML по `watch.schema.json`;
  - проверить, что `id` == имя файла; resolver-пресеты существуют; ECS-инвариант (§4);
  - формат `expected.values` соответствует `type`;
  - падать с понятным сообщением при ошибке.
- `deploy.yml` (на merge в main): `wrangler deploy` Worker'а + деплой Mini App
  (Pages или отдача из Worker'а — см. §2). Реестр резолверов раскатывается вместе с Worker'ом.

---

## 11. Краевые случаи (заложить, не «на потом»)

- **Negative caching:** для новой записи часть резолверов держит «нет такого» по SOA `minimum` —
  схождение просто наступит позже, монитор это отловит штатно. Документировать в README.
- **DoH rate-limit / 5xx:** экспоненциальный retry внутри раунда, статус `error`, не `mismatch`.
- **CNAME-цепочки:** flatten до финального типа (см. §5.2).
- **Множественные A (round-robin):** сравнение множеств, порядок не важен.
- **IDN:** домен в punycode до запроса.
- **Cloudflare strip ECS:** не слать ECS Cloudflare/Quad9 — иначе ложное ощущение гео-покрытия.
- **Флап anycast:** гасится `confirmations ≥ 2` при необходимости.

---

## 12. Критерии приёмки

1. YAML-watch на A-запись с двумя IP и пресетом `global-8` активируется из Mini App,
   DO стартует, первый раунд — через ~30 с (± jitter).
2. Пока хоть один резолвер отдаёт старое значение — watch остаётся `active`, прогресс < M/M.
3. Когда все резолверы из пресета вернули `expected` `confirmations` раз подряд — приходит
   Telegram-уведомление об успехе с временем схождения и срезом N/M; `status=done`; в git
   записан финальный лог.
4. По достижении `timeout_sec` без схождения — уведомление о таймауте с последним срезом; `status=timeout`.
5. `error`-резолвер (недоступный DoH) не считается за `mismatch` и логируется отдельно.
6. ECS реально влияет: запрос к Google с разными `edns_client_subnet` может в один и тот же
   момент давать разные ответы (проверяемо на свежей правке).
7. `validate.yml` роняет PR с битым YAML; `deploy.yml` катит Worker на merge.
8. Нигде нет Actions-cron для опроса (grep по `schedule:` в workflow'ах — пусто).

---

## 13. Фазы

- **P0 (MVP, один tenant):** git-декларации + DO с backoff + JSON-DoH (Google с ECS + Cloudflare)
  + сравнение + Telegram финал/таймаут + Mini App (список/создание/детализация) + CI. Покрывает
  гео-срез честно уже на Google+ECS.
- **P1:** wireformat-DoH (Quad9/OpenDNS) для большего числа независимых провайдеров; edit-in-place
  прогресс; precheck authoritative; quorum-режим в UI.
- **P2:** мультиарендность; шаблоны watch'ей; экспорт истории схождений; авто-watch по вебхуку
  от провайдера DNS (если у твоего регистратора есть событие об изменении).

---

## 14. Значения по умолчанию и открытые вопросы

Прими по умолчанию, если не переопределю:
- backoff: `[30,30,60,60,120,300,600,1800,3600]`, hold_last, jitter 10 %, timeout 48 ч;
- `mode: all`, `confirmations: 1`, `match: exact-set`;
- хранилище рантайма: DO storage (KV — только кэш реестра/листинга);
- Mini App отдаётся из Worker'а (не отдельный Pages), чтобы домен один.

Открытые (нужно твоё решение, но не блокируют P0 — есть дефолт):
1. Реальные ECS-подсети по регионам — уточнить под нужную географию (дефолт в §4 — заглушки).
2. Ретенция завершённых DO: держать вечно / TTL N дней (дефолт — держать, чистка вручную).
3. Один репо на всё или Mini App вынести (дефолт — монорепо как в §2).
4. Имя продукта: «Сходкон» — рабочее, переименуй под Aplicon-конвенцию.

---

## 15. Стек (зафиксировано)

TypeScript; Cloudflare Workers + Durable Objects (alarms); KV (кэш); `wrangler`; Telegram Bot API
+ WebApp SDK; GitHub REST/Git Data API; GitHub Actions (CI only); DoH JSON (P0) → +wireformat (P1).
Без внешней БД, без серверного рантайма вне CF.
