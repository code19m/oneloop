//! Bounded HTTP connections. Clients must keep requests and responses moving,
//! while long-lived responses such as live updates stay open.
use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, Request},
    http::{HeaderValue, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use hyper_util::{
    rt::{TokioExecutor, TokioIo, TokioTimer},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpListener,
    sync::watch,
    task::JoinSet,
    time::{Instant, Sleep},
};
use tokio_stream::Stream;

use crate::AppError;

const LIMITS: Limits = Limits {
    connections: 1024,
    // Also ends connections that send no request, from their opening or
    // their previous response.
    header_timeout: Duration::from_secs(15),
    body: Pace {
        longest_wait: Some(Duration::from_secs(60)),
        grace: Duration::from_secs(60),
        bytes_per_second: 1024,
    },
    // Socket buffers between oneloop and a client can hold megabytes, so even
    // a steady reader can keep a single write waiting for minutes.
    response: Pace {
        longest_wait: None,
        grace: Duration::from_secs(60),
        bytes_per_second: 1024,
    },
};

#[derive(Clone, Copy)]
struct Limits {
    connections: usize,
    header_timeout: Duration,
    body: Pace,
    response: Pace,
}

/// How long a client may keep oneloop waiting for the rest of a request body,
/// or for room to send more of a response: `longest_wait` at a time, and in
/// total `grace` plus one second for each `bytes_per_second` it moved. A slow
/// but steady client stays within this; a trickle does not.
#[derive(Clone, Copy)]
struct Pace {
    longest_wait: Option<Duration>,
    grace: Duration,
    bytes_per_second: u64,
}

pub(crate) async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    serve_with_limits(listener, router, shutdown, LIMITS).await
}

async fn serve_with_limits(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
    limits: Limits,
) -> io::Result<()> {
    let mut connections = JoinSet::new();
    let (closing, _) = watch::channel(false);
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            biased;
            () = &mut shutdown => break,
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                if let Err(error) = result { tracing::error!(%error, "HTTP connection task failed"); }
            }
            accepted = listener.accept() => {
                let (mut socket, address) = match accepted {
                    Ok(value) => value,
                    Err(error) => {
                        tracing::warn!(%error, "HTTP accept failed; retrying");
                        tokio::select! {
                            () = &mut shutdown => break,
                            () = tokio::time::sleep(Duration::from_millis(250)) => {},
                        }
                        continue;
                    }
                };
                if connections.len() >= limits.connections {
                    // A fixed, tiny response needs no request parsing or task slot.
                    // Bound even its write so a non-reading peer cannot stop admission.
                    tokio::select! {
                        () = &mut shutdown => break,
                        _ = tokio::time::timeout(Duration::from_secs(1), async {
                            socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n").await?;
                            socket.shutdown().await
                        }) => {},
                    }
                    continue;
                }
                connections.spawn(serve_connection(
                    socket,
                    address,
                    router.clone(),
                    limits,
                    closing.subscribe(),
                ));
            }
        }
    }
    drop(listener);
    let _ = closing.send(true);
    // Bound shutdown only, never an active SSE, MCP or download response.
    if tokio::time::timeout(Duration::from_secs(30), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    Ok(())
}

async fn serve_connection<T>(
    io: T,
    address: SocketAddr,
    router: Router,
    limits: Limits,
    mut shutdown: watch::Receiver<bool>,
) where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let service = TowerToHyperService::new(router.layer(axum::Extension(ConnectInfo(address))));
    // Proxies and browsers reach oneloop over HTTP/1.1. Its header timer runs
    // from the moment a connection opens; cleartext HTTP/2 would let a client
    // hold a connection without a request, or stall a stream without reading.
    let mut builder = Builder::new(TokioExecutor::new()).http1_only();
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(limits.header_timeout);
    let io = TokioIo::new(PacedWrites::new(io, limits.response));
    let connection = builder.serve_connection(io, service);
    tokio::pin!(connection);
    tokio::select! {
        result = &mut connection => {
            if result.is_err() {
                tracing::debug!("HTTP connection closed with a transport error");
            }
        }
        _ = shutdown.changed() => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}

