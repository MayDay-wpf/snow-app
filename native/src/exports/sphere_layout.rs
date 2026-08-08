use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::services::codebase_index::{get_file_embeddings, FileEmbeddingRecord};

// ============================================================================
// 3D 相似度球布局（原在渲染进程同步计算，卡顿整个 UI；现在下沉到 Rust
// 后台线程异步完成，渲染进程只负责展示结果）
// ============================================================================

/// 布局常量，与原渲染端实现一一对应。
const SPHERE_RADIUS: f64 = 1.0;
const LAYOUT_ITERATIONS: usize = 300;
const SPRING_K: f64 = 0.14;
const REPULSION_K: f64 = 0.11;
const CENTERING_K: f64 = 0.03;
/// 每个节点连接相似度最高的两个邻居（无向去重）。
const EDGE_TOP_K: usize = 2;
const EDGE_MIN_SIM: f64 = 0.25;
/// 悬停时高亮的最相似文件数量与最低相似度阈值。
const RELATED_TOP_K: usize = 8;
const RELATED_MIN_SIM: f64 = 0.2;

/// 一个已布局的球面节点：携带展示元数据与悬停高亮所需的相似文件列表。
#[napi(object)]
pub struct CodebaseSphereNode {
    pub index: i32,
    pub relative_path: String,
    pub chunk_count: i32,
    pub start_line: i32,
    pub end_line: i32,
    pub size_bytes: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub related: Vec<CodebaseSphereRelatedFile>,
}

/// 与某节点最相似的一个文件引用。
#[napi(object)]
pub struct CodebaseSphereRelatedFile {
    pub index: i32,
    pub similarity: f64,
}

/// 两个相似文件之间的连线。
#[napi(object)]
pub struct CodebaseSphereEdge {
    pub a: i32,
    pub b: i32,
    pub similarity: f64,
}

/// 球面视图的完整布局结果。
#[napi(object)]
pub struct CodebaseSphereLayout {
    pub nodes: Vec<CodebaseSphereNode>,
    pub edges: Vec<CodebaseSphereEdge>,
}

/// 计算代码库球面视图布局：读文件 embedding → 余弦相似度矩阵 →
/// 力导向布局（300 轮）→ 最近邻边与关联列表。
///
/// 全部计算在 `spawn_blocking` 后台线程完成，不阻塞 NodeJS 事件循环。
#[napi]
pub async fn get_codebase_sphere_layout(
    project_id: String,
    limit: i32,
) -> Result<CodebaseSphereLayout> {
    let storage_info = crate::storage::initialize_app_storage()?;
    let database_path = PathBuf::from(&storage_info.database_path);
    let pid = project_id.clone();
    let limit = limit.clamp(1, 2000) as i64;

    let layout = tokio::task::spawn_blocking(move || {
        // 表不存在时返回空列表，与其它 codebase 查询行为一致。
        match get_file_embeddings(&database_path, &pid, limit) {
            Ok(records) => compute_sphere_layout(records),
            Err(_) => CodebaseSphereLayout {
                nodes: Vec::new(),
                edges: Vec::new(),
            },
        }
    })
    .await
    .map_err(|e| Error::from_reason(format!("Failed to compute sphere layout: {e}")))?;

    Ok(layout)
}

fn compute_sphere_layout(records: Vec<FileEmbeddingRecord>) -> CodebaseSphereLayout {
    let n = records.len();
    if n == 0 {
        return CodebaseSphereLayout {
            nodes: Vec::new(),
            edges: Vec::new(),
        };
    }

    // 对称相似度矩阵（扁平存储，row-major）。
    let mut sim = vec![0.0f64; n * n];
    for i in 0..n {
        for j in (i + 1)..n {
            let s = cosine_similarity(&records[i].embedding, &records[j].embedding);
            sim[i * n + j] = s;
            sim[j * n + i] = s;
        }
    }

    let mut rng = SplitMix64::from_now();
    let mut positions = vec![[0.0f64; 3]; n];
    run_force_layout(&mut positions, &sim, n, &mut rng);
    let (edges, related) = build_edges_and_related(n, &sim);

    let nodes = records
        .into_iter()
        .enumerate()
        .map(|(i, record)| CodebaseSphereNode {
            index: i as i32,
            relative_path: record.relative_path,
            chunk_count: record.chunk_count as i32,
            start_line: record.start_line as i32,
            end_line: record.end_line as i32,
            size_bytes: record.size_bytes,
            x: positions[i][0],
            y: positions[i][1],
            z: positions[i][2],
            related: related[i]
                .iter()
                .map(|(index, similarity)| CodebaseSphereRelatedFile {
                    index: *index as i32,
                    similarity: *similarity,
                })
                .collect(),
        })
        .collect();

    CodebaseSphereLayout { nodes, edges }
}

/// 余弦相似度，夹取到 [-1, 1]（浮点舍入可能把原始比值推出区间，
/// 否则会破坏下方的 Math.pow 类计算产生 NaN）。
fn cosine_similarity(a: &[f64], b: &[f64]) -> f64 {
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    (dot / (norm_a * norm_b).sqrt()).clamp(-1.0, 1.0)
}

