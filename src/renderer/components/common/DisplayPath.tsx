import { formatDisplayPath } from "../../utils/formatDisplayPath";

export function DisplayPath({
  path,
  className,
}: {
  path: string;
  className?: string;
}): React.JSX.Element {
  const displayPath = formatDisplayPath(path);
  const windowsPath = /^[a-z]:[\\/]|^\\\\/i.test(displayPath);
  const withoutTrailingSeparators = displayPath.replace(
    windowsPath ? /[\\/]+$/ : /\/+$/,
    "",
  );
  const separator = Math.max(
    0,
    withoutTrailingSeparators.lastIndexOf("/"),
    windowsPath ? withoutTrailingSeparators.lastIndexOf("\\") : -1,
  );

  return (
    <span
      className={`display-path${className ? ` ${className}` : ""}`}
      title={displayPath}
    >
      <span className="display-path-parent">
        {displayPath.slice(0, separator)}
      </span>
      <span className="display-path-name">{displayPath.slice(separator)}</span>
    </span>
  );
}
