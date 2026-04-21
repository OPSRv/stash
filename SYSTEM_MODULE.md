# Модуль `system` — план і статус

CleanMyMac-подібний набір утиліт у меню-бар форматі Stash. Лівий рейл
згруповано на 4 секції: **Огляд**, **Диск**, **Система**, **Приватність**.
Кожна фіча — окрема панель із власною кольоровою айдентикою (градієнтний
тайл + glow).

Легенда:
- [x] реалізовано
- [~] частково (UI або back-end неповні)
- [ ] у планах

## Архітектурні принципи

- [x] Навігація: лівий рейл ~176 px, згрупована 4 секціями.
- [x] Рендеринг модуля `React.lazy` — System не грузиться, поки його таб
      не відкрили.
- [x] Всі Tauri-команди з `system_*` префіксом виконуються у
      `tauri::async_runtime::spawn_blocking`.
- [x] Жодних нових Cargo-залежностей — реалізація стоїть на `walkdir`,
      `sha2`, `libc`, `enigo`, `plutil/osascript/ps/pmset/launchctl/xcrun/tmutil`.
- [x] Поріг ≥500 MB для "важких процесів" — константа `HEAVY_RSS_BYTES`.
- [x] Folder-picker через `pickFolder()` helper, що коректно обгортає
      `set_popup_auto_hide` (інакше popup ховається на фокус модалки).

---

## Огляд

### [x] Dashboard (Огляд)
- [x] `top -l 1 -n 0` парсер: CPU%, load avg 1m/5m/15m, PhysMem used/total.
- [x] `df -k /` — використання диска + окрема картка **Вільне місце**.
- [x] `pmset -g batt` — заряд батареї + `charging/discharging`.
- [x] `sysctl -n kern.boottime` — uptime у форматі «2д 5г».
- [x] Лічильник процесів через `ps -axo pid=`.
- [x] `ping -c 1 -W 500 1.1.1.1` — латентність мережі з кольоровим
      індикатором (<30 зелений / <100 жовтий / червоний).
- [x] Мережеві інтерфейси: `netstat -ibn` + класифікація Wi-Fi/Ethernet
      через `networksetup -listallhardwareports`; автодетект primary
      через `route -n get default`. Живі download/upload швидкості через
      delta rx/tx між полами + подвійна sparkline на кожен інтерфейс.
- [x] 4 основні градієнтні картки: CPU, RAM, Disk, Battery — RadialGauge
      + live sparkline (історія 40 точок, poll 1.5 с).
- [x] Page Visibility API — полінг паузиться коли Stash не видно.
- [x] Юніт-тести парсерів `top`, `ping`, `parse_human_bytes`.

### [x] Процеси
- [x] `ps -axo pid,rss,%cpu,user,command`, парсинг basename команди
      (регресія «Acr → Ac» виправлена).
- [x] Фільтр ≥500 MB (toggle), пошук, сортування RAM/CPU/Назва з ↑↓.
- [x] Force quit (SIGKILL) / Завершити (SIGTERM) з confirm.
- [x] Кольорові маркери RAM (зелений → малиновий).
- [x] **Віртуалізація** через `@tanstack/react-virtual` — 500+ процесів
      більше не спричиняють рендер-лаг на 2-секундному poll.
- [x] Page Visibility API — полінг паузиться коли інший таб активний.

### [x] Мережа
- [x] `lsof -i -n -P` парсер (TCP/UDP з розбором `local->remote (state)`).
- [x] Пошук за процесом/адресою/PID/станом.
- [x] Force-kill процесу кнопкою (SIGKILL).
- [x] Автооновлення 5 с із Page Visibility паузою.
- [x] **Віртуалізація** довгого списку (300+ зʼєднань у Chrome).
- [x] Юніт-тест парсингу.

### [x] Екрани
- [x] `system_profiler SPDisplaysDataType -json` — список дисплеїв (main,
      mirror, роздільність).
- [x] Sleep displays (`pmset displaysleepnow`).
- [x] Brightness ± (enigo `Key::BrightnessUp/Down`).
- [x] Юніт-тест парсингу JSON.
- [ ] Абсолютний Brightness slider — потребує private framework
      `CoreDisplay_Display_SetUserBrightness`. Tier 2.

### [x] Батарея
- [x] `system_profiler SPPowerDataType -json` — cycle_count, condition,
      max/current/design capacity (mAh).
- [x] 4 кольорові картки + здоров'я %.
- [x] Graceful fallback коли батареї немає (desktop).

### [x] Швидкі дії
- [x] 5 великих тайлів-кнопок: Sleep, Lock screen, Purge RAM, Flush DNS,
      Reindex Spotlight.
