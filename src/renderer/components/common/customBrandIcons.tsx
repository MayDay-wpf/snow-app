/** LobeHub 未收录的品牌图标（SVG 取自官网 favicon / 导航 logo）。 */

export type CustomBrand = "typesafe" | "subq";

const CUSTOM_BRAND_RULES: Array<{ brand: CustomBrand; pattern: RegExp }> = [
  { brand: "typesafe", pattern: /typesafe|(^|[^a-z])jev([^a-z]|$)/i },
  { brand: "subq", pattern: /subq/i },
];

/** 按模型名匹配自定义品牌，未命中返回 null。 */
export function matchCustomBrand(model: string): CustomBrand | null {
  const name = model.trim();
  if (!name) {
    return null;
  }
  return (
    CUSTOM_BRAND_RULES.find((rule) => rule.pattern.test(name))?.brand ?? null
  );
}

type GlyphProps = {
  size: number;
  color?: string;
};

/** TypeSafe AI（Jev）标志，单色。 */
export function TypeSafeGlyph({
  size,
  color = "currentColor",
}: GlyphProps): React.JSX.Element {
  return (
    <svg
      width={(size * 16.487) / 24}
      height={size}
      viewBox="0 0 16.487 24"
      aria-hidden
    >
      <path
        fill={color}
        d="M 12.756 2.928 L 12.756 7.067 L 16.486 9.487 L 16.487 18.652 L 8.244 24 L 3.732 21.073 L 3.732 16.82 L 0 14.399 L 0 5.35 L 0.355 5.118 L 8.244 0 Z M 5.94 20.65 L 8.242 22.144 L 14.275 18.227 L 11.975 16.735 Z M 9.022 10.332 L 9.022 14.4 L 5.29 16.822 L 5.29 19.216 L 11.197 15.383 L 11.197 8.921 Z M 12.756 15.384 L 14.928 16.794 L 14.928 10.332 L 12.756 8.922 Z M 2.21 13.976 L 4.511 15.47 L 6.812 13.976 L 4.512 12.485 Z M 1.559 6.193 L 1.559 12.544 L 3.731 11.134 L 3.731 7.066 L 7.464 4.643 L 7.464 2.36 L 1.56 6.193 Z M 5.291 11.132 L 7.463 12.542 L 7.463 10.332 L 5.292 8.921 L 5.292 11.132 Z M 5.94 7.487 L 8.244 8.981 L 10.544 7.488 L 8.244 5.994 Z M 9.024 4.643 L 11.196 6.054 L 11.196 3.774 L 9.024 2.359 Z"
      />
    </svg>
  );
}

/** SubQ（Subquadratic）五色方块标志。 */
export function SubQGlyph({ size }: GlyphProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <rect width="16" height="16" fill="#FFE237" />
      <rect x="16" y="16" width="16" height="16" fill="#999489" />
      <rect x="32" width="16" height="16" fill="#EB521E" />
      <rect y="32" width="16" height="16" fill="#3F7D31" />
      <rect x="32" y="32" width="16" height="16" fill="#0834BC" />
    </svg>
  );
}

const BRAND_AVATARS: Record<
  CustomBrand,
  {
    background: string;
    scale: number;
    render: (size: number) => React.JSX.Element;
  }
> = {
  typesafe: {
    background: "#E551BA",
    scale: 0.62,
    render: (size) => <TypeSafeGlyph size={size} color="#171717" />,
  },
  subq: {
    background: "#F4F1EA",
    scale: 0.54,
    render: (size) => <SubQGlyph size={size} />,
  },
};

type BrandAvatarProps = {
  brand: CustomBrand;
  size: number;
  shape?: "circle" | "square";
  className?: string;
};

/** 自定义品牌头像：与 LobeHub Avatar 一致的底色圆 + 居中标志。 */
export function BrandAvatar({
  brand,
  size,
  shape = "circle",
  className,
}: BrandAvatarProps): React.JSX.Element {
  const spec = BRAND_AVATARS[brand];
  return (
    <span
      className={className}
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: shape === "circle" ? "50%" : Math.floor(size * 0.1),
        background: spec.background,
      }}
    >
      {spec.render(Math.round(size * spec.scale))}
    </span>
  );
}
