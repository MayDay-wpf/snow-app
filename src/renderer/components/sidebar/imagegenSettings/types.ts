/** 渠道协议类型：openai = OpenAI 兼容 Images API；gemini = Google Gemini Imagen；novelai = NovelAI 原生图片 API。 */
export type ImageGenProvider = "openai" | "gemini" | "novelai";

/** 生图执行模式：auto = Agent 自主判定；sync = 总是同步阻塞；async = 总是异步后台生成。 */
export type ImageGenExecutionMode = "auto" | "sync" | "async";

/** 渠道内单个绘图模型的独立参数配置 */
export type ImageGenModelItem = {
  /** 唯一标识（例如 modelId 或生成 id） */
  id: string;
  /** 真实模型 ID（如 gpt-image-2.5-sunburst） */
  model: string;
  /** 别名/展示名（可选，如 "Sunburst 旗舰推理"） */
  name?: string;
  /** 默认尺寸（如 "2560x1440" 或 "16:9@2K"） */
  defaultSize?: string;
  /** 默认质量（如 "xhigh"） */
  defaultQuality?: string;
  /** 默认生成复杂度；留空时由服务商决定。 */
  defaultComplexity?: string;
  /** 模型输出格式；留空时使用渠道格式。 */
  defaultOutputFormat?: string;
  /** 该模型支持的比例列表（如 "1:1, 16:9, 9:16..."） */
  supportedRatios?: string;
  /** 该模型支持的分辨率列表（如 "1K, 2K, 4K"） */
  supportedResolutions?: string;
  /** 该模型支持的思考强度选项（如 "low, medium, high"） */
  supportedThinking?: string;
  /** 该模型支持的画质/质量选项列表（如 "low, medium, high, xhigh, max"） */
  supportedQualities?: string;
  /** 专属提示词说明/指引（注入给生图工具描述） */
  customPrompt?: string;
  /** 是否启用（可选，默认 true） */
  enabled?: boolean;
};

/** 单个生图渠道（支持任意多个，每个渠道独立配置自己的端点/密钥/多模型）。 */
export type ImageGenChannelValue = {
  /** 渠道唯一 ID（前端生成；旧数据迁移时用协议名），供 provider 参数引用。 */
  id: string;
  /** 用户自定义显示名（留空时回退到协议名）。 */
  name: string;
  /** 协议类型（决定请求协议与默认端点）。 */
  provider: ImageGenProvider;
  /** 渠道启用开关（未启用时该渠道不可用）。 */
  enabled: boolean;
  /** 留空 = 使用服务商官方默认端点。 */
  baseUrl: string;
  apiKey: string;
  /** 默认主模型 ID；留空时若 models 非空取首个。 */
  model: string;
  defaultSize: string;
  defaultQuality: string;
  outputFormat: string;
  /** Gemini 联网搜索（Grounding with Google Search），仅 Gemini 生效。 */
  webSearch: boolean;
  /** 默认流式预览（生成过程实时显示中间图），工具参数 stream 可覆盖。 */
  defaultStream: boolean;
  /** 用户配置的模型支持的宽高比（例如 "1:1, 16:9, 9:16, 4:3, 3:4, 21:9" 等）。 */
  supportedRatios?: string;
  /** 用户配置的模型支持的分辨率档位（例如 "1K, 2K, 4K" 或 "1024x1024, 1792x1024" 等）。 */
  supportedResolutions?: string;
  /** 用户配置的模型支持的思考强度选项（例如 "low, medium, high" 或 "minimal, high" 等）。 */
  supportedThinking?: string;
  /** 用户配置的模型支持的画质选项（例如 "low, medium, high, xhigh, max" 等）。 */
  supportedQualities?: string;
  /** 用户自定义的渠道/模型能力说明与提示词模板（动态注入到 imagegen-generate 工具提示词中）。 */
  customPrompt?: string;
  /** 渠道专属执行模式（可选覆写全局设置：auto / sync / async）。 */
  executionMode?: ImageGenExecutionMode;
  /** 渠道内配置的多个绘图模型列表（每个模型有独立的尺寸/画质/思考强度/提示词配置）。 */
  models?: ImageGenModelItem[];
};

/** 渠道预设模板，供前端配置时一键填入。 */
export type ImageGenTemplate = {
  id: string;
  name: string;
  provider: ImageGenProvider;
  baseUrl?: string;
  model: string;
  defaultSize?: string;
  defaultQuality?: string;
  supportedRatios?: string;
  supportedResolutions?: string;
  supportedThinking?: string;
  supportedQualities?: string;
  customPrompt?: string;
  outputFormat?: string;
  webSearch?: boolean;
  defaultStream?: boolean;
  description?: string;
};

/** 生图设置：任意多个独立渠道（数组顺序即优先级），可同时启用。 */
export type ImageGenSettingsValue = {
  channels: ImageGenChannelValue[];
  /**
   * 同一批次生图请求的最大并发数（1-8）。AI 一次请求多张图片时，
   * 最多同时发起该数量的生成请求，其余排队（完成一张补一张）。
   * 旧数据缺失该字段时回退默认值（4）。
   */
  maxConcurrentImages: number;
  /**
   * 生图请求超时（秒，60-3600）。单次生成/编辑请求（含流式）的最长
   * 等待时间，超时后请求被中断。复杂提示词或高分辨率（2K/4K）生成
   * 可能超过 3 分钟，默认 300 秒（5 分钟）；旧数据缺失时回退默认值。
   */
  timeoutSecs: number;
  /**
   * 生图执行模式：
   * - "auto": Agent 根据提示词、批次与依赖自主判断走同步还是异步（默认）；
   * - "sync": 强制同步等待全部图片生成完毕才继续会话；
   * - "async": 强制提交后台生成并立即释放主代理，出图后自动唤起。
   */
  executionMode: ImageGenExecutionMode;
};

/** 设置表单（与存储值同构）。 */
export type ImageGenSettingsForm = ImageGenSettingsValue;
