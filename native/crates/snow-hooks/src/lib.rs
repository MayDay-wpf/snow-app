//! Hooks 执行器与配置存储。

pub mod hooks;
pub mod store;

pub use hooks::*;
pub use store::*;

pub(crate) mod database {
    pub use snow_storage_core::database::*;
}

pub(crate) use snow_storage_core::models::{HookConfigInput, HookConfigRecord};

pub(crate) mod system_settings {
    pub use snow_storage_core::system_settings::*;
}

pub(crate) mod storage {
    pub mod services {
        pub use crate::store as hooks_configs;
        pub use snow_storage_core::app_logs;
    }

    pub use snow_storage_core::models::*;
}

pub(crate) mod exports {
    pub mod terminal {
        pub use snow_process::terminal::*;
    }
}

pub(crate) mod utils {
    pub mod process {
        pub use snow_process::process::*;
    }
}