/// Time a client kept oneloop waiting, against the bytes it moved.
struct PaceMeter {
    limit: Pace,
    waiting_since: Option<Instant>,
    waited: Duration,
    moved: u64,
}

impl PaceMeter {
    fn new(limit: Pace) -> Self {
        Self {
            limit,
            waiting_since: None,
            waited: Duration::ZERO,
            moved: 0,
        }
    }

    /// The client moved `bytes`; any wait for it is over.
    fn moved(&mut self, bytes: usize) {
        if let Some(since) = self.waiting_since.take() {
            self.waited += since.elapsed();
        }
        self.moved = self.moved.saturating_add(bytes as u64);
    }

    /// Starts or continues a wait for the client; returns when it must end.
    fn deadline(&mut self) -> Instant {
        let since = *self.waiting_since.get_or_insert_with(Instant::now);
        let budget =
            self.limit.grace + Duration::from_secs(self.moved / self.limit.bytes_per_second.max(1));
        let deadline = since + budget.saturating_sub(self.waited);
        match self.limit.longest_wait {
            Some(longest) => deadline.min(since + longest),
            None => deadline,
        }
    }
}

/// Fails a write that waits longer than the response pace allows, so a client
/// that stops reading, or reads only a trickle, frees its connection.
struct PacedWrites<T> {
    io: T,
    meter: PaceMeter,
    timer: Pin<Box<Sleep>>,
}

impl<T> PacedWrites<T> {
    fn new(io: T, limit: Pace) -> Self {
        Self {
            io,
            meter: PaceMeter::new(limit),
            timer: Box::pin(tokio::time::sleep(Duration::ZERO)),
        }
    }

    fn written(
        &mut self,
        cx: &mut Context<'_>,
        result: Poll<io::Result<usize>>,
    ) -> Poll<io::Result<usize>> {
        match result {
            Poll::Ready(Ok(bytes)) => {
                self.meter.moved(bytes);
                Poll::Ready(Ok(bytes))
            }
            Poll::Pending => {
                self.timer.as_mut().reset(self.meter.deadline());
                if self.timer.as_mut().poll(cx).is_pending() {
                    return Poll::Pending;
                }
                Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the client stopped reading the response",
                )))
            }
            result => result,
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for PacedWrites<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for PacedWrites<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.io).poll_write(cx, buf);
        self.written(cx, result)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.io).poll_write_vectored(cx, bufs);
        self.written(cx, result)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// Ends a request whose body keeps oneloop waiting longer than the body pace
/// allows. The application adds this inside its error handling, so the 408
/// looks like other errors.
pub(crate) async fn pace_request_body(request: Request, next: Next) -> Response {
    read_body_at_pace(request, next, LIMITS.body).await
}

async fn read_body_at_pace(request: Request, next: Next, limit: Pace) -> Response {
    let (parts, body) = request.into_parts();
    let expired = Arc::new(AtomicBool::new(false));
    // Uploads keep their own size and overall limits; this does not bound a
    // handler or a response stream.
    let body = PacedBody {
        stream: body.into_data_stream(),
        meter: PaceMeter::new(limit),
        timer: Box::pin(tokio::time::sleep(Duration::ZERO)),
        expired: expired.clone(),
    };
    let response = next
        .run(Request::from_parts(parts, Body::from_stream(body)))
        .await;
    if expired.load(Ordering::Relaxed) {
        let mut response = AppError::RequestTimeout.into_response();
        // The rest of the body is unread, so the connection can't be reused.
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        response
    } else {
        response
    }
}

struct PacedBody {
    stream: axum::body::BodyDataStream,
    meter: PaceMeter,
    timer: Pin<Box<Sleep>>,
    expired: Arc<AtomicBool>,
}

