import { useCallback, useState } from "react";
import { Bot, Globe, Loader2, Plus, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import {
  normalizeBrowserAgentDomain,
  useBrowserAgentSettings,
  type BrowserAgentDomainMode,
} from "../../rightPanel/browser/browserAgentSettings";
import { ApiSettingsHintIcon } from "../apiSettings/ApiSettingsFieldLabel";

const DOMAIN_MODES: BrowserAgentDomainMode[] = ["off", "allow", "deny"];

const DOMAIN_MODE_LABEL_KEYS: Record<BrowserAgentDomainMode, string> = {
  off: "settings.browserAgentDomainModeOff",
  allow: "settings.browserAgentDomainModeAllow",
  deny: "settings.browserAgentDomainModeDeny",
};

export function AgentAccessSection(): React.JSX.Element {
  const { t } = useI18n();
  const { settings, update } = useBrowserAgentSettings();
  const [domainDraft, setDomainDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const persist = useCallback(
    async (patch: Parameters<typeof update>[0]): Promise<void> => {
      setSaving(true);
      try {
        await update(patch);
      } catch {
        // 保存失败（IPC 异常）时静默，界面保持上一次成功值。
      } finally {
        setSaving(false);
      }
    },
    [update],
  );

  const handleAddDomain = useCallback((): void => {
    const domain = normalizeBrowserAgentDomain(domainDraft);
    if (!domain || settings.domains.includes(domain)) {
      setDomainDraft("");
      return;
    }
    setDomainDraft("");
    void persist({ domains: [...settings.domains, domain] });
  }, [domainDraft, persist, settings.domains]);

  const handleRemoveDomain = useCallback(
    (domain: string): void => {
      void persist({
        domains: settings.domains.filter((item) => item !== domain),
      });
    },
    [persist, settings.domains],
  );

  return (
    <div className="browser-settings-section">
      <div className="api-settings-form-section-header">
        <span className="api-settings-form-section-title">
          {t("settings.browserAgentAccess", {
            defaultValue: "Agent access",
          })}
          <ApiSettingsHintIcon
            hint={t("settings.browserAgentAccessHint", {
              defaultValue:
                "Browser tabs are private by default: the agent can only drive tabs you share with it (or tabs the agent opened itself, which use an isolated session).",
            })}
          />
        </span>
        {saving && <Loader2 size={13} strokeWidth={1.8} className="spin" />}
      </div>

      <div className="browser-settings-agent-row">
        <label className="browser-settings-agent-toggle toggle-switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => void persist({ enabled: e.target.checked })}
          />
          <span className="toggle-slider" aria-hidden="true" />
          <span>
            {t("settings.browserAgentEnabled", {
              defaultValue: "Allow the agent to use the embedded browser",
            })}
            <ApiSettingsHintIcon
              hint={t("settings.browserAgentEnabledHint", {
                defaultValue:
                  "When off, every browser tool is rejected with an error.",
              })}
            />
          </span>
        </label>
      </div>

      <div className="browser-settings-agent-row">
        <label className="browser-settings-agent-toggle toggle-switch">
          <input
            type="checkbox"
            checked={settings.isolation}
            onChange={(e) => void persist({ isolation: e.target.checked })}
          />
          <span className="toggle-slider" aria-hidden="true" />
          <span>
            {t("settings.browserAgentIsolation", {
              defaultValue: "Give agent-opened tabs an isolated session",
            })}
            <ApiSettingsHintIcon
              hint={t("settings.browserAgentIsolationHint", {
                defaultValue:
                  "Isolated tabs keep their own cookies and storage (in memory only), so they never touch your logged-in session. Turn this off to let the agent reuse your login state in tabs it opens.",
              })}
            />
          </span>
        </label>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>
            {t("settings.browserAgentDomainMode", {
              defaultValue: "Domain policy",
            })}
            <ApiSettingsHintIcon
              hint={`${t("settings.browserAgentDomainModeHint", {
                defaultValue:
                  "Restrict which sites the agent may drive, in addition to tab sharing.",
              })} ${t("settings.browserAgentDomainsHint", {
                defaultValue:
                  "Entries match the host and its subdomains. Allow list: only these hosts are reachable. Block list: everything except these hosts is reachable.",
              })}`}
            />
          </strong>
        </div>
        <div className="api-settings-form-body">
          <div className="browser-settings-agent-domain-modes">
            {DOMAIN_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`browser-settings-agent-domain-mode${
                  settings.domainMode === mode ? " is-active" : ""
                }`}
                onClick={() => void persist({ domainMode: mode })}
              >
                {t(DOMAIN_MODE_LABEL_KEYS[mode])}
              </button>
            ))}
          </div>

          {settings.domainMode !== "off" && (
            <>
              <div className="browser-settings-add-row">
                <Globe size={13} strokeWidth={1.8} />
                <input
                  type="text"
                  className="browser-settings-add-input is-url"
                  value={domainDraft}
                  onChange={(e) => setDomainDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddDomain();
                    }
                  }}
                  placeholder={t("settings.browserAgentDomainsPlaceholder", {
                    defaultValue: "example.com",
                  })}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="browser-settings-add-btn"
                  onClick={handleAddDomain}
                  disabled={!normalizeBrowserAgentDomain(domainDraft)}
                  title={t("settings.browserAgentAddDomain", {
                    defaultValue: "Add domain",
                  })}
                >
                  <Plus size={13} strokeWidth={2} />
                </button>
              </div>

              {settings.domains.length === 0 ? (
                <div className="browser-settings-empty">
                  {t("settings.browserAgentDomainsEmpty", {
                    defaultValue:
                      "No domains yet. Add the sites the agent may (or may not) use.",
                  })}
                </div>
              ) : (
                <div className="browser-settings-agent-domains">
                  {settings.domains.map((domain) => (
                    <span
                      key={domain}
                      className="browser-settings-agent-domain"
                    >
                      <Bot size={11} strokeWidth={1.8} />
                      {domain}
                      <button
                        type="button"
                        onClick={() => handleRemoveDomain(domain)}
                        title={t("common.delete", { defaultValue: "Delete" })}
                      >
                        <X size={11} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
