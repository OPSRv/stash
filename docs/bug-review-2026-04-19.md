# Bug Review — 2026-04-19

Scope: commits `a231415` → `dc1c20f` on `main` (translator two-pane refactor + Settings/Recorder/Select file splits).

Overall: refactors are clean — no broken prop threading, no dropped effect cleanup, no eager-imported lazy views, no hardcoded accent RGB, no `ru` in language lists, no `dangerouslySetInnerHTML`. Handful of real correctness issues below, prioritised.

---

## High

### 1. Історія не оновлюється після delete / clear-all / incoming auto-translate

**File:** `src/modules/translator/TranslatorShell.tsx:99-110, 160-171, 199-210`
**Severity:** High

Три місця намагаються тригернути refetch історії через «поштовх» стану:

```ts
setHistoryQuery((q) => q);   // performDelete
setHistoryQuery('');         // confirmClearAll
setHistoryQuery('');         // clipboard:translated listener (коли query порожній)
```

React bailout-ить ре-рендер, коли `setState` отримує ідентичне значення за `Object.is`. `(q) => q` або `''`, коли `historyQuery === ''` — no-op. Ефект у `useHistorySearch` не ре-ран-ить, список лишається застарілим: видалений рядок все ще видно, після clear-all — далі показує старі елементи, нові авто-переклади з бекенда не з’являються, поки юзер не набере щось у пошуку.

**Evidence:** `useHistorySearch` ре-ран-ить тільки на `[query, onResults]`. Після `translatorClear()` юзер бачить populated список із toast-ом «Translations cleared» — bug виглядає як збій бекенда.

**Fix:** Експортнути `refetch` з `useHistorySearch` (або взяти `reloadKey: number` у deps, і bump-ити його), і викликати у трьох місцях. Не покладатися на `setState` з незмінним значенням, щоб перезапустити ефект.

---

### 2. `useHistorySearch` — гонка застарілих відповідей

**File:** `src/modules/translator/useHistorySearch.ts:14-23`
**Severity:** High (псує видимий стан, не лише перф)

Немає cancel-прапорця / AbortController. Якщо старіший `translatorSearch("h")` резолвиться після новішого `translatorSearch("hel")`, старіші, менш специфічні результати затирають поточні. Дебаунс збирає burst-и в одному tick-у, але міжIPC round-trip-и можуть перетинатися при печатанні повільніше ніж 150 мс/символ.

```ts
const load = trimmed ? translatorSearch(trimmed) : translatorList();
load.then(onResults).catch(...);
```

**Fix:**

```ts
useEffect(() => {
  let cancelled = false;
  const timer = window.setTimeout(() => {
    const load = trimmed ? translatorSearch(trimmed) : translatorList();
    load.then((rows) => { if (!cancelled) onResults(rows); }).catch(console.error);
  }, trimmed ? HISTORY_SEARCH_DEBOUNCE_MS : 0);
  return () => { cancelled = true; window.clearTimeout(timer); };
}, [query, onResults]);
```

---

## Medium

### 3. `clipboard:translated` refresh працює тільки якщо юзер уже пошукав і очистив

