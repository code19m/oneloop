//! Accounts, sessions, passwords and login throttling.

mod http;
mod service;

use oneloop::{
    Db,
    auth::{NewUser, create_user, password::PasswordPolicy},
};

/// The password of the accounts these tests create.
const PASSWORD: &str = "correct horse battery staple";

/// Creates an account whose display name is its username, with `PASSWORD`
/// and a full-cost hash; returns its ID. A temporary password was set long
/// ago, at 1_700_000_000.
async fn add_user(db: &Db, username: &str, admin: bool, temporary: bool) -> String {
    let username = username.to_owned();
    db.transaction(move |tx| {
        let user = create_user(
            tx,
            NewUser {
                display_name: username.clone(),
                username,
                password: PASSWORD.into(),
                is_admin: admin,
                must_change_password: temporary,
            },
            1_700_000_000,
            &PasswordPolicy::default(),
        )?;
        Ok(user.id)
    })
    .await
    .unwrap()
}