/// 3D 力导向布局：以真实余弦相似度映射为弹簧目标距离，相似文件聚拢、
/// 不相似文件远离，形成离散的球形关系图。
fn run_force_layout(positions: &mut [[f64; 3]], sim: &[f64], n: usize, rng: &mut SplitMix64) {
    // 初始位置：均匀分布在球面上（带少量径向扰动）。
    for position in positions.iter_mut() {
        let theta = rng.next_f64() * std::f64::consts::PI * 2.0;
        let phi = (2.0 * rng.next_f64() - 1.0).acos();
        let r = SPHERE_RADIUS * (0.92 + 0.08 * rng.next_f64());
        position[0] = r * phi.sin() * theta.cos();
        position[1] = r * phi.sin() * theta.sin();
        position[2] = r * phi.cos();
    }

    let mut force = vec![0.0f64; n * 3];
    let mut alpha = 1.0f64;

    for _ in 0..LAYOUT_ITERATIONS {
        force.fill(0.0);

        for i in 0..n {
            let ax = positions[i][0];
            let ay = positions[i][1];
            let az = positions[i][2];
            for j in (i + 1)..n {
                let mut dx = ax - positions[j][0];
                let mut dy = ay - positions[j][1];
                let mut dz = az - positions[j][2];
                let mut d = (dx * dx + dy * dy + dz * dz).sqrt();
                if d < 1e-6 {
                    dx = rng.next_f64() - 0.5;
                    dy = rng.next_f64() - 0.5;
                    dz = rng.next_f64() - 0.5;
                    d = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-3);
                }

                // 相似度越高目标距离越近；低相似文件被推到球体边缘。
                let target = (1.5 * SPHERE_RADIUS).min(
                    (0.12 * SPHERE_RADIUS)
                        .max(SPHERE_RADIUS * (1.0 - sim[i * n + j]).max(0.0).powf(1.4) * 0.62),
                );
                let spring = (target - d) * SPRING_K * alpha;
                let fx = (spring * dx) / d;
                let fy = (spring * dy) / d;
                let fz = (spring * dz) / d;
                force[i * 3] += fx;
                force[i * 3 + 1] += fy;
                force[i * 3 + 2] += fz;
                force[j * 3] -= fx;
                force[j * 3 + 1] -= fy;
                force[j * 3 + 2] -= fz;

                // 全局排斥，让簇与簇之间保持间隙（离散感）。
                let rep = (REPULSION_K * alpha) / (d * d + 0.001);
                let rx = (rep * dx) / d;
                let ry = (rep * dy) / d;
                let rz = (rep * dz) / d;
                force[i * 3] += rx;
                force[i * 3 + 1] += ry;
                force[i * 3 + 2] += rz;
                force[j * 3] -= rx;
                force[j * 3 + 1] -= ry;
                force[j * 3 + 2] -= rz;
            }
        }

        for i in 0..n {
            positions[i][0] += force[i * 3];
            positions[i][1] += force[i * 3 + 1];
            positions[i][2] += force[i * 3 + 2];
            let pull = 1.0 - CENTERING_K * alpha;
            positions[i][0] *= pull;
            positions[i][1] *= pull;
            positions[i][2] *= pull;
        }

        alpha *= 0.987;
    }

    // 防御：任何坐标非有限值（NaN/Infinity）的节点重置为球面随机点，
    // 避免污染后续的几何数据。
    for position in positions.iter_mut() {
        if !position[0].is_finite() || !position[1].is_finite() || !position[2].is_finite() {
            let theta = rng.next_f64() * std::f64::consts::PI * 2.0;
            let phi = (2.0 * rng.next_f64() - 1.0).acos();
            position[0] = SPHERE_RADIUS * phi.sin() * theta.cos();
            position[1] = SPHERE_RADIUS * phi.sin() * theta.sin();
            position[2] = SPHERE_RADIUS * phi.cos();
        }
    }

    // 整体缩放，让散点始终铺满球体空间（保持离散球形态）。
    let mut max_norm = 0.0f64;
    for position in positions.iter() {
        let norm =
            (position[0] * position[0] + position[1] * position[1] + position[2] * position[2])
                .sqrt();
        max_norm = max_norm.max(norm);
    }
    if max_norm > 0.05 * SPHERE_RADIUS {
        let scale = SPHERE_RADIUS / max_norm;
        for position in positions.iter_mut() {
            position[0] *= scale;
            position[1] *= scale;
            position[2] *= scale;
        }
    }
}

/// 每个节点取相似度最高的两个邻居构成连线（无向去重，需 ≥ EDGE_MIN_SIM），
/// 同时生成悬停高亮用的关联文件列表（前 RELATED_TOP_K 且 ≥ RELATED_MIN_SIM）。
/// 一次排序同时产出两份数据。
fn build_edges_and_related(
    n: usize,
    sim: &[f64],
) -> (Vec<CodebaseSphereEdge>, Vec<Vec<(usize, f64)>>) {
    let mut edges = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut related: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];

    for i in 0..n {
        let mut ranked: Vec<(usize, f64)> = (0..n)
            .filter(|&j| j != i)
            .map(|j| (j, sim[i * n + j]))
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        for (rank, (j, s)) in ranked.iter().enumerate() {
            if rank < RELATED_TOP_K && *s >= RELATED_MIN_SIM {
                related[i].push((*j, *s));
            }
            if rank >= EDGE_TOP_K || *s < EDGE_MIN_SIM {
                continue;
            }
            let key = if i < *j { (i, *j) } else { (*j, i) };
            if seen.insert(key) {
                edges.push(CodebaseSphereEdge {
                    a: i as i32,
                    b: *j as i32,
                    similarity: *s,
                });
            }
        }
    }

    (edges, related)
}

/// 无外部依赖的 splitmix64 伪随机数发生器：满足布局对随机球面初始化的
/// 需要，且每次调用以当前时间为种子，保证每次刷新布局都有变化。
struct SplitMix64(u64);

impl SplitMix64 {
    fn from_now() -> Self {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E3779B97F4A7C15);
        SplitMix64(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}
