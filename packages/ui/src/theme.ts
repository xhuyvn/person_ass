/**
 * Design tokens for PersonalAss.
 *
 * Only plain data lives here so the tokens can be shared by any
 * React Native (or react-native-web) surface without pulling in a UI library.
 */

export type ThemeMode = "light" | "dark";

export type ThemeColors = {
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  danger: string;
  success: string;
  warning: string;
};

export type Theme = {
  mode: ThemeMode;
  colors: ThemeColors;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
};

export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  body: 15,
  small: 13,
  caption: 11,
  title: 24,
  heading: 19,
} as const;

const shared = {
  spacing,
  radii,
  typography,
} as const;

export const lightTheme: Theme = {
  mode: "light",
  colors: {
    background: "#F5F6F8",
    surface: "#FFFFFF",
    text: "#16181D",
    textMuted: "#5A616E",
    border: "#DDE1E7",
    primary: "#2563EB",
    danger: "#C62828",
    success: "#1B7F4B",
    warning: "#B26A00",
  },
  ...shared,
};

export const darkTheme: Theme = {
  mode: "dark",
  colors: {
    background: "#101215",
    surface: "#1A1D22",
    text: "#F2F4F7",
    textMuted: "#A2AAB8",
    border: "#2A2F37",
    primary: "#5B8DEF",
    danger: "#EF6A6A",
    success: "#4CAF7D",
    warning: "#E0A64B",
  },
  ...shared,
};

export function getTheme(mode: ThemeMode): Theme {
  return mode === "dark" ? darkTheme : lightTheme;
}
