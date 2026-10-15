use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

use super::*;
use crate::{
    Config, Db,
    auth::{LoginResult, NewUser, create_user, password::PasswordPolicy},
};

const CALLBACK: &str = "http://127.0.0.1/callback";
const RESOURCE: &str = "https://tasks.example.test/mcp";

#[tokio::test]
async fn consent_from_a_session_revoked_after_sign_in_creates_no_code() {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    let config = Config::from_os_iter([
        ("ONELOOP_PUBLIC_URL", "https://tasks.example.test"),
        ("ONELOOP_DATA_DIR", root.path().to_str().unwrap()),
    ])
    .unwrap();
    let state = AppState::new(config, db.clone());
    let user = NewUser {
        username: "owner".into(),
        display_name: "Owner".into(),
        password: "test-only-password-012345".into(),
        is_admin: true,
        must_change_password: false,
    };
    db.transaction(move |tx| create_user(tx, user, unix_now()?, &PasswordPolicy::default()))
        .await
        .unwrap();
    let LoginResult::Authenticated(session) = state
        .auth
        .login(
            "owner",
            "test-only-password-012345",
            Default::default(),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("the owner signs in");
    };
    let actor = session.actor;
    let request_id = "consent-request";
    let (hash, user_id, now) = (
        hash_token(request_id),
        actor.user_id.clone(),
        unix_now().unwrap(),
    );
    db.run(move |c| {
        c.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p1','One','ONE',1,1)", [])?;
        c.execute(
            "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at) VALUES('client','Client',?1,1)",
            [serde_json::json!([CALLBACK]).to_string()],
        )?;
        c.execute(
            "INSERT INTO oauth_authorization_requests(id,user_id,client_id,redirect_uri,resource,requested_scopes_json,code_challenge,created_at,expires_at)
             VALUES(?1,?2,'client',?3,?4,'[\"project_read\"]','challenge',?5,?6)",
            params![hash, user_id, CALLBACK, RESOURCE, now, now + 600],
        )?;
        // A plain revocation, such as from another tab, commits after the
        // consent request was authenticated.
        c.execute("UPDATE sessions SET revoked_at=?1", [now])?;
        Ok(())
    })
    .await
    .unwrap();
    let form = ConsentForm {
        request_id: request_id.into(),
        decision: "allow".into(),
        project: vec!["p1".into()],
        scope: Vec::new(),
    };
    let stored = StoredAuthorizationRequest {
        user_id: actor.user_id.clone(),
        client_id: "client".into(),
        client_name: "Client".into(),
        redirect_uri: CALLBACK.into(),
        state: None,
        resource: RESOURCE.into(),
        requested_scopes: vec!["project_read".into()],
        challenge: "challenge".into(),
    };
    let result = approve_consent(&state, &actor, &form, &stored).await;
    assert!(matches!(result, Err(AppError::Unauthorized)), "{result:?}");
    let codes: i64 = db
        .run(|c| {
            Ok(
                c.query_row("SELECT count(*) FROM oauth_authorization_codes", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .await
        .unwrap();
    assert_eq!(codes, 0);
}

const LOCAL_CALLBACK: &str = "http://127.0.0.1:49152/callback";

/// A server with client metadata documents turned on, and an admin who
/// is signed in and sees one project.
struct Described {
    _root: tempfile::TempDir,
    db: Db,
    state: AppState,
    app: axum::Router,
    cookie: String,
    user_id: String,
}

async fn described() -> Described {
    let root = tempfile::tempdir_in("target").unwrap();
    crate::db::migrate(root.path(), None).unwrap();
    let db = Db::open(root.path()).unwrap();
    let config = Config::from_os_iter([
        ("ONELOOP_PUBLIC_URL", "http://127.0.0.1:8080"),
        ("ONELOOP_DATA_DIR", root.path().to_str().unwrap()),
        ("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS", "true"),
    ])
    .unwrap();
    let state = AppState::new(config, db.clone());
    let user = NewUser {
        username: "owner".into(),
        display_name: "Owner".into(),
        password: "test-only-password-012345".into(),
        is_admin: true,
        must_change_password: false,
    };
    db.transaction(move |tx| {
        create_user(tx, user, unix_now()?, &PasswordPolicy::default())?;
        tx.execute("INSERT INTO projects(id,name,task_prefix,created_at,updated_at) VALUES('p1','One','ONE',1,1)", [])?;
        Ok(())
    })
    .await
    .unwrap();
    let LoginResult::Authenticated(session) = state
        .auth
        .login(
            "owner",
            "test-only-password-012345",
            Default::default(),
            None,
        )
        .await
        .unwrap()
    else {
        panic!("the owner signs in");
    };
    Described {
        _root: root,
        db,
        app: crate::application(state.clone()).router,
        state,
        cookie: format!("oneloop_session={}", session.token),
        user_id: session.actor.user_id,
    }
}

fn authorize_request(
    cookie: &str,
    client: &str,
    redirect: &str,
    challenge: &str,
) -> axum::http::Request<axum::body::Body> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", redirect),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("resource", "http://127.0.0.1:8080/mcp"),
            ("state", "described"),
        ])
        .finish();
    axum::http::Request::builder()
        .uri(format!("/oauth/authorize?{query}"))
        .header(header::COOKIE, cookie)
        .body(axum::body::Body::empty())
        .unwrap()
}

async fn text(response: Response) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn a_client_described_by_its_document_connects_like_a_registered_one() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const CLIENT: &str = "https://app.example.com/oauth/client.json";
    let Described {
        _root,
        db,
        state,
        app,
        cookie,
        ..
    } = described().await;
    let document = |name: &str| ClientDocument {
        client_id: CLIENT.into(),
        client_name: name.into(),
        redirect_uris: vec![LOCAL_CALLBACK.into()],
        client_uri: None,
    };
    // Stands in for a fetch, which tests can't make to a public address.
    state
        .client_documents
        .insert_for_test(document("Described App"));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/.well-known/oauth-authorization-server")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&text(response).await).unwrap();
    assert_eq!(metadata["client_id_metadata_document_supported"], true);

    let verifier = "verifier-with-forty-three-characters-0123456789ABCDE";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let authorize = |redirect: &str| authorize_request(&cookie, CLIENT, redirect, &challenge);
    let response = app
        .clone()
        .oneshot(authorize("http://127.0.0.1:49152/elsewhere"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = app
        .clone()
        .oneshot(authorize(LOCAL_CALLBACK))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let html = text(response).await;
    assert!(html.contains("Connect <bdi>Described App</bdi>"), "{html}");
    assert!(html.contains(&format!(
        "App name from {CLIENT}. The app runs on your computer"
    )));
    let request_id = html
        .split("name=request_id value=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .to_owned();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/authorize")
                .header(header::ORIGIN, "http://127.0.0.1:8080")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(format!(
                    "request_id={request_id}&decision=allow&project=p1"
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    let location = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
    assert!(location.as_str().starts_with(LOCAL_CALLBACK));
    let code = location
        .query_pairs()
        .find(|(key, _)| key == "code")
        .unwrap()
        .1
        .into_owned();
    let exchange = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT),
            ("code", code.as_str()),
            ("redirect_uri", LOCAL_CALLBACK),
            ("code_verifier", verifier),
            ("resource", "http://127.0.0.1:8080/mcp"),
        ])
        .finish();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/token")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(exchange))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stored = || {
        db.run(|c| {
            Ok(c.query_row(
                "SELECT c.client_name,c.created_at,g.client_name FROM oauth_clients c JOIN mcp_grants g ON g.client_id=c.client_id WHERE c.client_id=?1",
                [CLIENT],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
            )?)
        })
    };
    let (name, created_at, grant_name) = stored().await.unwrap();
    assert_eq!(
        (name.as_str(), grant_name.as_str()),
        ("Described App", "Described App")
    );
    // A changed document updates the client; a used client keeps its age.
    db.run(|c| Ok(c.execute("UPDATE oauth_clients SET created_at=created_at-100", [])?))
        .await
        .unwrap();
    state
        .client_documents
        .insert_for_test(document("Renamed App"));
    let response = app
        .clone()
        .oneshot(authorize(LOCAL_CALLBACK))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (name, renamed_at, _) = stored().await.unwrap();
    assert_eq!(
        (name.as_str(), renamed_at),
        ("Renamed App", created_at - 100)
    );
}

