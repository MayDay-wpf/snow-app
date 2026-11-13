import {
  Anthropic,
  DeepSeek,
  Gemini,
  Google,
  Jina,
  Mistral,
  Ollama,
  OpenAI,
} from "@lobehub/icons";
import { BrandAvatar } from "../../common/customBrandIcons";

type RequestMethodIconProps = {
  method: string;
  size?: number;
};

export function RequestMethodIcon({
  method,
  size = 15,
}: RequestMethodIconProps): React.JSX.Element | null {
  switch (method) {
    case "chat":
      return <DeepSeek.Color size={size} />;
    case "responses":
      return <OpenAI size={size} />;
    case "anthropic":
      return <Anthropic size={size} />;
    case "gemini":
      return <Gemini.Color size={size} />;
    case "interactions":
      return <Google.Color size={size} />;
    default:
      return null;
  }
}

/** 决策模型方案图标。 */
export function DecisionProviderIcon({
  method,
  size = 15,
}: RequestMethodIconProps): React.JSX.Element | null {
  switch (method) {
    case "typesafe":
      return (
        <BrandAvatar
          brand="typesafe"
          size={size}
          className="model-brand-icon"
        />
      );
    case "openai":
      return <OpenAI size={size} />;
    case "gemini":
      return <Gemini.Color size={size} />;
    default:
      return null;
  }
}

/** 嵌入模型类型图标。 */
export function EmbeddingTypeIcon({
  method,
  size = 15,
}: RequestMethodIconProps): React.JSX.Element | null {
  switch (method) {
    case "jina":
      return <Jina size={size} />;
    case "ollama":
      return <Ollama size={size} />;
    case "gemini":
      return <Gemini.Color size={size} />;
    case "mistral":
      return <Mistral.Color size={size} />;
    default:
      return null;
  }
}

type SchemeOption = { value: string; label: string };

/** 方案下拉的选项/触发器渲染：图标 + 文案。 */
export const renderSchemeOption =
  (Icon: (props: RequestMethodIconProps) => React.JSX.Element | null) =>
  (option: SchemeOption): React.JSX.Element => (
    <span className="request-method-option">
      <Icon method={option.value} />
      <span>{option.label}</span>
    </span>
  );
