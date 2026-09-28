//! Bounded HTTP connections with timed header parsing, preserving streaming bodies.
use std::{io, time::Duration};

use axum::{Router, extract::ConnectInfo};
use hyper_util::{
    rt::{TokioExecutor, TokioIo, TokioTimer},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use tokio::{net::TcpListener, sync::watch, task::JoinSet};

const MAX_CONNECTIONS: usize = 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn serve(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    serve_with_limits(listener, router, shutdown, MAX_CONNECTIONS, HEADER_TIMEOUT).await
}

async fn serve_with_limits(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()>,
    limit: usize,
    header_timeout: Duration,
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
            accepted = listener.accept(), if connections.len() < limit => {
                let (socket, address) = match accepted {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn incomplete_headers_expire_and_release_connection_capacity() {
        let listener = TcpListener::bind("127.0.0.1:19498").await.unwrap();
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
        let listener = TcpListener::bind("127.0.0.1:19492").await.unwrap();
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
