//! Live-update streams: what one stream sends, and how many streams each
//! person may keep open.

use sha2::{Digest, Sha256};
use tokio::{sync::mpsc, time::MissedTickBehavior};
use tokio_stream::wrappers::ReceiverStream;

use crate::auth::{Actor, refresh_actor_connection};

use super::*;

/// Live-update streams one person may keep open, a small share of the
/// server's connections. A browser tab holds one while it is shown.
const STREAMS_PER_PERSON: usize = 16;
/// Events waiting for a slow client. The last place is kept for `Replaced`.
const QUEUE: usize = 64;
/// How often an open stream checks that its person may still read.
const REVALIDATE: Duration = Duration::from_secs(30);

/// What a live-update stream sends.
pub enum LiveEvent {
    /// The first event. `ready` says that the client's snapshot is current;
    /// otherwise the client reads again.
    Start { ready: bool },
    /// The client must read again: it may have missed something.
    Reconcile,
    /// Something changed that the person may read.
    Hint(Arc<SseHint>),
    /// The person opened too many newer streams, so this one closes.
    Replaced,
}

/// The open live-update streams of each person, oldest first, each with the
/// token that closes it.
#[derive(Default)]
pub(super) struct Streams {
    opened: u64,
    open: HashMap<String, VecDeque<(u64, CancellationToken)>>,
}

/// One person's live-update stream, counted until it is dropped.
struct LiveStream {
    runtime: CollaborationRuntime,
    user_id: String,
    id: u64,
    replaced: CancellationToken,
}

impl Drop for LiveStream {
    fn drop(&mut self) {
        let mut streams = self
            .runtime
            .inner
            .streams
            .lock()
            .expect("live stream registry lock");
        if let Some(open) = streams.open.get_mut(&self.user_id) {
            open.retain(|(id, _)| *id != self.id);
            if open.is_empty() {
                streams.open.remove(&self.user_id);
            }
        }
    }
}

impl CollaborationRuntime {
    /// Opens a live-update stream for `actor`. Its first event says whether
    /// the snapshot the client read at `cursor` is still current. The stream
    /// ends when the person loses access, the client goes away, the server
    /// stops, or the person opens too many newer streams.
    pub async fn live_updates(
        &self,
        actor: &Actor,
        cursor: Option<String>,
    ) -> AppResult<ReceiverStream<LiveEvent>> {
        // Subscribe before checking the snapshot boundary. Later writes are
        // then queued for this stream even if they commit before its first
        // event is sent.
        let updates = self.subscribe();
        let ready = match cursor {
            Some(cursor) => {
                let actor = actor.clone();
                let current = self
                    .inner
                    .db
                    .snapshot(move |connection| {
                        refresh_actor_connection(connection, &actor)?;
                        sync_cursor(connection)
                    })
                    .await?;
                current == cursor
            }
            None => false,
        };
        let stream = self.open_stream(&actor.user_id);
        let (sender, receiver) = mpsc::channel(QUEUE);
        let replaced_place = sender
            .clone()
            .try_reserve_owned()
            .expect("a new queue has room");
        let runtime = self.clone();
        let actor = actor.clone();
        tokio::spawn(async move {
            let mut shutdown = runtime.shutdown_receiver();
            let pump = runtime.pump(&actor, &sender, updates, ready);
            // Dropping a body cancels even an authorization wait or blocked send.
            let replaced = tokio::select! {
                biased;
                _ = sender.closed() => false,
                _ = async {
                    while !*shutdown.borrow_and_update() {
                        if shutdown.changed().await.is_err() { break; }
                    }
                } => false,
                _ = stream.replaced.cancelled() => true,
                _ = pump => false,
            };
            drop(stream);
            if replaced {
                // The tab waits until it is used again before it reconnects,
                // so tabs don't take turns.
                replaced_place.send(LiveEvent::Replaced);
            }
        });
        Ok(ReceiverStream::new(receiver))
    }

