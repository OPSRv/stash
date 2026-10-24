//! `/menu` — main navigation card: a grid of module buttons, plus the
//! shared "☰ Меню" / "🔄" helpers other cards append to their keyboards.
//!
//! Buttons for live cards (dashboard, reminders, notes, …) use the
//! `refresh:` prefix so the menu morphs into the module card in place, and
//! that card's "☰ Меню" button (`refresh:menu`) morphs it back. Commands
//! whose replies are not edit-friendly (screenshot sends a document, music
//! etc. are owned elsewhere) dispatch plainly so the menu stays put.

use std::sync::Arc;

use async_trait::async_trait;

use super::commands_registry::{CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply};
use super::state::TelegramState;

/// `(label, command, edit_in_place)` for every menu tile, in grid order.
const MENU_ITEMS: &[(&str, &str, bool)] = &[
    ("🎵 Музика", "music", false),
    ("🔊 Гучність", "volume", false),
    ("🥁 Метроном", "metronome", false),
    ("🍅 Помодоро", "pomodoro", false),
    ("⏰ Нагадування", "reminders", true),
    ("📝 Нотатки", "notes", true),
    ("📋 Буфер", "clip", true),
    ("📊 Дашборд", "dashboard", true),
    ("🔋 Батарея", "battery", true),
    ("📸 Скрін", "screenshot", false),
    ("🌦 Погода", "weather", true),
    ("⬇️ Завантаження", "dl", false),
    ("🌐 Переклад", "tr", false),
];

const MENU_COLUMNS: usize = 3;

/// "☰ Меню" button that swaps the current card back to the menu.
pub fn menu_button() -> InlineButton {
    InlineButton::new("☰ Меню", "refresh:menu")
}

/// Standard footer for live cards: refresh self + back to menu.
pub fn nav_row(refresh_cb: &str) -> Vec<InlineButton> {
    vec![InlineButton::new("🔄 Оновити", refresh_cb), menu_button()]
}

/// Keyboard consisting of just [`nav_row`].
pub fn nav_keyboard(refresh_cb: &str) -> InlineKeyboard {
    InlineKeyboard {
        rows: vec![nav_row(refresh_cb)],
    }
}

/// Build the menu grid, keeping only tiles whose command is registered
/// (`dl` / `tr` come from other modules and may be absent).
pub fn build_menu_keyboard(is_registered: impl Fn(&str) -> bool) -> InlineKeyboard {
    let tiles: Vec<InlineButton> = MENU_ITEMS
        .iter()
        .filter(|(_, cmd, _)| is_registered(cmd))
        .map(|(label, cmd, live)| {
            let cb = if *live {
                format!("refresh:{cmd}")
            } else {
                (*cmd).to_string()
            };
            InlineButton::new(*label, cb)
        })
        .collect();
    let mut rows: Vec<Vec<InlineButton>> =
        tiles.chunks(MENU_COLUMNS).map(|c| c.to_vec()).collect();
    if is_registered("help") {
        rows.push(vec![InlineButton::new("❓ Довідка", "help")]);
    }
    InlineKeyboard { rows }
}

pub struct MenuCmd {
    state: Arc<TelegramState>,
}

impl MenuCmd {
    pub fn new(state: Arc<TelegramState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl CommandHandler for MenuCmd {
    fn name(&self) -> &'static str {
        "menu"
    }
    fn description(&self) -> &'static str {
        "Головне меню: усі модулі однією сіткою кнопок"
    }
    fn usage(&self) -> &'static str {
        "/menu"
    }
    async fn handle(&self, _ctx: Ctx, _args: &str) -> Reply {
        let keyboard = build_menu_keyboard(|cmd| self.state.find_command(cmd).is_some());
        Reply {
            text: "☰ Stash — головне меню\nОбери модуль 👇".to_string(),
            keyboard: Some(keyboard),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_hides_unregistered_commands() {
        let kb = build_menu_keyboard(|c| c != "dl" && c != "tr");
        let cbs: Vec<&str> = kb
            .rows
            .iter()
            .flatten()
            .map(|b| b.callback_data.as_str())
            .collect();
        assert!(!cbs.contains(&"dl"));
        assert!(!cbs.contains(&"tr"));
        assert!(cbs.contains(&"music"));
        assert!(cbs.contains(&"refresh:reminders"));
        assert!(cbs.contains(&"help"));
    }

    #[test]
    fn menu_grid_has_at_most_three_columns() {
        let kb = build_menu_keyboard(|_| true);
        assert!(kb.rows.iter().all(|r| r.len() <= MENU_COLUMNS));
        // 13 tiles + help row.
        let total: usize = kb.rows.iter().map(|r| r.len()).sum();
        assert_eq!(total, MENU_ITEMS.len() + 1);
    }

    #[test]
    fn menu_callbacks_fit_telegram_limit() {
        let kb = build_menu_keyboard(|_| true);
        for b in kb.rows.iter().flatten().chain(nav_row("refresh:battery").iter()) {
            assert!(b.callback_data.len() <= 64, "{}", b.callback_data);
        }
    }

    #[test]
    fn empty_registry_yields_empty_menu() {
        assert!(build_menu_keyboard(|_| false).rows.is_empty());
    }
}
