# Bug Review Part 2 — 2026-04-19

Scope: modules поза translator — recorder, downloader, clipboard, notes, music, metronome, settings, shared, Rust commands.

---

## High

### H1. Recorder countdown timeout не чиститься на unmount

**File:** `src/modules/recorder/RecorderShell.tsx:118` (scheduled at 292/296)
Chain-scheduled `setTimeout` не має mount-scoped cleanup. На unmount під час відліку `startRecording()` все одно запускається + React warning про state update на dead component.

**Fix:** `useEffect(() => () => { if (countdownRef.current) clearTimeout(countdownRef.current); }, []);`

### H2. Notes autosave — дубль-create race

**File:** `src/modules/notes/NotesShell.tsx:90-117`
Коли `activeId == null` і юзер друкує, debounced `notesCreate()` в польоті. Поки він резолвиться, ще один `scheduleSave` може закритися над `activeId === null` і створити дубль.

**Fix:** in-flight flag / pending-id sentinel; chain наступний save замість нового create.

### H3. Notes `saveTimer` / `savedClearTimer` без cleanup на unmount

**File:** `src/modules/notes/NotesShell.tsx:52-53, 95, 109`
Таймери в refs, unmount не прибирає. Timeout спрацьовує, тягне `notesUpdate`, `setSaveStatus` на dead component.

**Fix:** unmount cleanup що чистить обидва.

### H4. Clipboard `copyFlash` setTimeout leak

**File:** `src/modules/clipboard/ClipboardPopup.tsx:101`
У listener-і `clipboard:changed` — `setTimeout(…450ms)` без handle. Часті зміни → накопичення pending таймерів. Unmount в межах 450 ms → setState на dead component.

**Fix:** handle у ref; clear перед пере-плануванням + на unmount.

---

## Medium

### M1. Downloader — черга стоїть під час transient-retry backoff

**File:** `src-tauri/src/modules/downloader/runner.rs:327-343`
Transient-failure spawns thread з sleep 2-6 s перед `retry_download`. `drain_queue(...)` не кличеться → слот вільний, але наступні pending jobs чекають до 6 s.

**Fix:** викликати `drain_queue(...)` перед sleep (або всередині перед sleep).

### M2. Downloader `retry_counts` map leak

**File:** `src-tauri/src/modules/downloader/runner.rs:296-318`
Entry прибирається лише на final-failure. На success не видаляється → мапа росте.

**Fix:** `retry_counts.remove(&id)` у set_completed гілці.

### M3. `YtDlpUpdateRow` setState на unmounted component

**File:** `src/settings/YtDlpUpdateRow.tsx:14-26`
Interval очищається, але in-flight `ytDlpVersion()` від попереднього render-у резолвиться вже після unmount.

**Fix:** `cancelled` ref у effect, guard-ити `setInfo/setError`.

### M4. Metronome — pending beat `setTimeout`-и не cancel-яться у `stop()`

**File:** `src/modules/metronome/hooks/useMetronomeEngine.ts:87-91`
Кожен scheduled beat tick шле `setTimeout` (up to 100 ms ahead). На `stop()` — не скасовуються; beat strip мерехтить до 100 ms після Stop; можливі callback-и на dead subscriber.

**Fix:** `Set<number>` у ref; clear на `stop()` і на unmount.

### M5. Clipboard/Notes LIKE pattern без escape

**Files:** `src-tauri/src/modules/clipboard/repo.rs:89-97`, `notes/repo.rs:76-85`
`format!("%{}%", query)` — `%` / `_` у запиті — wildcard. Пошук `foo_bar` матчить `fooXbar`. Не injection (bind), але неочікувані matches.

**Fix:** escape `%`, `_`, `\`; `LIKE ?1 ESCAPE '\'`.

---

## Low

### L1. Notes `list()` без LIMIT

**File:** `src-tauri/src/modules/notes/repo.rs:67-73`
`SELECT * FROM notes ORDER BY updated_at DESC` — unbounded. Clipboard має limit; notes — ні.

**Fix:** LIMIT (e.g. 500) як у clipboard.

### L2. `MusicShell` rAF cleanup — fragile ordering

**File:** `src/modules/music/MusicShell.tsx:70-77, 111-112`
`let cancelHandle = raf1` після ref-ерансу в callback-у. Працює тільки бо rAF — наступний tick. Redundant `cancelAnimationFrame(raf1) + cancelAnimationFrame(cancelHandle)`.

**Fix:** один ref на поточний scheduled rAF.

### L3. `GlobalSearch` focus setTimeout leak

**File:** `src/shared/ui/GlobalSearch.tsx:59`
`setTimeout(..., 10)` на кожному `open=true` без cleanup. Low real impact.

**Fix:** track handle; clear у cleanup.

---

## Verified clean

- Tauri event listeners — усі paired з `unlisten()` cleanup: `PopupShell`, `ClipboardPopup`, `useDownloadJobs`, `RecorderShell`, `CameraPipWindow`, `TranslatorShell`.
- `set_popup_auto_hide` pairing — `NotesShell` (167/184, 189/204), `DownloadsTab` (26/33). Усі в try/finally.
- Жодного `'ru'` у production.
- Жодного `dangerouslySetInnerHTML` / unsafe URL scheme / raw `format!`-SQL.
- `useVideoDetect` epoch-counter коректно відкидає stale responses.
- `useDownloadJobs` progress throttle memo-ує rівність.
- Metronome — interval/AudioContext cleanup на unmount.
- `useYouTubePlayer` — poll interval + player destroy cleaned up.
- `MusicShell` IntersectionObserver/ResizeObserver disconnect + `musicHide()`.
