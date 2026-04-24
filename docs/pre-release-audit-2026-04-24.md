# Pre-release audit — Stash 0.1.0
**Дата:** 2026-04-24  
**Гілка:** `main`  
**Стан тестів:** 516 Rust + 892 JS/TS — усі пройшли ✅  
**Типи:** TypeScript — без помилок ✅

---

## Методологія

Перевірено:
- повний `git diff HEAD~10...HEAD` (65 файлів, +3051/−582 рядків)
- усі Rust-модулі: команди, репозиторії, криптографія, IPC, процеси, файлова система
- конфігурація Tauri (CSP, asset protocol scope, window flags)
- React-компоненти: потенційні XSS-вектори, прямі `invoke` поза `api.ts`
- Landing page

---

## 🔴 Критично — заблокувати реліз

### C-1 · `assetProtocol` scope охоплює весь `$HOME/**`
**Файл:** `src-tauri/tauri.conf.json:35`

```json
"scope": ["$APPDATA/**", "$APPLOCALDATA/**", "$HOME/**", ...]
```

**Проблема.** Tauri's asset protocol дозволяє webview-коду читати файли через `asset://`. Scope `$HOME/**` означає, що будь-який код усередині popup — embedded ChatGPT, Claude, Gemini, або XSS в їхніх сторінках — може запросити `asset:///Users/user/.ssh/id_rsa`, `asset:///Users/user/.aws/credentials`, будь-який файл у `~/Documents/`. Embedded webview ізольований від Tauri IPC-команд, але не від asset-протоколу якщо scope дозволений.

**Виправлення.** Звузити scope до реально потрібних директорій:

```json
"scope": [
  "$APPDATA/**",
  "$APPLOCALDATA/**",
  "$HOME/Movies/Stash/**",
  "$HOME/Movies/Stash/.thumbs/**",
  "/private/tmp/**",
  "/tmp/**",
  "/var/folders/**"
]
```

Якщо якийсь модуль дійсно читає файли з довільних місць `$HOME` — конкретизувати їх окремими записами.

---

### C-2 · PBKDF2 з 1 000 ітерацій для шифрування секретів
**Файл:** `src-tauri/src/modules/telegram/file_secrets.rs:141`

```rust
pbkdf2::<Hmac<Sha1>>(host.as_bytes(), b"stash-telegram", 1000, &mut key)
```

**Проблема.** `FileSecretStore` — fallback-сховище, що вмикається на unsigned dev-білдах. Файл `.secrets.bin` потрапляє в Time Machine. 1 000 ітерацій PBKDF2-SHA1 — стандарт 2000 року; сучасний GPU перебирає мільярди хешів/с, тобто словник паролів або brute-force за hostname (короткий рядок) тривіальний.  
OWASP рекомендує: PBKDF2-HMAC-SHA256 з ≥ 600 000 ітерацій, або Argon2id.

**Виправлення.** Підняти до ≥ 260 000 ітерацій (PBKDF2-HMAC-SHA256) або замінити на `argon2` crate. Додати примітку що файл — dev-only і в signed prodбілді ключ зберігається в Keychain.

---

## 🟡 Середній пріоритет — виправити до або одразу після релізу

### M-1 · Path traversal через symlink у Notes
**Файл:** `src-tauri/src/modules/notes/commands.rs:123, 134, 264, 458, 479`

```rust
let path = Path::new(&p);
if path.starts_with(&base) {
    let _ = std::fs::remove_file(path);
}
```

**Проблема.** `starts_with` на `Path` перевіряє компоненти рядка до resolve симлінків. Якщо зловмисна нотатка містить посилання на файл, що є симлінком за межами `base`, перевірка пройде. У `move_to_trash` проблема виправлена через `canonicalize()`. У Notes — ні.

**Виправлення.** Перед `starts_with` викликати `path.canonicalize().unwrap_or(path.to_path_buf())`:

```rust
let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
if canon.starts_with(&base) { ... }
```

---

### M-2 · IPC socket без автентифікації клієнта
**Файл:** `src-tauri/src/modules/ipc/server.rs`

