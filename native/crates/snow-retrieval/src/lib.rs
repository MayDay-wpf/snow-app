//! 检索与模型决策：向量嵌入、重排、决策模型与模型健康检查。

pub mod decision_model;
pub mod embedding;
pub mod model_health;
pub mod reranking;

pub(crate) mod api {
    pub use crate::{decision_model, embedding, model_health, reranking};
    pub use snow_ai::config;
    pub use snow_ai::usage;
    pub use snow_net::http_client;
    pub use snow_providers::common;
    pub use snow_runtime::ephemeral;
}

pub(crate) mod storage {
    pub use snow_storage_core::models::*;
    pub use snow_storage_services::*;

    pub mod services {
        pub use snow_storage_services::services::*;
    }
}
