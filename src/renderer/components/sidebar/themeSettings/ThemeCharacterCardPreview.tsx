import { useI18n } from "../../../i18n";
import type { ThemeCharacterCard } from "./types";

/** 角色卡正文的可选字段：与设置面板编辑态共用同一批字段与文案。 */
const CHARACTER_CARD_FIELDS: Array<{
  key: "personality" | "speakingStyle" | "background" | "greeting";
  labelKey: string;
  defaultLabel: string;
}> = [
  {
    key: "personality",
    labelKey: "settings.themeCharacterCardPersonality",
    defaultLabel: "Personality",
  },
  {
    key: "speakingStyle",
    labelKey: "settings.themeCharacterCardSpeakingStyle",
    defaultLabel: "Speaking style",
  },
  {
    key: "background",
    labelKey: "settings.themeCharacterCardBackground",
    defaultLabel: "Background",
  },
  {
    key: "greeting",
    labelKey: "settings.themeCharacterCardGreeting",
    defaultLabel: "Opening line",
  },
];

type ThemeCharacterCardPreviewProps = {
  card: ThemeCharacterCard;
};

/** 角色卡正文：只渲染有内容的字段，供 IM 设置面板与生成确认弹窗共用。 */
export function ThemeCharacterCardPreview({
  card,
}: ThemeCharacterCardPreviewProps): React.JSX.Element {
  const { t } = useI18n();
  const filledFields = CHARACTER_CARD_FIELDS.filter((field) => card[field.key]);

  return (
    <div className="theme-character-card-body">
      <div className="theme-character-card-name-row">
        <span className="theme-character-card-name">{card.name}</span>
        {card.tagline ? (
          <span className="theme-character-card-tagline">{card.tagline}</span>
        ) : null}
      </div>
      {filledFields.length > 0 ? (
        <dl className="theme-character-card-fields">
          {filledFields.map((field) => (
            <div className="theme-character-card-field" key={field.key}>
              <dt>{t(field.labelKey, { defaultValue: field.defaultLabel })}</dt>
              <dd>{card[field.key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