**Проблема.** Unix socket `ipc.sock` захищений `chmod 0600` (тільки owner). Але будь-який процес того самого UID (браузерне розширення, скрипт, інший застосунок) може підключитися і виконати будь-яку зареєстровану команду: читати clipboard, inbox, pomodoro, надсилати Telegram-повідомлення, запускати slash-команди. Немає challenge-response і немає перевірки PID через `SO_PEERCRED`.

**Виправлення (мінімум):** перевіряти `SO_PEERCRED` при accept і порівнювати `pid` з батьківським процесом або вести allowlist дозволених PID. Або — додати HMAC-підписаний nonce у протокол.

---

### M-3 · `kill_process` не верифікує uid власника процесу
**Файл:** `src-tauri/src/modules/system/processes.rs:92`

```rust
pub fn kill_process(pid: i32, force: bool) -> Result<(), String> {
    if pid <= 1 {
        return Err("refusing to kill pid <= 1".into());
    }
    let rc = unsafe { libc::kill(pid, sig) };
```

**Проблема.** Будь-який PID > 1 передається в `libc::kill`. macOS відхилить спробу вбити чужий процес через EPERM — але системні процеси поточного користувача (loginwindow, security-агент, StatusBar) вразливі до SIGKILL через UI якщо хтось знайде спосіб натиснути «Force Kill» на них у Process Manager. Захист через ОС є, але explicit перевірка краще.

**Виправлення.** У `list_processes` вже є поле `user` — перед kill перевіряти, що процес належить `whoami`.

---

### M-4 · Hardcoded версія у фронтенді — розсинхронізується при релізі
**Файл:** `src/settings/AboutTab.tsx:10`

```ts
const APP_VERSION = '0.1.0';
```

**Проблема.** Версія продубльована вручну у чотирьох місцях: `Cargo.toml`, `tauri.conf.json`, `package.json`, `AboutTab.tsx`. При наступному релізі один з них забудуть оновити.

**Виправлення.** Використати Tauri API:

```ts
import { getVersion } from '@tauri-apps/api/app';
const [version, setVersion] = useState('…');
useEffect(() => { getVersion().then(setVersion); }, []);
```

---

### M-5 · `eprintln!` у продакшн-коді (3 місця)
**Файли:**
- `src-tauri/src/modules/downloader/arc_cookies.rs:154`
- `src-tauri/src/modules/downloader/runner.rs:327`
- `src-tauri/src/modules/downloader/commands.rs:463`

```rust
eprintln!("[arc_cookies] exported {exported}/{total} cookies");
eprintln!("[yt-dlp:{job_id}] no-cookies retry failed: {e}");
eprintln!("[downloader] arc cookies export failed: {e}");
```

**Проблема.** `eprintln!` не враховує `tracing` filter (рівень логування) і завжди пише в stderr. У prod-білді stderr потрапляє в Console.app і будь-який логгер. Особливо чутливо для `arc_cookies` — якщо хтось читає системний лог, побачить кількість перенесених cookies.

**Виправлення.** Замінити на `tracing::debug!(...)`.

---

### M-6 · Translator не валідує мовні коди `from`/`to`
**Файл:** `src-tauri/src/modules/translator/engine.rs:12–22`

```rust
let url = format!(
    "https://translate.googleapis.com/translate_a/single\
     ?client=gtx&sl={from}&tl={to}&dt=t&q={}",
    url_encode(text)
);
```

`url_encode` застосовується до `text`, але `from` і `to` підставляються прямо у URL без encode. Якщо фронтенд передасть `from = "auto&dt=rm"` — змінить параметри запиту. Це Server-Side Request параметр-ін'єкція, навіть якщо тільки до Google API.

**Виправлення.** `from` і `to` дозволити лише BCP 47 шаблон `[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*` або `"auto"`. Відхиляти все інше:

```rust
fn is_valid_lang(s: &str) -> bool {
    s == "auto" || s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && s.len() <= 16
}
```

---

## 🟢 Низький пріоритет — технічний борг

### L-1 · `rand::thread_rng()` для pairing code — не явно CSPRNG
**Файл:** `src-tauri/src/modules/telegram/pairing.rs:34`

`thread_rng()` на macOS сідується з `/dev/urandom` — безпечно на практиці. Але явний `rand::rngs::OsRng` виразніше документує намір. 6-значний код + блокування після 5 спроб + TTL 5 хв — захист достатній.

