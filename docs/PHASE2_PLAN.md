# План: Phase 2 (готовим, работа в следующей сессии) и Phase 3 (multi-layer/via, отложен)

Дата: 2026-10-30. Контекст: phase 1 (одинарный металл, векторизация + contacts/snap)
работает на experimental. Текущее состояние инцидентов и оптимизаций decode-конвейера
см. memory/2026-10-30.md — техдолг по decode гаснёт сам за счёт этих фиксов.

---

## Phase 2 — следующая сессия

### P2-1. Фильтр трасс по штрихованным (snapshot) user-нарисованным шинам

> ✅ Реализовано 2026-11-01: `userNetFilter.ts` (правила 1–2 из формализации ниже),
> тумблер «respect hand-drawn nets» в Vector-вкладке (prefs `vectorRespectUserNets`,
> по умолчанию ВКЛ), счётчик «совпадает с нарисованными вручную» в диалоге
> материализации. Юнит-тесты: `userNetFilter.test.ts`. Скоуп — vector-путь
> (ML-путь `Traces → nets` пока без фильтра).

Проблема: пользователь уже нарисовал nets вручную; векторизация выдаёт те же шины
и при материализации ДУБЛИРУЕТ их (перезапись/расщепление уровня предупреждений -
нежелательно).

Идея (формализация):

- Вход: `annotations.nets` (polyline, node-edge graph, user width) в текущем
  честном скоупе; для каждого user провода строим буферную область
  `polyline ± max(width/2, tol)`.
- Детект пересечения трассы с user-проводом:
  (i) какой-нибудь сегмент трассы строго пересекает сегмент user-полилинии, ИЛИ
  (ii) центрline-вершина трассы внутри буфера.
- СЕМАНТИКА целя направленны и согласованы с «контурами»: если user-провод
  пересекает ВЕКТОРИЗОВАННЫЙ outline-полигон металла, то трассы целиком
  внутри этого полигона дропаются (полигон обычно принадлежит одной уже
  нарисованной сети), но трассы, проходящие МИМО полигона, не трогаются.
  Пограничный случай: полигон с двумя разными проводами — оставить трассы,
  дроп только точных пересечений (формализуем: drop = EITHER trace overlaps
  user buffer OR trace fully inside an outline polygon that user wire crosses).
- Место: чистая функция `filterTracesByUserNets(traces, userPolylines, outlines,
  tol)` между `collectTraces()`/`collectOutlines()` и `buildNetsFromTraces()`
  (та же позиция, где уже чистая outline-connect логика, но без вмешательства).
- UI: тумблер «Respect hand-drawn nets» в Trace-вкладке + счётчик дропнутых в
  диалоге материализации (+warnings).

### P2-2. Инструмент «Nets from …» (ограничение области материализации)

> ✅ Реализовано 2026-11-01: «vector»-инструменты тулбара `traceRegionRect`
> (drag rectangle, commit on release) и `traceRegionPoly` (click-vertices,
> Enter). Регионы — session state в dieViewer store
> (`traceRegionsByDie[dieId]`, переживает reset). Рендер: culling по bbox
> против ≥1 региона в `VectorizeLayer.draw()`/`drawSaved()` (saved-битмапы
> выключаются при активных регионах). Материализация: тот же фильтр перед
> hand-drawn-фильтром, счётчик «вне trace region» в диалоге. UI: список
> «Trace Regions» в OutlineTree рядом с Vector Layers + 🗑-удаление.
> viewport-preview режим уже был (коллекция из live decodes).

Сейчас материализация всегда whole-die (все собранные трассы). Нужны режимы:

- «whole die» — как сейчас;
- «viewport preview» — только то, что видно (у live overlay это уже фактически
  так; для saved layers добавить same culling);
- **«trace region» (новое)**: рисование прямоугольников и полигонов; шины
  рендерятся и материализуются ТОЛЬКО внутри выбранной области.

Реализация:

- store-ив State: `vectorTraceRegions: (Rect | polygon)[]` (второе название —
  родитель для Lisa/RoI-режима). Инструмент рисования: переиспользовать
  существующие RectDraftOverlay / PolyDraftOverlay х fabulous.
- Рендер: в `VectorizeLayer.draw()` / `drawSaved()` — culling по bbox
  trace/outline против хотя бы одного region.
- Материализация: тот же фильтр передаётся в `buildNetsFromTraces`.
- Управление регионами: списки в OutlineTree (Vector Layers рядом), удаление
  региона (клик/ключ Delete), переиспользуемые объекты.
- Пересекается с P2-1: работают совместно!!

### P2-3. Предварительная обработка изображения перед векторизацией