**File:** `src/modules/translator/TranslatorShell.tsx:99-110`
**Severity:** Medium (підмножина #1, але коментар стверджує протилежне)

Коментар каже «Empty query → useHistorySearch already listens… trigger refresh by temporarily flipping state». Але `setHistoryQuery('')`, коли `historyQuery === ''` (дефолт) — не флаг-ає нічого, переходу немає. Авто-переклади з бекенда не з’являться в панелі, поки юзер хоч раз не набрав і не стер запит.

**Fix:** Як у #1 — explicit reload key.

---

### 4. `handleSwap` може no-op-нутися проти dedupe-кешу `useAutoTranslate`

**File:** `src/modules/translator/TranslatorShell.tsx:124-136`, `useAutoTranslate.ts:24-34`
**Severity:** Medium

Після swap-у ми виставляємо `draft = liveResult.translated`, `target = liveResult.from`. Якщо юзер уже перекладав `translated` → `from` (swap-туди-й-назад), `lastTranslatedRef.current` збігається з `{ text, to }`, і `useAutoTranslate` скіпне round-trip. `setLiveResult(null)` очищає видиму панель, але не кеш хука — UI залипає в empty state «Translation appears here».

**Evidence:** `lastTranslatedRef` живе в хуці, ресетиться тільки коли `draft` порожній. `handleSwap` не може його інвалідувати.

**Fix:** (a) вернути `reset()` з `useAutoTranslate` і кликати з `handleSwap`, або (b) викинути dedupe-кеш повністю — покластися на debounce + `liveResult` як suppression-логіку. Зайвий IPC рідко і дешево.

---

### 5. Toast stack cap лишає orphan dismiss-таймери

**File:** `src/shared/ui/Toast.tsx:45-54`
**Severity:** Medium (не leak, але fragile)

Коли `next.slice(-MAX_VISIBLE)` викидає переповнений toast, запис у `timersRef` живе до таймауту. `dismiss(id)` no-op-иться завдяки унікальним id, але будь-яка фіча на базі «was this toast ever visible» через цей dangling entry спотикнеться.

**Fix:**

```ts
setItems((prev) => {
  const next = [...prev, { ...input, id }];
  const visible = next.slice(-MAX_VISIBLE);
  for (const dropped of next.slice(0, -MAX_VISIBLE)) {
    const t = timersRef.current.get(dropped.id);
    if (t !== undefined) { window.clearTimeout(t); timersRef.current.delete(dropped.id); }
  }
  return visible;
});
```

---

## Low

### 6. ~~`groupByDate` плутає DST-зсунуті дні~~ — НЕ БАГ

**File:** `src/modules/translator/groupByDate.ts:22-30`
**Status:** False positive — перевірено в Europe/Kyiv для весняного (2026-03-29) і осіннього (2026-10-25) переходів.

`todayStart` анкорений на wall-clock-опівноч через `setHours(0,0,0,0)`. Віднімання `86_400s` від UTC-timestamp-у дає ту саму календарну точку, що й `new Date(todayStart).setDate(d-1)`, бо JS Date внутрішньо оперує UTC, а DST-offset уже врахований у значенні `todayStart`. Ніякого misbucketing у реальних тайм-зонах.

Коментар у тесті (`"so we don't straddle a DST boundary"`) надмірно обережний — код коректний для DST-днів. Можна залишити як safety-фіксацію.

---

### 7. `TranslationVirtualList` — константний `estimateSize: () => 96`

**File:** `src/modules/translator/TranslationVirtualList.tsx:28-31`
**Severity:** Low

`TranslationRow` містить `line-clamp-2` original + translated блок без clamp-у. Довгі переклади переносяться і легко перевищують 96 px. `measureElement` фіксить це з часом, але scroll jumps посередині скроллу при довгій історії.

**Fix:** або clamp-ити translated text теж, або кращий естіматор, e.g. `Math.min(200, 72 + Math.ceil(row.translated.length / 60) * 18)`.

---

### 8. Test coverage gap ховає #1 і #2

**File:** `src/modules/translator/TranslatorShell.test.tsx`
**Severity:** Low

Жоден із чотирьох тестів не ганяє delete/clear/incoming-translation refresh, і не перевіряє out-of-order резолви в `useHistorySearch`.

**Fix:**
- Тест із двома послідовними `translator_search` які резолвляться в зворотному порядку.
- Тест який асертить що `translator_list` викликається після `translatorDelete`.

---

## Verified clean (no issues)

- Жодних eager-import у `modules/*/index.tsx` — pattern lazy + `preloadPopup` цілий.
- `set_popup_auto_hide` paired коректно навколо native dialog-ів:
  - `src/settings/DownloadsTab.tsx:26,33` (folder picker)
  - `src/modules/notes/NotesShell.tsx:167/184`, `189/204` (import/export) — не чіпали.
- Немає hardcoded `rgba(…)` для accent-у; усі matches — нейтральні white/black overlay.
- Немає `ru` у `TARGET_LANGUAGES`; `languages.test.ts` та `api.test.ts` це асертять.
- Немає `dangerouslySetInnerHTML` у `src/`.
- `useTranslatorHotkeys` коректно ребайндить listener на dep change; ref identity стабільний.
- Toast → ToastCard split зберігає timer lifecycle; cleanup на unmount провайдера прибирає усі таймери.
- `Select.tsx` split: `Select.icons.tsx` — прямі свапи; mousedown-outside cleanup є; `useLayoutEffect` focus transfer зберігся.
- Recorder shell (`AudioSourceRow`, `PermissionBanner`, `RecordPill`, `SectionHeader`, `icons`): усі props прокинуті, коллбеки не загублені. Pre-existing `countdownRef` cleanup-on-unmount gap — **не новий**.
- `ClipboardVirtualList` / `ClipboardVirtualListBody` — key / flatIndex math та virtualizer wiring ідентичні pre-split семантиці.

---

Найвищий пріоритет — **#1** і **#2**. Це той тип регресій, який рефактор робить легким пропустити: move inline → hook приховав припущення «flip query to poke useEffect», яке більше не виконується з реальним dep-масивом.
