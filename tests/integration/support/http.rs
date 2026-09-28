//! Reading responses from the in-process application router.

use axum::{body::Bytes, response::Response};
use http_body_util::BodyExt;
use serde_json::Value;

pub async fn body_bytes(response: Response) -> Bytes {
    response.into_body().collect().await.unwrap().to_bytes()
}

pub async fn body_text(response: Response) -> String {
    String::from_utf8(body_bytes(response).await.to_vec()).unwrap()
}

pub async fn body_json(response: Response) -> Value {
    serde_json::from_slice(&body_bytes(response).await).unwrap()
}
