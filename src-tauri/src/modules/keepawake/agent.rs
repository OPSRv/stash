//! Agent surface — Keep-awake: `/keepawake`. Shared helpers live in
//! `crate::modules::telegram::agent_util`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::modules::telegram::agent_util::now_ms;
use crate::modules::telegram::commands_registry::{
    CommandHandler, Ctx, InlineButton, InlineKeyboard, Reply,
};
use crate::modules::telegram::state::TelegramState;

// -------------------- /keepawake --------------------

pub struct KeepAwakeCmd;

#[async_trait]
impl CommandHandler for KeepAwakeCmd {
    fn name(&self) -> &'static str {
        "keepawake"
    }
    fn description(&self) -> &'static str {
        "Не давати Mac засинати. on вмикає caffeinate + щогодинне нагадування, off вимикає."
    }
    fn usage(&self) -> &'static str {
        "/keepawake on|off|status"
    }
    async fn handle(&self, ctx: Ctx, args: &str) -> Reply {
        use tauri::Manager;
        let action = args.trim().to_ascii_lowercase();
        let state = match ctx
            .app
            .try_state::<std::sync::Arc<crate::modules::keepawake::KeepAwakeState>>()
        {
            Some(s) => s,
            None => {
                return Reply::text("⚠️ keepawake state not initialised (app setup issue)");
            }
        };

        let want = match action.as_str() {
            "" | "status" => None,
            "on" | "1" | "true" | "enable" | "увімкни" | "увімкнути" => Some(true),
            "off" | "0" | "false" | "disable" | "вимкни" | "вимкнути" => Some(false),
            other => {
                return Reply::text(format!(
                    "❓ Невідомо: `{other}`. Використання: {}",
                    self.usage()
                ));
            }
        };

        let status_now = match want {
            Some(target) => match crate::modules::keepawake::commands::set(&ctx.app, state.inner(), target) {
                Ok(s) => s,
                Err(e) => return Reply::text(format!("⚠️ keepawake: {e}")),
            },
            None => crate::modules::keepawake::commands::status(state.inner()),
        };

        if status_now.active {
            let elapsed = status_now
                .since_unix
                .map(|s| (now_ms() / 1000 - s).max(0))
                .unwrap_or(0);
            let h = elapsed / 3600;
            let m = (elapsed % 3600) / 60;
            keepawake_card(
                format!(
                    "☕ Mac не засинає (≈{h} год {m:02} хв). \
                     Нагадування — щогодини. Вимкнути: /keepawake off"
                ),
                true,
            )
        } else {
            keepawake_card(
                "💤 Mac засинає як зазвичай. Увімкнути keep-awake: /keepawake on".into(),
                false,
            )
        }
    }
}

fn keepawake_card(text: String, active: bool) -> Reply {
    let toggle = if active {
        InlineButton::new("💤 Вимкнути", "refresh:keepawake:off")
    } else {
        InlineButton::new("☕ Увімкнути", "refresh:keepawake:on")
    };
    Reply {
        text,
        keyboard: Some(InlineKeyboard {
            rows: vec![vec![toggle, InlineButton::new("🔄", "refresh:keepawake:status")]],
        }),
        ..Default::default()
    }
}

/// Register this module's slash commands.
pub fn register_commands(tg: &Arc<TelegramState>, _app: &tauri::AppHandle) {
    tg.register_command(KeepAwakeCmd);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keepawake_card_toggle_is_refresh() {
        let ka = keepawake_card("x".into(), true).keyboard.unwrap();
        assert_eq!(ka.rows[0][0].callback_data, "refresh:keepawake:off");
    }
}