**Виправлення (cosmetic):** замінити `rand::thread_rng()` на `OsRng` у `telegram/commands.rs:136`.

---

### L-2 · Panic при відсутній іконці трею
**Файл:** `src-tauri/src/tray.rs:161`

```rust
.unwrap_or_else(|| app.default_window_icon().unwrap().clone())
```

Якщо білд-час іконка не вбудована (наприклад, CI-тест без ресурсів) — паніка при старті.

**Виправлення:** `default_window_icon().expect("tray icon missing from bundle")` — принаймні зрозуміле повідомлення.

---

### L-3 · Версія у landing page не синхронізована
**Файл:** `landing/index.html`

Landing — окремий статичний файл поза build pipeline Tauri. Версія там або відсутня або буде застарілою. Додати до release checklist.

---

### L-4 · Arc cookies PBKDF2 — стороннє сховище, але варто задокументувати
**Файл:** `src-tauri/src/modules/downloader/arc_cookies.rs:38`

```rust
pbkdf2::<Hmac<Sha1>>(password.as_bytes(), b"saltysalt", 1003, &mut key)
```

Параметри відповідають Chrome/Arc стандарту — цей код нічого не може змінити, він читає чуже сховище. Додати коментар що це «Chromium standard, not our choice».

---

## Речі, які перевірено і є в порядку ✅

| Область | Статус |
|---------|--------|
| SQL ін'єкції | Всі запити використовують `params![]` — чисто |
| XSS у React | `dangerouslySetInnerHTML` не використовується ніде |
| Command injection у yt-dlp | URL передається через `.arg(url)`, не через shell string |
| Command injection у translator | `url_encode` для тексту є, проблема лише з lang-кодами (M-6) |
| Path traversal у `move_to_trash` | `canonicalize()` + whitelist — захист є |
| Telegram allowlist (chat_id) | Інші чати silently drop — правильно |
| Pairing brute-force | MAX_BAD_ATTEMPTS=5 + TTL — захист є |
| Webchat URL injection | `parse_http_url` відхиляє `file://`, `data:`, `javascript:` |
| Webchat SERVICE_ID injection | `label_for` валідує `[a-zA-Z0-9_-]+` — безпечно |
| Secrets у logs | Токени не логуються, лише довжина |
| Notes file scope | `starts_with(base)` є на всіх шляхах (але без canonicalize — M-1) |
| Process kill PID=0,1 | Заблоковано |
| Trash system paths | FORBIDDEN_EXACT + whitelist — захист є |
| CSP webview | `script-src 'self'` — без inline scripts |
| CSRF | N/A — немає web-facing API |
| Session | Telegram pairing через code + TTL |
| Keyring production | macOS Keychain, перевірка round-trip |

---

## Release checklist

- [x] **C-1**: Звузити `assetProtocol.scope` — прибрати `$HOME/**`
- [x] **C-2**: PBKDF2-HMAC-SHA256 з 260 000 ітерацій у `file_secrets.rs`
- [x] **M-1**: `canonicalize()` перед `starts_with` у notes/commands.rs (5 місць)
- [x] **M-3**: Перевірка uid власника процесу в `kill_process`
- [x] **M-4**: Версія в AboutTab через `getVersion()` з Tauri API
- [x] **M-5**: `eprintln!` → `tracing::debug!` (6 місць у downloader)
- [x] **M-6**: Валідація lang-кодів у translator/engine.rs
- [x] **L-1**: `rand::thread_rng()` → `OsRng` у telegram/commands.rs
- [x] **L-2**: Зрозуміле повідомлення про паніку при відсутній іконці трею
- [x] **L-4**: Коментар «Chromium standard KDF» у arc_cookies.rs
- [ ] **M-2**: IPC socket — додати SO_PEERCRED або HMAC-nonce автентифікацію клієнта
- [ ] Landing: оновити версію в `landing/index.html` при кожному релізі
- [ ] Cargo audit: `cargo audit` перед фінальним білдом
- [ ] Підпис: підписати `.app` бандл і нотаризувати в Apple

---

*Документ сформовано на основі статичного аналізу коду та перегляду всіх змінених файлів у гілці `main` станом на 2026-04-24.*
