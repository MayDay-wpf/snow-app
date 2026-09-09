type SidebarCollapseProps = {
  open: boolean;
  children: React.ReactNode;
};

export function SidebarCollapse({
  open,
  children,
}: SidebarCollapseProps): React.JSX.Element {
  return (
    <div className={`sidebar-collapse${open ? " is-open" : ""}`}>
      <div className="sidebar-collapse-inner">{children}</div>
    </div>
  );
}
