import React from "react";
import { StyleSheet, Text, View, useColorScheme, type ViewStyle } from "react-native";

import { getTheme, spacing, typography, type ThemeMode } from "../theme";

export type ScreenProps = {
  children?: React.ReactNode;
  /** Force a palette. Defaults to the OS color scheme. */
  mode?: ThemeMode;
  title?: string;
  subtitle?: string;
  /** Set to false to remove the default content padding. */
  padded?: boolean;
  style?: ViewStyle;
};

/**
 * Minimal screen wrapper: a themed background plus optional title block.
 * Built from React Native primitives only so it works on native and web.
 */
export function Screen({
  children,
  mode,
  title,
  subtitle,
  padded = true,
  style,
}: ScreenProps) {
  const scheme = useColorScheme();
  const theme = getTheme(mode ?? (scheme === "dark" ? "dark" : "light"));

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }, style]}>
      <View style={[styles.content, padded ? { padding: spacing.lg } : null]}>
        {title ? (
          <Text style={[styles.title, { color: theme.colors.text, fontSize: typography.title }]}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.textMuted, fontSize: typography.small }]}>
            {subtitle}
          </Text>
        ) : null}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flex: 1,
    gap: spacing.md,
  },
  title: {
    fontWeight: "700",
  },
  subtitle: {
    fontWeight: "500",
  },
});
