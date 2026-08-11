// Minimal stub so ts-jest can resolve `obsidian` in tests. The tested modules
// are obsidian-free; this exists for the ones that import it transitively.
// setIcon is Obsidian's Lucide <svg> injector — a marker element is enough.
export class Modal {}
export class Setting {}
export class Notice {}
export class Plugin {}

export function setIcon(parent: HTMLElement, iconId: string): void {
  const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('data-icon', iconId);
  parent.appendChild(svg);
}