- [x] Confirm на небезпечні (Spotlight, purge).
- [x] `purge` потребує sudo — повідомлення в toast з підказкою запустити
      в Terminal.

---

## Диск

### [x] Великі файли
- [x] Walk home, фільтри 100 MB / 500 MB / 1 GB.
- [x] Skip: caches, node_modules, .git, Containers, MobileSync, .Trash.
- [x] Sort desc, топ-500, Reveal, Trash (Finder AppleScript).

### [x] node_modules (рекурсивний сканер)
- [x] Обирається довільна папка через `pickFolder()`.
- [x] `WalkDir` не спускається в знайдений node_modules (бо інакше monorepo
      видає тисячі дочірніх).
- [x] Фільтр `.hidden` (але залишаємо root навіть якщо він такий —
      tempdir macOS створює `.tmpXXXX`).
- [x] Multi-select + bulk trash + re-scan після видалення.
- [x] Sort desc, дата останньої модифікації для кожного.
- [x] Юніт-тести: знахідка без descent, skip-hidden.

### [x] Кеші
- [x] 13 curated-категорій (Xcode DerivedData/iOS DeviceSupport/Archives,
      npm, pnpm, Yarn, Cargo, Gradle, Chrome/Safari/Firefox/Arc cache,
      QuickLook).
- [x] Теги safe / regeneratable / browser, кольорові піли.
- [x] Multi-select, Обрати все, сумарний лічильник, bulk-trash.

### [x] Кошики
- [x] `~/.Trash` + `/Volumes/*/.Trashes/<uid>` на кожному змонтованому томі.
- [x] Розмір + кількість елементів.
- [x] Empty all через Finder AppleScript.
- [x] Юніт-тест.

### [x] Важке на диску
Об'єднана панель із 5 суб-табами (SegmentedControl):
- [x] **Screens** — `~/Desktop/Screenshot *.png` (+ кастомна локація
      `defaults read com.apple.screencapture location`). Сорт за датою.
- [x] **iOS** — `~/Library/Application Support/MobileSync/Backup/*`, ім'я
      пристрою з Info.plist через `plutil -extract`.
- [x] **Mail** — `~/Library/Mail/V*` (версійні теки з усіма вкладеннями).
- [x] **Xcode** — `~/Library/Developer/CoreSimulator/Devices/*`, крос з
      `xcrun simctl list devices -j` для `isAvailable`. Bulk action
      `xcrun simctl delete unavailable`.
- [x] **TM** — `tmutil listlocalsnapshots /` + `tmutil deletelocalsnapshots`.
- [x] Юніт-тести: парсинг screenshot naming, refuse empty TM id.

### [x] Дублікати
- [x] SHA-256 у 2 проходи: групування за розміром, потім хеш лише у
      мульти-елементних групах.
- [x] Пороги 1 MB / 10 MB / 100 MB.
- [x] Group UI з hash-preview, Reveal + Trash (окрім першого — "оригінал").
- [x] Юніт-тест.

---

## Система

### [x] Деінсталятор
- [x] `/Applications` + `~/Applications`, bundle id через `plutil`.
- [x] Пошук залишків (depth=1) у 11 Library-локаціях за bundle id АБО
      name.
- [x] Master/detail UI з метриками app/leftovers/total.
- [x] Trash всього набору одним кліком з confirm.

### [x] Автозапуск
- [x] `~/Library/LaunchAgents` + `/Library/LaunchAgents`.
- [x] Крос з `launchctl list` (PID якщо завантажено).
- [x] Toggle: `launchctl load|unload -w`.
- [x] Групування user/system у UI.
- [ ] LaunchDaemons (`/Library/LaunchDaemons`) — всі потребують sudo,
      навіть read часто падає.
- [ ] SM-Login Items (macOS 13+) — окремий API.

---

## Приватність

### [x] Privacy Cleaner
- [x] Safari/Chrome/Firefox/Arc history (лише DB — НЕ чіпаємо cookies).
- [x] QuickLook thumbnails.
- [x] Finder plist, Recent Documents (sharedfilelist).
- [x] Shell history (zsh + bash).
- [x] Кольорові піли категорій (browser / system / terminal).
- [x] Юніт-тест.

---

## Нові розділи (останній цикл)

### [x] Smart Scan (Розумне прибирання)
Один клік = Caches + старі скріншоти (>30 днів) + TM snapshots + недоступні
Xcode-sim + Docker unused + Trash. Показує сумарне "буде звільнено", чекбокси
на кожну категорію, прогрес при очищенні. iOS-бекапи surfac'аться лише як
інформація — не чіпаємо автоматично через персональність даних.

