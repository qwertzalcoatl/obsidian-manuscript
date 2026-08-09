// Minimal stub so ts-jest can resolve `obsidian` in tests. Most tested modules
// are obsidian-free; critic-render.ts needs setIcon, which Obsidian implements
// by injecting a Lucide <svg>. A marker element is enough — the tests assert
// where the glyph lands, not what it draws.
export class Modal {}
export class Setting {}
export class Notice {}
export class Plugin {}

export function setIcon(parent: HTMLElement, iconId: string): void {
  const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('data-icon', iconId);
  parent.appendChild(svg);
}
