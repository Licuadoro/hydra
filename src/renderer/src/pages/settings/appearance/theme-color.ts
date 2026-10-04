import Color from "color";
import type { Theme } from "@types";
import { generateUUID } from "@renderer/helpers";

/**
 * Color principal predeterminado de la aplicación (Hydrogenium [By LICUADO]).
 */
export const DEFAULT_THEME_COLOR = "#06d1af";

/**
 * Identificador del tema por defecto; se usa también para detectar si el
 * usuario lo ha personalizado cambiando su color.
 */
export const BUILT_IN_THEME_ID = "hydrogenium-default";

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const isValidHexColor = (value: string): boolean =>
  HEX_COLOR_REGEX.test(value.trim());

export const normalizeHexColor = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  if (!isValidHexColor(trimmed)) return DEFAULT_THEME_COLOR;

  if (trimmed.length === 4) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }

  return trimmed;
};

const toRgbChannels = (hex: string): string => {
  const color = Color(normalizeHexColor(hex));
  const [r, g, b] = color.rgb().array().map((channel) => Math.round(channel));
  return `${r}, ${g}, ${b}`;
};

/**
 * Genera el CSS (variables + reglas que usan !important para poder
 * recolorizar la app en caliente) a partir de un color base.
 */
export const buildThemeCssFromColor = (baseColor: string): string => {
  const hex = normalizeHexColor(baseColor);
  const rgb = toRgbChannels(hex);

  const hover = Color(hex).lighten(0.12).saturate(0.05).hex();
  const active = Color(hex).darken(0.15).hex();
  const subtle = Color(hex).alpha(0.16).rgb().string();
  const strong = Color(hex).alpha(0.38).rgb().string();
  const glow = Color(hex).alpha(0.45).rgb().string();
  const textOnAccent = Color(hex).isLight() ? "#0d0d0d" : "#ffffff";

  return `/*
  Tema dinámico de Hydrogenium [By LICUADO].
  Este CSS se genera automáticamente a partir del color seleccionado.
  Puedes seguir editándolo a mano si quieres un control total.
*/

:root {
  --theme-color: ${hex};
  --theme-color-hover: ${hover};
  --theme-color-active: ${active};
  --theme-color-rgb: ${rgb};
  --theme-color-subtle: ${subtle};
  --theme-color-strong: ${strong};
  --theme-color-glow: ${glow};
  --theme-on-accent: ${textOnAccent};
}

/* Enlaces y textos de acento */
a {
  color: var(--theme-color) !important;
}

/* Barra de desplazamiento */
::-webkit-scrollbar-thumb {
  background-color: rgba(var(--theme-color-rgb), 0.45) !important;
}

::-webkit-scrollbar-thumb:hover {
  background-color: rgba(var(--theme-color-rgb), 0.7) !important;
}

/* Botones primarios */
.button--primary {
  background-color: var(--theme-color) !important;
  color: var(--theme-on-accent) !important;
}

.button--primary:hover:not(:disabled) {
  background-color: var(--theme-color-hover) !important;
}

.button--primary:disabled {
  background-color: rgba(var(--theme-color-rgb), 0.4) !important;
}

/* Botones de contorno */
.button--outline:hover:not(:disabled) {
  background-color: var(--theme-color-subtle) !important;
  border-color: rgba(var(--theme-color-rgb), 0.5) !important;
}

/* Campos de texto / selección */
.text-field input:focus,
.text-field textarea:focus,
.select-field__option:focus,
input[type="text"]:focus,
input[type="url"]:focus,
input[type="number"]:focus,
input[type="password"]:focus,
input[type="search"]:focus {
  border-color: var(--theme-color) !important;
  box-shadow: 0 0 0 1px var(--theme-color-subtle) !important;
}

/* Casillas de verificación y radios */
.checkbox-field input:checked,
.radio-field input:checked,
input[type="checkbox"]:checked,
input[type="radio"]:checked,
input[type="range"] {
  accent-color: var(--theme-color) !important;
}

/* Menús contextuales y elementos seleccionados */
.context-menu__item:hover,
.dropdown-menu__item:hover,
li[data-selected="true"],
.selected {
  background-color: var(--theme-color-subtle) !important;
}

/* Barras de progreso */
.progress-bar__progress,
.progress-bar > div {
  background-color: var(--theme-color) !important;
}

/* Pestañas y elementos activos */
.tab.active,
[class*="__item"][class*="--active"],
[class*="active"][class*="tab"],
[class*="selected"] {
  color: var(--theme-color) !important;
}

/* Badges e indicadores */
.badge--accent,
[class*="badge"] {
  border-color: rgba(var(--theme-color-rgb), 0.35) !important;
}

/* Sombras y brillos de marca */
[class*="hero"],
[class*="card"]:hover {
  box-shadow: 0 0 24px -12px var(--theme-color-glow) !important;
}
`;
};

/**
 * Crea (o reconstruye) el tema predeterminado de la aplicación con el color
 * indicado. El tema siempre es editable porque su código es CSS normal.
 */
export const createDefaultTheme = (
  baseColor: string = DEFAULT_THEME_COLOR,
  overrides: Partial<Theme> = {}
): Theme => {
  const now = new Date();

  return {
    id: BUILT_IN_THEME_ID,
    name: "Hydrogenium",
    authorName: "LICUADO",
    isActive: true,
    code: buildThemeCssFromColor(baseColor),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

/**
 * Extrae el color guardado dentro del CSS de un tema dinámico.
 */
export const getThemeColorFromCode = (code: string): string | null => {
  const match = /--theme-color:\s*(#[0-9a-fA-F]{3,6})/.exec(code ?? "");
  if (!match) return null;
  return normalizeHexColor(match[1]);
};