> ✅ Реализовано 2026-11-01: `VectorizeParams.preprocess` (subobject, flat
> scalars; neutral = no-op) — tone LUT (brightness/contrast/gamma/shadows/
> highlights одним LUT) → median denoise → CLAHE (per-channel) → unsharp.
> Применяется в sidecar (cv2) СРАЗУ после imdecode у `/vectorize/region` и
> `/vectorize/mask` — так что live-регионы, sweep-блоки и trace-region
> кропы видят одни и те же preprocess-пиксели. `mask_pad_px`/`maskPad`
> учли denoise/unsharp-радиусы (безтайл-инвариант сохранён).
> `vectorParamsHash` включает preprocess по-скалярно → новая настройка =
> новый sweep-dir (старые runs остаются как saved layers). UI —
> схлопываемая секция «Preprocess» в Vector-вкладке (VSlider'ы + reset),
> `params.json`/пресеты берут subobject автоматом. ВАЖНО: sidecar
> трогает python-код → нужен рестарт sidecar'а.
>
> ✅ Превью (2026-11-01): тумблер «preview processed pixels (live viewport)»
> в секции Preprocess — VectorizeLayer по debounce тянет
> `POST /api/dies/:dieId/vectorize/preprocess-preview` (sharp-кроп
> viewport'а, даунскейл ≤ 1200 px/сторона) и блиттит обработанные пиксели
> ПОД overlay (амбер-пунктирная рамка = extent превью). ROI для подбора —
> сам live viewport (превью требует включённого overlay — оно подложка
> под live-декод). Sidecar: `POST /vectorize/preprocess`
> (без CV-гейта; тот же apply_preprocess).

Цель: юзер подбирает обработку, при которой металл максимально однородный и
контрастный, и только потом крутит порог/morphology. Что Problems to Solve:

- параметры: brightness/contrast (USM-кривая), тени/света (shadow/highlight),
  gamma, CLAHE (clip+tile), unsharp (sharpen), median/bilateral (denoise),
  inversions/уровни — каждая опциональна, кривая — точка-каскад.
- Формат параметров: `preprocess: {brightness, contrast, gamma, shadows,
  highlights, clahe, sharpen, denoise}` — в `VectorizeParams` (подобъект,
  влияет на `vectorParamsHash` → старые кэши инвалидятся само).

Архитектура «без тонны кэша на комбинации настроек»:

- НЕ заводить новые тайл-пирамиды и НЕ пекать обработанное изображение.
- Обработка = дешёвая ПО-ПИКСЕЛЬНАЯ часть через LUT (cv2.LUT, 256 entry) +
  локальная часть (CLAHE/unsharp/median) — применяется НА ЛЕТУ к crop'у в
  момент, когда он и так режется: `vectorize region` (live), block mask
  (sweep), trace-region crops. Пишут processed pixel в инвариантно к тайлам.
- Превью по ROI: слайдер/фильтры видят ЭФФЕКТ только на векторном overlay и
  pipette (кэшируя LUT). Если хочется видеть обработанное изображение — в
  слое рендера применяем LUT на лету (CSS/canvas filter или копия тайла с
  applied LUT в кан Ее виде ломаем тайл-/cache — дешево, т.к. LUT).
- Sweep: блок после обрезки проходит preprocess → build_mask; кэш ключ
  уже включает preprocess params (см. hash) — разные настройки сидят в
  разных sweep-dir, как и сегодня.
- UI: секция «Preprocess» в Trace tab: слайдеры + пресеты; «пуле->UTF»
  определения «однородности металла» — pipette-подобная метрика (дисперсия
  LUT-выхода внутри metal cohort) - опционально, потом.

Риски/вопросы: скорость live 5 Mpx viewport на CPU (CLAHE tile ~n×n), доля
времени sweep (~+10-20% на блок), согласование с pipette (цвет → LUT до или
после канала; скорее LUT работает на оттенок выбранного канала первым).

### Sanый скоуп работы: phase-3а–3c... (декодер, если успеем): векторизация merge-стадии согласно memory/2026-10-30.md → «далее всё быстро»

---

## Phase 3 — отложено (multi-level metal + vias)

Полный план был в чате 30.10 (после код-ревью phase 1). Краткая выжимка:

- Слои как измерение пайплайна: `MLTracePolyline.layer`, per-layer пресеты
  VectorizeParams, кэш `vectorize/<die>/<layerId>/<hash>`, UI-селектор metal1/metal2.
- Via как входные данные: (a) ML-predict + approve-flow (готово для vias-клеток),
  (b) ручной «draw via» (bbox + level VIA12/VIA23), хранение в annotations.
- Merge через via: `mergeNetsAcrossLayers(netsByLayer, vias, outlinesByLayer,
  viaTol)` — чистая функция; период-условие: via bbox (центр) точка-в-контуре
  ME1-контура И ME2-контура (каждый раздут на ±viaTol, um) → via становится
  узлом: ME1-node(x,y) – VIA12 edge – ME2-node(x,y), layer="via12";
  через via собирается ОДИН net.
- renderer: zero-length via edge рисуется как marker.
- UI: OutlineTree группировка по слоям, per-layer params (вкладки),
  viaTol (um) в наст.
- Типы MetalStack/MetalLevel/ViaLevel уже в shared/src/types.ts.
