import { useCallback, useEffect, useState } from "react";
import type { OAuthLoginStatus, OAuthProviderInfo } from "../../../../preload";
import { OAuthProviderLoginDialog } from "./OAuthProviderLoginDialog";
import { OAuthProviderPicker } from "./OAuthProviderPicker";
import { SnowRouterLoginDialog } from "./SnowRouterLoginDialog";

type OAuthLoginDialogProps = {
  open: boolean;
  onClose: () => void;
  onCompleted: (status: OAuthLoginStatus) => void;
};

export function OAuthLoginDialog({
  open,
  onClose,
  onCompleted,
}: OAuthLoginDialogProps): React.JSX.Element {
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [isLoadingProviders, setIsLoadingProviders] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<OAuthProviderInfo | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedProvider(null);
      return;
    }

    let stopped = false;
    // 每次打开都重新同步插件 provider，安装 / 更新插件后无需重开页面。
    setIsLoadingProviders(providers.length === 0);
    void window.snow
      .listOAuthProviders()
      .then((list) => {
        if (!stopped) {
          setProviders(list);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) {
          setIsLoadingProviders(false);
        }
      });
    return () => {
      stopped = true;
    };
  }, [open]);

  const handleSelect = useCallback((provider: OAuthProviderInfo) => {
    setSelectedProvider(provider);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedProvider(null);
  }, []);

  return (
    <>
      <OAuthProviderPicker
        open={open && !selectedProvider}
        providers={providers}
        isLoading={isLoadingProviders}
        onSelect={handleSelect}
        onClose={onClose}
      />
      {selectedProvider ? (
        selectedProvider.id === "snowrouter" ? (
          <SnowRouterLoginDialog
            open={open}
            provider={selectedProvider}
            onBack={handleBack}
            onClose={onClose}
            onCompleted={onCompleted}
          />
        ) : (
          <OAuthProviderLoginDialog
            open={open}
            provider={selectedProvider}
            onBack={handleBack}
            onClose={onClose}
            onCompleted={onCompleted}
          />
        )
      ) : null}
    </>
  );
}