#[tokio::test]
async fn a_person_who_used_up_their_fetches_is_told_when_to_try_again() {
    use tower::ServiceExt;
    let described = described().await;
    let ask = |index: u32| {
        authorize_request(
            &described.cookie,
            &format!("https://localhost/client-{index}.json"),
            LOCAL_CALLBACK,
            "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        )
    };
    // A refused fetch counts too: these names resolve to this computer.
    for index in 0..client_metadata::FETCHES_PER_PERSON_MINUTE {
        let response = described.app.clone().oneshot(ask(index)).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let response = described.app.clone().oneshot(ask(99)).await.unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let wait: u64 = response.headers()[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=60).contains(&wait), "{wait}");
}

#[tokio::test]
async fn only_the_newest_unused_described_clients_are_kept() {
    let Described { _root, db, .. } = described().await;
    db.transaction(|tx| {
        // Registered apps and described apps in use are never removed.
        tx.execute(
            "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at)
             VALUES('olc_registered','Registered','[]',1)",
            [],
        )?;
        tx.execute(
            "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at,last_used_at)
             VALUES('https://used.example/client.json','Used','[]',1,1)",
            [],
        )?;
        for index in 0..MAX_UNUSED_DESCRIBED_CLIENTS + 5 {
            let document = ClientDocument {
                client_id: format!("https://app{index}.example/client.json"),
                client_name: "App".into(),
                redirect_uris: vec![LOCAL_CALLBACK.into()],
                client_uri: None,
            };
            remember_described_client(tx, &document, 1_000 + index)?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let counts = db
        .run(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*),MIN(created_at),
                    (SELECT COUNT(*) FROM oauth_clients WHERE client_id IN ('olc_registered','https://used.example/client.json'))
                 FROM oauth_clients WHERE client_id LIKE 'https://%' AND last_used_at IS NULL",
                [],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(counts, (MAX_UNUSED_DESCRIBED_CLIENTS, 1_005, 2));
}

#[tokio::test]
async fn the_cap_keeps_described_clients_with_a_sign_in_under_way() {
    let Described {
        _root, db, user_id, ..
    } = described().await;
    let now = 10_000_i64;
    db.transaction(move |tx| {
        // The oldest clients: two with a sign-in under way, one whose
        // request expired.
        for (client, name) in [
            ("https://requested.example/client.json", "Pending"),
            ("https://consented.example/client.json", "Pending"),
            ("https://expired.example/client.json", "Expired"),
        ] {
            tx.execute(
                "INSERT INTO oauth_clients(client_id,client_name,redirect_uris_json,created_at)
                 VALUES(?1,?2,'[]',1)",
                params![client, name],
            )?;
        }
        for (id, client, expires_at) in [
            ("open", "https://requested.example/client.json", now + 600),
            ("stale", "https://expired.example/client.json", now - 1),
        ] {
            tx.execute(
                "INSERT INTO oauth_authorization_requests(id,user_id,client_id,redirect_uri,resource,requested_scopes_json,code_challenge,created_at,expires_at)
                 VALUES(?1,?2,?3,?4,?5,'[\"project_read\"]','challenge',?6,?7)",
                params![id, user_id, client, LOCAL_CALLBACK, RESOURCE, now - 1, expires_at],
            )?;
        }
        tx.execute(
            "INSERT INTO oauth_authorization_codes(code_hash,user_id,client_id,client_name,redirect_uri,resource,projects_json,scopes_json,code_challenge,issued_at,expires_at)
             VALUES('code',?1,'https://consented.example/client.json','Pending',?2,?3,'[\"p1\"]','[\"project_read\"]','challenge',?4,?5)",
            params![user_id, LOCAL_CALLBACK, RESOURCE, now - 1, now + 300],
        )?;
        for index in 0..MAX_UNUSED_DESCRIBED_CLIENTS {
            let document = ClientDocument {
                client_id: format!("https://app{index}.example/client.json"),
                client_name: "App".into(),
                redirect_uris: vec![LOCAL_CALLBACK.into()],
                client_uri: None,
            };
            remember_described_client(tx, &document, now)?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let kept = db
        .run(|c| {
            let mut statement = c.prepare(
                "SELECT client_name,COUNT(*) FROM oauth_clients GROUP BY client_name ORDER BY client_name",
            )?;
            let rows = statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let pending: i64 = c.query_row(
                "SELECT (SELECT COUNT(*) FROM oauth_authorization_requests)
                 + (SELECT COUNT(*) FROM oauth_authorization_codes)",
                [],
                |r| r.get(0),
            )?;
            Ok((rows, pending))
        })
        .await
        .unwrap();
    assert_eq!(
        kept,
        (
            vec![
                ("App".to_owned(), MAX_UNUSED_DESCRIBED_CLIENTS),
                ("Pending".to_owned(), 2)
            ],
            2
        ),
        "both sign-ins under way keep their clients, request and code"
    );
}

#[derive(Clone, Default)]
struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}

#[tokio::test]
async fn a_refused_document_is_logged_with_the_person_who_asked() {
    use tower::ServiceExt;
    // With a second subscriber alive, tracing asks this thread's one about
    // each log call; see tests/integration/errors.rs.
    let _second = tracing::Dispatch::new(tracing_subscriber::registry());
    let capture = Capture::default();
    let _default = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(capture.clone())
            .finish(),
    );
    let described = described().await;
    // The name resolves to this computer, so the fetch is refused.
    let response = described
        .app
        .clone()
        .oneshot(authorize_request(
            &described.cookie,
            "https://localhost/oneloop-test-client.json",
            LOCAL_CALLBACK,
            "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("client metadata document refused"), "{log}");
    assert!(
        log.contains(&format!("user_id={}", described.user_id)),
        "{log}"
    );
}
