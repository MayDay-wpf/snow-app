# 3-配置API密钥与模型

Snow App 通过 **API 档案（Profile）** 管理模型服务商的接入信息，
支持多档案并存与一键切换。本文介绍如何在图形界面配置 API 密钥与模型，
以及对应的配置文件位置。

## 1. 认识配置入口

| 入口 | 说明 |
| --- | --- |
| 设置 → API 设置（设置页 id：`api-settings`） | 图形界面：新建/编辑/切换 API 档案 |
| `~/.snow/config.json` 的 `snowcfg` 字段 | 与 Snow CLI 共享的配置文件 |
| `~/.snow/active-profile.json` 的 `activeProfile` 字段 | 记录当前生效的档案名 |

## 2. 图形界面配置（多档案）

打开 **设置 → API 设置**，可以新建多个档案。新建档案需填写：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 档案名（Profile name） | 是 | 档案的唯一标识，如 `openai` |
| 显示名（Display name） | 否 | 界面中展示的名称，缺省取档案名 |
| Base URL | 是 | 服务端点地址 |
| Base URL 模式 | 是 | `auto` 自动 / `custom` 手动 |
| API Key | 是 | 服务商密钥，如 `sk-...` |
| 请求方法（Request method） | 是 | 如 `chat` |
| 高级模型（Advanced model） | 是 | 复杂任务使用的模型 |
| 基础模型（Basic model） | 是 | 轻量任务使用的模型 |
| 视觉模型（Vision model） | 否 | 图像理解模型，可单独配置 |

模型输入框聚焦时会自动从当前 Base URL 拉取可用模型列表，也可手动填写。

### 视觉模型独立配置

当主模型不支持视觉时，关闭 **Supports vision** 开关，可单独配置
`visionBaseUrl`、`visionApiKey`、`visionRequestMethod`、`visionModel`，
使图像理解请求走独立的服务端点与密钥。
图片会被文本化为文字描述供主模型理解；同时每条**用户消息**中的图片会
附带 `[Reference image #N ...]` 引用（仅含 upload 目录相对路径），
**图生图时仍使用原始图片**，不会被降级为文生图（见
[9-图像生成](9-图像生成.md)）。

### 可选配置

- **系统提示词**：从已保存的系统提示词中选择，也可继承全局档案设置；
- **自定义请求头方案**：选择 `custom-headers.json` 中定义的 scheme，
  可选"继承全局"或"不使用"；
- **自动压缩**：开启 `enableAutoCompress` 后，当上下文用量达到阈值
  `autoCompressThreshold`（百分比）时自动压缩历史消息；
- **Google 搜索（Gemini）**：开启 `googleSearch` 后，Gemini 聊天请求会注入
  Google Search 工具实现实时联网接地（Grounding with Google Search）；
  视觉模型独立配置区另有 `visionGoogleSearch` 开关，可单独控制视觉请求；
- **Responses Fast Mode**：当请求方法为 `responses` 时，可开启
  `responsesFastMode` 快速模式，让服务端以快速模式处理响应式请求。

表单会按请求方法校验字段：切换请求方法时，不适用于该方法的字段会被
重置或跳过（如思考强度、Responses 专属选项），避免提交无效组合。

以上配置统一保存于 `~/.snow/config.json` 的 `snowcfg` 字段，与 Snow CLI 共享。

## 3. 多档案切换

在 API 设置中切换 **Enable profile** 开关即可切换当前生效档案；
当前档案名记录在 `~/.snow/active-profile.json` 的 `activeProfile` 字段。

## 4. 高级选项

部分高级参数可在 UI 的 Runtime 区域配置（如最大上下文、最大生成
token、流式空闲超时、重试次数与延迟），其余参数可直接编辑
`~/.snow/config.json` 的 `snowcfg` 字段：

| 字段 | 说明 |
| --- | --- |
| `maxContextTokens` | 最大上下文 token 数 |
| `maxTokens` | 单次生成最大 token 数 |
| `streamIdleTimeoutSec` | 流式响应空闲超时（秒） |
| `maxRetries` | 请求最大重试次数 |
| `retryDelayMs` | 重试间隔（毫秒） |
| `showThinking` | 是否展示思考过程 |
| `chatThinking.reasoning_effort` | 思考强度（如 `max`） |
| `toolResultTokenLimit` | 工具结果写入上下文的 token 上限 |

> **提示**：直接编辑 `config.json` 后需重启应用使改动生效。

## 5. AI / 命令行配置（config 工具）

Snow App 内置 `config` 工具，AI Agent 可读写与 UI 同源的配置：

| 工具 | 用途 |
| --- | --- |
| `config-list scope=snowcfg` | 查看当前 API 配置与全部键 |
| `config-get scope=snowcfg key=baseUrl` | 读取单个键（`apiKey` 自动脱敏，如 `sk-****abcd`） |
| `config-set scope=snowcfg key=baseUrl value="..."` | 写入单个键（白名单 + 类型校验 + 自动备份 + 原子写） |
| `config-set scope=app key=activeProfile value="openai"` | 切换生效档案（写 `active-profile.json`） |

示例（一次更新多个字段）：

```jsonc
config-set scope=snowcfg value={
  "advancedModel": "gpt-4o",
  "maxTokens": 8192,
  "showThinking": true
}
```

> **生效方式**：`snowcfg`/`app` 为文件型配置，写入后**需重启应用或重新保存
> UI 设置**生效；`apiKey`/`visionApiKey` 读取一律脱敏，**不要向用户索要或
> 展示明文密钥**；每次写入自动备份到 `~/.snow/.config-backups/`。

## 6. 常见问题

| 症状 | 原因与处理 |
| --- | --- |
| 请求返回 401/403 | 检查 `apiKey` 与 `baseUrl` 是否正确、密钥是否过期 |
| 模型不支持思考 | 关闭 `showThinking` 或调整 `chatThinking.reasoning_effort` |
| 视觉模型不可用 | 单独配置 `visionBaseUrl`、`visionApiKey`、`visionModel` |
| 切换档案不生效 | 确认 `active-profile.json` 中 `activeProfile` 的值 |

## 6. 参考

- 字段完整说明：[3-参考手册/1-settings.json配置参考](../3-参考手册/1-settings.json配置参考.md)