### [x] Docker cleanup
- [x] Автопошук docker CLI у `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`
      з fallback на `which` (ловить Colima/Rancher).
- [x] `docker system df --format '{{json .}}'` → розклад Images / Containers
      / Volumes / Build Cache з total, active, size, reclaimable.
- [x] Чистка: `docker system prune -af --volumes` + `docker builder prune -af`.
      Парсимо "Total reclaimed space: 4.2GB" для точного результату.
- [x] UI з прогрес-баром reclaimable/size на кожну категорію.
- [x] Юніт-тести парсингу розмірів і reclaim-рядка.

### [x] Proactive alerts
Dashboard poller у фоні (з page-visibility паузою) фіксує:
- CPU ≥90% → "CPU навантажено"
- RAM pressure ≥90% → "RAM на межі"
- Free disk <10% → "Диск майже повний"
- Battery <20% і не на живленні → "Батарея розряджається"

Кожен alert має hysteresis-latch (recovery threshold ~72%/15%/30%) щоб не
спамити, і йде через macOS notification centre. Користувач бачить їх навіть
коли Stash popup закритий.

### [x] Cmd+F пошук у навігації
В лівому рейлі додано `<input type="search">`. ⌘F з будь-якого місця
панелі фокусує його. Escape очищає. Фільтрує NAV-тайли за label+hint; якщо
нічого не знайдено — показує "Нічого не знайдено".

### [x] Resolution / scaling для дисплеїв
`CGDisplayCopyAllDisplayModes` + `CGDisplaySetDisplayMode` — повний список
режимів з розмірами, HiDPI-прапором, refresh rate. Dedup-ається для однакових
(w×h)→(pw×ph). Застосовується у `kCGConfigureForSession` (reboot скидає).
UI: `<select>` на кожну картку дисплея.

## Ще у списку (Tier 3, не стартовано)

- [ ] **Bandwidth per process** — потребує live-парсингу `nettop -P -L 2`,
      розмаху двох снапшотів для delta. Відкладено — складний parsing для
      marginal value.
- [ ] **Menubar widget** — динамічний CPU/RAM/↓↑ в menubar label. Потребує
      розширення власної tray-логіки Stash.
- [ ] **24h historical trends** — окрема SQLite-таблиця, періодичний insert,
      графіки у новій `TrendsPanel`. Значний effort, добре для окремої ітерації.
- [ ] **Malware scan** — ми свідомо НЕ робимо самостійно (потрібна база
      сигнатур, серйозний IR-ризик). Залишаємо ClamAV як кандидат, але
      не в MVP.
- [ ] **Battery health графік циклів у часі** — потребує власну історію.
- [ ] **Audio/video optimizer** (sips/ffmpeg) — окрема кроссекція, не
      про системну гігієну.
- [ ] **Window manager** (Rectangle-lite) — окремий модуль, не System.

---

## Тестування

Rust:
- `cargo test --lib modules::system` — **42 тести**: processes (6),
  displays (2), caches (2), launch_agents (2), uninstaller (4),
  large_files (5), dashboard (3), trash_bins (2), node_modules (2),
  disk_hogs (2), duplicates (1), battery (1), network (1),
  privacy (2), cancel (2), docker (3), trash (1). Все зелене.

Frontend:
- `vitest run src/modules/system` — **22 тести**: api, cancel, format,
  usePausedInterval, ProcessesPanel (з віртуалізацією), panels smoke
  (Caches/LaunchAgents/Uninstaller), new panels (Dashboard/TrashBins/
  NodeModules). Все зелене.

TypeScript:
- `tsc --noEmit` — clean.

---

## Ризики / обмеження

- **TCC / Full Disk Access**: скани `~/Library` частково впиратимуться у
  EPERM без FDA. Ми мовчки пропускаємо такі шляхи, щоб не зривати весь
  скан.
- **AppleScript залежить від Finder**: усі `move_to_trash` / `empty_all`
  викликають Finder через osascript. Якщо користувач видалив / відключив
  Finder — функція покаже помилку.
- **`purge` потребує sudo**: Stash sudo не запитує — лишаємо пораду в toast.
- **`launchctl` system-scope** потребує sudo, повертаємо stderr з
  повідомленням «permission denied».
- **`top`-парсер** залежить від формату macOS. Ми тестуємо типовий output;
  зміни у нових macOS можуть потребувати корекції парсера (покрито
  unit-тестом).
- **Folder picker** обгортається через `set_popup_auto_hide` — якщо забути
  цю пару виклик → popup зникне на фокус модалки.
