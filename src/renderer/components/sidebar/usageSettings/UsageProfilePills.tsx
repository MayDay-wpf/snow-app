import { Layers } from "lucide-react";
import { ModelBrandIcon } from "../../common/ModelBrandIcon";
import { useI18n } from "../../../i18n";
import type { UsageProfileInfo } from "../../../../preload";

type Props = {
  profiles: UsageProfileInfo[];
  value: string;
  onChange: (value: string) => void;
};

/** 档案筛选：带主力模型品牌图标的横向按钮，过多时横向滚动。 */
export function UsageProfilePills({
  profiles,
  value,
  onChange,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className="usage-profile-pills"
      role="tablist"
      aria-label={t("settings.usageProfileFilterLabel", {
        defaultValue: "API profile",
      })}
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === ""}
        className={`usage-profile-pill${value === "" ? " active" : ""}`}
        onClick={() => onChange("")}
      >
        <Layers size={13} strokeWidth={1.8} />
        <span>
          {t("settings.usageProfileAll", { defaultValue: "All profiles" })}
        </span>
      </button>
      {profiles.map((profile) => (
        <button
          key={profile.name}
          type="button"
          role="tab"
          aria-selected={value === profile.name}
          className={`usage-profile-pill${
            value === profile.name ? " active" : ""
          }`}
          title={profile.topModel || profile.name}
          onClick={() => onChange(profile.name)}
        >
          <ModelBrandIcon model={profile.topModel} size={14} />
          <span>{profile.name}</span>
        </button>
      ))}
    </div>
  );
}
