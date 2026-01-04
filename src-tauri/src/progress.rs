use serde::Serialize;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub operation: String,
    pub current: usize,
    pub total: usize,
    pub step: String,
    pub message: String,
    pub is_complete: bool,
}

impl ProgressEvent {
    pub fn new(operation: &str, current: usize, total: usize, step: &str, message: &str) -> Self {
        Self {
            operation: operation.to_string(),
            current,
            total,
            step: step.to_string(),
            message: message.to_string(),
            is_complete: total > 0 && current >= total,
        }
    }

    pub fn complete(operation: &str, message: &str) -> Self {
        Self {
            operation: operation.to_string(),
            current: 1,
            total: 1,
            step: "完成".to_string(),
            message: message.to_string(),
            is_complete: true,
        }
    }
}

pub fn emit(app: &tauri::AppHandle, event: ProgressEvent) {
    // 失败不阻断主流程
    let _ = app.emit("progress_update", &event);
}

