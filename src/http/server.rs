//! Bounded HTTP connections and idle request reads, preserving response streams.
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::{ConnectInfo, Request},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use hyper_util::{
    rt::{TokioExecutor, TokioIo, TokioTimer},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::{io::AsyncWriteExt, net::TcpListener, sync::watch, task::JoinSet};
use tokio_stream::StreamExt;

const MAX_CONNECTIONS: usize = 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(15);
const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    serve_with_limits(
        listener,
        router,
        shutdown,
        MAX_CONNECTIONS,
        HEADER_TIMEOUT,
        BODY_IDLE_TIMEOUT,
    )
    .await
}

async fn serve_with_limits(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
    limit: usize,
    header_timeout: Duration,
    body_idle_timeout: Duration,
) -> io::Result<()> {
    let router = router.layer(middleware::from_fn(move |request, next| {
        read_body_with_idle_timeout(request, next, body_idle_timeout)
    }));
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
                if connections.len() >= limit {
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
                let service = TowerToHyperService::new(router.clone().layer(axum::Extension(ConnectInfo(address))));
                let mut shutdown = closing.subscribe();
                connections.spawn(async move {
                    let mut builder = Builder::new(TokioExecutor::new());
                    builder.http1().timer(TokioTimer::new()).header_read_timeout(header_timeout);
                    let connection = builder.serve_connection_with_upgrades(TokioIo::new(socket), service);
                    tokio::pin!(connection);
                    tokio::select! {
                        result = &mut connection => { if result.is_err() { tracing::debug!("HTTP connection closed with a transport error"); } }
                        _ = shutdown.changed() => {
                            connection.as_mut().graceful_shutdown();
                            let _ = connection.await;
                        }
                    }
                });
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

async fn read_body_with_idle_timeout(request: Request, next: Next, idle: Duration) -> Response {
    let (parts, body) = request.into_parts();
    let expired = Arc::new(AtomicBool::new(false));
    let expired_read = expired.clone();
    // Each received chunk resets the deadline. Uploads retain their own size
    // and overall limits; this does not bound a handler or a response stream.
    let stream = body
        .into_data_stream()
        .timeout(idle)
        .map(move |item| match item {
            Ok(chunk) => chunk,
            Err(error) => {
                expired_read.store(true, Ordering::Relaxed);
                Err(axum::Error::new(error))
            }
        });
    let response = next
        .run(Request::from_parts(parts, Body::from_stream(stream)))
        .await;
    if expired.load(Ordering::Relaxed) {
        (StatusCode::REQUEST_TIMEOUT, [(header::CONNECTION, "close")]).into_response()
    } else {
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn stalled_request_bodies_expire_and_release_capacity() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let router = Router::new().route(
            "/",
            axum::routing::post(|body: axum::body::Bytes| async move { body }),
        );
        let server = tokio::spawn(serve_with_limits(
            listener,
            router,
            async {
                let _ = stopped.await;
            },
            1,
            Duration::from_millis(100),
            Duration::from_millis(100),
        ));
        let mut slow = tokio::net::TcpStream::connect(address).await.unwrap();
        slow.write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx")
            .await
            .unwrap();
        let mut data = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(2), slow.read_to_end(&mut data)).await;
        drop(slow);
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        read.expect("stalled body must release the connection")
            .unwrap();
        assert!(String::from_utf8_lossy(&data).contains("408 Request Timeout"));
    }

    #[tokio::test]
    async fn excess_connections_receive_a_retryable_response() {
        use std::sync::Arc;
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_with_limits(
            listener,
            router,
            async {
                let _ = stopped.await;
            },
            1,
            Duration::from_secs(15),
            BODY_IDLE_TIMEOUT,
        ));
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

    #[tokio::test(start_paused = true)]
    async fn progressing_uploads_and_sse_outlive_the_body_idle_deadline() {
        use http_body_util::BodyExt;
        use tower::ServiceExt;
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
            )
            .layer(middleware::from_fn(|request, next| {
                read_body_with_idle_timeout(request, next, Duration::from_secs(10))
            }));
        let (chunks, body) = tokio::sync::mpsc::channel(1);
        let request = Request::builder()
            .method("POST")
            .uri("/upload")
            .body(Body::from_stream(
                tokio_stream::wrappers::ReceiverStream::new(body),
            ))
            .unwrap();
        let upload = tokio::spawn(router.clone().oneshot(request));
        for _ in 0..3 {
            chunks
                .send(Ok::<_, io::Error>(axum::body::Bytes::from_static(b"x")))
                .await
                .unwrap();
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_secs(9)).await;
        }
        drop(chunks);
        let response = upload.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap(),
            "3"
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

    #[tokio::test]
    async fn incomplete_headers_expire_and_release_connection_capacity() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(serve_with_limits(
            listener,
            Router::new().route("/", axum::routing::get(|| async { "ok" })),
            async {
                let _ = stopped.await;
            },
            1,
            Duration::from_millis(100),
            Duration::from_millis(100),
        ));
        let mut slow = tokio::net::TcpStream::connect(address).await.unwrap();
        slow.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n")
            .await
            .unwrap();
        let mut data = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), slow.read_to_end(&mut data))
            .await
            .unwrap()
            .unwrap();
        let mut healthy = tokio::net::TcpStream::connect(address).await.unwrap();
        healthy
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        data.clear();
        healthy.read_to_end(&mut data).await.unwrap();
        assert!(String::from_utf8_lossy(&data).contains("200 OK"));
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn shutdown_drains_admitted_requests_without_waiting_for_keepalive() {
        use std::sync::Arc;
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