    /// Counts a new live-update stream of `user_id`. Beyond
    /// `STREAMS_PER_PERSON`, the person's oldest stream is told to close;
    /// browsers reconnect a stream that closes.
    fn open_stream(&self, user_id: &str) -> LiveStream {
        let replaced = CancellationToken::new();
        let mut streams = self
            .inner
            .streams
            .lock()
            .expect("live stream registry lock");
        streams.opened += 1;
        let id = streams.opened;
        let open = streams.open.entry(user_id.to_owned()).or_default();
        open.push_back((id, replaced.clone()));
        while open.len() > STREAMS_PER_PERSON {
            if let Some((_, oldest)) = open.pop_front() {
                oldest.cancel();
            }
        }
        LiveStream {
            runtime: self.clone(),
            user_id: user_id.to_owned(),
            id,
            replaced,
        }
    }

    /// Sends a stream's events until the person may no longer read or the
    /// client goes away.
    async fn pump(
        &self,
        actor: &Actor,
        sender: &mpsc::Sender<LiveEvent>,
        mut updates: broadcast::Receiver<Arc<SseHint>>,
        ready: bool,
    ) {
        let service = CollaborationService::new(self.inner.db.clone());
        if sender.send(LiveEvent::Start { ready }).await.is_err() {
            return;
        }
        let mut revalidate = tokio::time::interval(REVALIDATE);
        revalidate.set_missed_tick_behavior(MissedTickBehavior::Skip);
        revalidate.tick().await;
        loop {
            let event = tokio::select! {
                _ = revalidate.tick() => {
                    // Revalidation keeps authorization current. A successful
                    // check is quiet: the first event and lag recovery already
                    // reconcile, while a periodic event would make every
                    // healthy browser read everything again every 30 seconds.
                    if !self.still_current(&service, actor).await { return; }
                    continue;
                }
                message = updates.recv() => match message {
                    Ok(hint) => {
                        if sender.is_closed() { return; }
                        if !hint.recipient_ids.contains(&actor.user_id) { continue; }
                        if hint.kind == "access.changed" {
                            if !self.still_current(&service, actor).await { return; }
                            LiveEvent::Reconcile
                        } else {
                            let _permit = self.authorization_permit().await;
                            match service.actor_can_receive(actor, hint.project_id.as_deref()).await {
                                Ok(true) => LiveEvent::Hint(hint),
                                Ok(false) => continue,
                                // Under temporary database pressure, reconnect and
                                // reconcile instead of silently losing this hint.
                                Err(_) => return,
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if !self.still_current(&service, actor).await { return; }
                        LiveEvent::Reconcile
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            };
            if sender.send(event).await.is_err() {
                return;
            }
        }
    }

    /// Whether the person may still receive updates. Checks wait for an
    /// authorization permit; no result is cached between them.
    async fn still_current(&self, service: &CollaborationService, actor: &Actor) -> bool {
        let _permit = self.authorization_permit().await;
        service.actor_is_current(actor).await.unwrap_or(false)
    }
}

/// Where the data the client read stands. Both logs are append-only for
/// changes the bootstrap shows, so compare their last rows, not timestamps:
/// several writes share a second.
pub(crate) fn sync_cursor(connection: &rusqlite::Connection) -> AppResult<String> {
    let last = |table| -> AppResult<Option<String>> {
        Ok(connection
            .query_row(
                &format!("SELECT id FROM {table} ORDER BY rowid DESC LIMIT 1"),
                [],
                |row| row.get(0),
            )
            .optional()?)
    };
    let (outbox, security) = (last("outbox_messages")?, last("security_events")?);
    // Delivery changes Inbox visibility without appending another outbox row.
    let pending: i64 = connection.query_row(
        "SELECT COUNT(*) FROM outbox_messages WHERE delivered_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    let boundary = format!(
        "{}:{}:{pending}",
        outbox.as_deref().unwrap_or("0"),
        security.as_deref().unwrap_or("0")
    );
    Ok(hex::encode(Sha256::digest(boundary.as_bytes())))
}
