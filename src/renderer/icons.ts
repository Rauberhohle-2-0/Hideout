/**
 * Lucide icon registry for the renderer.
 *
 * Every icon the UI hydrates — the static markup in index.html as well as
 * runtime DOM additions — comes from the allow-list below. Feature modules
 * request icons by name instead of importing `lucide` directly, which keeps
 * the bundled icon set explicit and single-sourced.
 *
 * `createIcons` swaps each `<i data-lucide="…">` placeholder for its SVG,
 * keeping the element's own class and data-* attributes (e.g.
 * `data-theme-icon`, `hidden`). Keys are the PascalCase export names; lucide
 * matches them to the kebab-case `data-lucide` attribute.
 */
import {
  ChevronDown,
  ChevronLeft,
  createIcons,
  MessageCircle,
  Mic,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  History,
  Search,
  SendHorizontal,
  Server,
  Settings,
  ShieldCheck,
  ShieldOff,
  Square,
  SquarePen,
  Sun,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
  type IconNode,
} from 'lucide'

/** The full allow-list of icons this app may render. */
export const ICONS: Record<string, IconNode> = {
  ChevronDown,
  ChevronLeft,
  MessageCircle,
  Mic,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  History,
  Search,
  SendHorizontal,
  Server,
  Settings,
  ShieldCheck,
  ShieldOff,
  Square,
  SquarePen,
  Sun,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
}

export type IconName = keyof typeof ICONS

/** Every registered icon name, for the startup pass over static markup. */
const ALL_ICONS = Object.keys(ICONS) as IconName[]

/**
 * Hydrate the given icons (or the full registry when `names` is omitted) into
 * the current DOM. Safe to call repeatedly — untouched placeholders are
 * simply ignored.
 */
export function hydrateIcons(names: IconName[] = ALL_ICONS): void {
  const icons: Record<string, IconNode> = {}
  for (const name of names) {
    icons[name] = ICONS[name]
  }
  createIcons({ icons })
}