impl Stream for PacedBody {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        match Pin::new(&mut this.stream).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                this.meter.moved(chunk.len());
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Pending => {
                this.timer.as_mut().reset(this.meter.deadline());
                if this.timer.as_mut().poll(cx).is_pending() {
                    return Poll::Pending;
                }
                this.expired.store(true, Ordering::Relaxed);
                Poll::Ready(Some(Err(axum::Error::new(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the request body stalled",
                )))))
            }
            done => done,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    /// Serves one in-memory connection with the production limits. On Tokio's
    /// paused clock their waits pass instantly, and in order, because no
    /// network sits between the client and the server.
    fn connect(
        router: Router,
        buffer: usize,
    ) -> (
        DuplexStream,
        watch::Sender<bool>,
        tokio::task::JoinHandle<()>,
    ) {
        let (client, server) = tokio::io::duplex(buffer);
        let (closing, shutdown) = watch::channel(false);
        let connection = tokio::spawn(serve_connection(
            server,
            SocketAddr::from(([127, 0, 0, 1], 1)),
            router,
            LIMITS,
            shutdown,
        ));
        (client, closing, connection)
    }

    fn paced(router: Router, limit: Pace) -> Router {
        router.layer(axum::middleware::from_fn(move |request, next| {
            read_body_at_pace(request, next, limit)
        }))
    }

    #[tokio::test(start_paused = true)]
    async fn connections_without_a_request_close() {
        for opening in [
            &b""[..],
            b"GET / HTTP/1.1\r\nHost: localhost\r\n",
            b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
        ] {
            let router = Router::new().route("/", axum::routing::get(|| async { "ok" }));
            let (mut client, _closing, connection) = connect(router, 64 * 1024);
            client.write_all(opening).await.unwrap();
            tokio::time::timeout(LIMITS.header_timeout + Duration::from_secs(1), connection)
                .await
                .expect("a connection without a request must close")
                .unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_request_bodies_get_a_timeout_response() {
        let router = Router::new().route(
            "/",
            axum::routing::post(|body: axum::body::Bytes| async move { body }),
        );
        let (mut client, _closing, connection) = connect(paced(router, LIMITS.body), 64 * 1024);
        client
            .write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx")
            .await
            .unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(120), client.read_to_end(&mut response))
            .await
            .expect("a stalled body must end the request")
            .unwrap();
        assert!(String::from_utf8_lossy(&response).contains("408 Request Timeout"));
        connection.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn trickling_request_bodies_end_although_bytes_keep_coming() {
        use tower::ServiceExt;
        let limit = Pace {
            longest_wait: Some(Duration::from_secs(10)),
            grace: Duration::from_secs(10),
            bytes_per_second: 1024,
        };
        let router = Router::new().route(
            "/",
            axum::routing::post(|body: axum::body::Bytes| async move { body.len().to_string() }),
        );
        let (chunks, body) = tokio::sync::mpsc::channel(1);
        let request = Request::builder()
            .method("POST")
            .uri("/")
            .body(Body::from_stream(
                tokio_stream::wrappers::ReceiverStream::new(body),
            ))
            .unwrap();
        let response = tokio::spawn(paced(router, limit).oneshot(request));
        // One byte every 9 seconds never pauses for the 10 seconds allowed.
        for _ in 0..10 {
            if chunks
                .send(Ok::<_, io::Error>(Bytes::from_static(b"x")))
                .await
                .is_err()
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(9)).await;
        }
        drop(chunks);
        let response = response.await.unwrap().unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::REQUEST_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn steady_uploads_and_sse_outlive_the_body_pace() {
        use http_body_util::BodyExt;
        use tokio_stream::StreamExt;
        use tower::ServiceExt;
        let limit = Pace {
            longest_wait: Some(Duration::from_secs(10)),
            grace: Duration::from_secs(10),
            bytes_per_second: 1024,
        };
        let router = Router::new()
            .route(
                "/upload",
                axum::routing::post(
                    |body: axum::body::Bytes| async move { body.len().to_string() },
                ),
            )
            .route(
                "/events",
                axum::routing::get(|| async {
                    let events = tokio_stream::wrappers::IntervalStream::new(
                        tokio::time::interval(Duration::from_secs(20)),
                    )
                    .map(|_| {
                        Ok::<_, std::convert::Infallible>(
                            axum::response::sse::Event::default().data("alive"),
                        )
                    });
                    axum::response::Sse::new(events)
                }),
            );
        let router = paced(router, limit);
        let (chunks, body) = tokio::sync::mpsc::channel(1);
        let request = Request::builder()
            .method("POST")
            .uri("/upload")
            .body(Body::from_stream(
                tokio_stream::wrappers::ReceiverStream::new(body),
            ))
            .unwrap();
        let upload = tokio::spawn(router.clone().oneshot(request));
        // 16 KiB every 9 seconds: longer than the grace in total, but above
        // the minimum pace.
        for _ in 0..3 {
            chunks
                .send(Ok::<_, io::Error>(Bytes::from(vec![b'x'; 16 * 1024])))
                .await
                .unwrap();
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(9)).await;
        }
        drop(chunks);
        let response = upload.await.unwrap().unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap(),
            (48 * 1024).to_string()
        );
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut events = response.into_body();
        for _ in 0..2 {
            tokio::time::advance(Duration::from_secs(20)).await;
            let frame = events.frame().await.unwrap().unwrap().into_data().unwrap();
            assert!(std::str::from_utf8(&frame).unwrap().contains("data: alive"));
        }
    }

    const RESPONSE_SIZE: usize = 1024 * 1024;

    /// A large download to a client with a 4 KiB receive buffer.
    async fn download() -> (
        DuplexStream,
        watch::Sender<bool>,
        tokio::task::JoinHandle<()>,
    ) {
        let router = Router::new().route(
            "/",
            axum::routing::get(|| async { vec![b'x'; RESPONSE_SIZE] }),
        );
        let (mut client, closing, connection) = connect(router, 4096);
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        (client, closing, connection)
    }

    #[tokio::test(start_paused = true)]
    async fn a_client_that_stops_reading_loses_the_connection() {
        let (_client, _closing, connection) = download().await;
        tokio::time::timeout(Duration::from_secs(120), connection)
            .await
            .expect("the server must give up on a client that reads nothing")
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_but_steady_reader_gets_the_whole_response() {
        let (mut client, _closing, connection) = download().await;
        // At most 4 KiB a second: minutes in total, with every write waiting.
        let mut response = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            match client.read(&mut buffer).await.unwrap() {
                0 => break,
                read => response.extend_from_slice(&buffer[..read]),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        connection.await.unwrap();
        let head = response
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .unwrap();
        assert_eq!(response.len() - head - 4, RESPONSE_SIZE);
    }

    async fn start(
        router: Router,
    ) -> (
        SocketAddr,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<io::Result<()>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_with_limits(
            listener,
            router,
            async {
                let _ = stopped.await;
            },
            Limits {
                connections: 1,
                ..LIMITS
            },
        ));
        (address, stop, server)
    }

    #[tokio::test]
    async fn excess_connections_receive_a_retryable_response() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let entered_handler = entered.clone();
        let release_handler = release.clone();
        let router = Router::new().route(
            "/",
            axum::routing::get(move || {
                let entered = entered_handler.clone();
                let release = release_handler.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    "ok"
                }
            }),
        );
        let (address, stop, server) = start(router).await;
        let mut active = tokio::net::TcpStream::connect(address).await.unwrap();
        active
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        entered.notified().await;
        let mut extra = tokio::net::TcpStream::connect(address).await.unwrap();
        extra
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut data = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(2), async {
            // The empty overload response is complete at the end of its headers;
            // a peer closing with unread input may reset the TCP connection later.
            while !data.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                extra.read_exact(&mut byte).await?;
                data.push(byte[0]);
            }
            Ok::<_, io::Error>(())
        })
        .await;
        drop(extra);
        release.notify_one();
        active.read_to_end(&mut Vec::new()).await.unwrap();
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        read.expect("excess connection must get a response")
            .unwrap();
        let response = String::from_utf8(data).unwrap().to_ascii_lowercase();
        assert!(response.contains("503 service unavailable"), "{response}");
        assert!(response.contains("retry-after: 1"), "{response}");
    }

    #[tokio::test]
    async fn shutdown_drains_admitted_requests_without_waiting_for_keepalive() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let entered_handler = entered.clone();
        let release_handler = release.clone();
        let router = Router::new().route(
            "/",
            axum::routing::post(move || {
                let entered = entered_handler.clone();
                let release = release_handler.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    "completed response"
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve(listener, router, async {
            let _ = stopped.await;
        }));
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        entered.notified().await;
        stop.send(()).unwrap();
        release.notify_one();
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(bytes).unwrap();
        assert!(
            response.contains("200 OK") && response.contains("completed response"),
            "{response}"
        );
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
