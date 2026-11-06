import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

/**
 * Font Awesome's dice have SEE-THROUGH pips, so on a dark card they look dark.
 * These draw the same icon with a white square behind it, so the pips are
 * always white. Non-dice icons (the square for "no opinion") are drawn as is.
 */
function parts(icon: IconDefinition) {
  const [w, h, , , path] = icon.icon;
  return {
    w,
    h,
    d: Array.isArray(path) ? path.join(" ") : path,
    // inset so it never peeks past the die's rounded corners
    pips: icon.iconName.startsWith("dice") ? { x: w * 0.09, y: h * 0.14, w: w * 0.82, h: h * 0.72 } : null,
  };
}

interface Props {
  icon: IconDefinition;
  color: string;
  title?: string; // shown on hover, and read out instead of hiding the icon
  className?: string;
}

export function Die({ icon, color, title, className }: Props) {
  const p = parts(icon);
  return (
    <svg
      className={`die${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${p.w} ${p.h}`}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {p.pips && <rect x={p.pips.x} y={p.pips.y} width={p.pips.w} height={p.pips.h} fill="#fff" />}
      <path fill={color} d={p.d} />
    </svg>
  );
}

/** The same drawing as a CSS background image (for the slider handle, which can't hold React elements). */
export function dieImage(icon: IconDefinition, color: string) {
  const p = parts(icon);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.w} ${p.h}">` +
    (p.pips ? `<rect x="${p.pips.x}" y="${p.pips.y}" width="${p.pips.w}" height="${p.pips.h}" fill="#fff"/>` : "") +
    `<path fill="${color}" d="${p.d}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
