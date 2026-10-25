import { useMemo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from "react-native";
import { getTheme, radii, spacing, typography, type Theme } from "@personalass/ui";
import { ApiClientError, createApi } from "../lib/api";

/** Small shared building blocks for the web-first screens (RN primitives only). */

export function readApiBaseUrl(): string {
  try {
    const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (typeof configured === "string" && configured.length > 0) return configured.replace(/\/+$/, "");
  } catch {
    // fall through to the local default
  }
  return "http://127.0.0.1:2310";
}

export type Msg = { kind: "ok" | "error"; text: string } | null;

const ENTITY_KEY = /^(task|appointment|note)\/[0-9a-f-]+$/;
const ENTITY_NAME: Record<string, string> = { task: "Việc", appointment: "Lịch hẹn", note: "Ghi chú" };

export function errText(e: unknown): string {
  if (e instanceof ApiClientError) {
    // Undo conflicts are keyed "type/id"; show the kind of item, not the id.
    const label = (k: string) => (ENTITY_KEY.test(k) ? (ENTITY_NAME[k.split("/")[0] as string] ?? k) : k);
    const fields = e.fieldErrors ? Object.entries(e.fieldErrors).map(([k, v]) => `${label(k)}: ${v}`).join("; ") : "";
    return fields ? `${e.message} (${fields})` : e.message;
  }
  return "Có lỗi không mong đợi.";
}

export type Styles = ReturnType<typeof makeStyles>;

/** Theme, styles and API client for a screen. */
export function useScreenKit() {
  const scheme = useColorScheme();
  const theme = useMemo(() => getTheme(scheme === "dark" ? "dark" : "light"), [scheme]);
  const api = useMemo(() => createApi({ baseUrl: readApiBaseUrl() }), []);
  const s = useMemo(() => makeStyles(theme), [theme]);
  return { theme, api, s };
}

export function Card({ theme, title, children, testID }: { theme: Theme; title: string; children: React.ReactNode; testID?: string }) {
  return (
    <View testID={testID} style={{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.lg, gap: spacing.md }}>
      <Text style={{ color: theme.colors.text, fontSize: typography.heading, fontWeight: "700" }}>{title}</Text>
      {children}
    </View>
  );
}

export function Btn({
  s,
  label,
  onPress,
  secondary,
  disabled,
  testID,
}: {
  s: Styles;
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [s.btn, secondary ? s.btnSecondary : null, { opacity: disabled ? 0.5 : pressed ? 0.75 : 1 }]}
    >
      <Text style={[s.btnText, secondary ? s.btnTextSecondary : null]}>{label}</Text>
    </Pressable>
  );
}

/** A row of mutually exclusive choices (segmented control). */
export function Choice<T extends string>({
  s,
  options,
  value,
  onChange,
  label,
}: {
  s: Styles;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <View style={s.choiceRow} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="radio"
          accessibilityLabel={o.label}
          accessibilityState={{ checked: value === o.value }}
          onPress={() => onChange(o.value)}
          style={[s.chip, value === o.value ? s.chipOn : null]}
        >
          <Text style={[s.chipText, value === o.value ? s.chipTextOn : null]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Check({ s, checked, onChange, label }: { s: Styles; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked }} onPress={() => onChange(!checked)}>
      <Text style={s.muted}>
        {checked ? "☑" : "☐"} {label}
      </Text>
    </Pressable>
  );
}

export function Field({ s, theme, label, ...props }: TextInputProps & { s: Styles; theme: Theme; label: string }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} placeholderTextColor={theme.colors.textMuted} accessibilityLabel={label} autoCapitalize="none" {...props} />
    </View>
  );
}

export function makeStyles(t: Theme) {
  return StyleSheet.create({
    page: { padding: spacing.lg, gap: spacing.lg, maxWidth: 760, width: "100%", alignSelf: "center" },
    headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
    title: { color: t.colors.text, fontSize: typography.title, fontWeight: "700" },
    link: { color: t.colors.primary, fontSize: typography.small },
    links: { flexDirection: "row", gap: spacing.lg },
    offline: { color: t.colors.warning, fontSize: typography.body, fontWeight: "600" },
    okMsg: { color: t.colors.success, fontSize: typography.body, fontWeight: "600" },
    errMsg: { color: t.colors.danger, fontSize: typography.body, fontWeight: "600" },
    warn: { color: t.colors.warning, fontSize: typography.small, fontWeight: "600" },
    danger: { color: t.colors.danger, fontSize: typography.small },
    success: { color: t.colors.success, fontSize: typography.small, fontWeight: "600" },
    muted: { color: t.colors.textMuted, fontSize: typography.small },
    label: { color: t.colors.textMuted, fontSize: typography.small, fontWeight: "600" },
    mutedText: { color: t.colors.textMuted },
    body: { color: t.colors.text, fontSize: typography.body },
    done: { textDecorationLine: "line-through", color: t.colors.textMuted },
    input: {
      borderWidth: 1,
      borderColor: t.colors.border,
      borderRadius: radii.sm,
      padding: spacing.md,
      color: t.colors.text,
      fontSize: typography.body,
      backgroundColor: t.colors.background,
    },
    multiline: { minHeight: 80, textAlignVertical: "top" },
    item: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
    block: {
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.border,
    },
    question: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: t.colors.warning,
      backgroundColor: t.colors.background,
    },
    itemMain: { flex: 1, gap: 2 },
    itemTitle: { color: t.colors.text, fontSize: typography.body, fontWeight: "600" },
    actions: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
    btn: { backgroundColor: t.colors.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radii.md, alignItems: "center" },
    btnSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: t.colors.primary },
    btnText: { color: "#FFFFFF", fontSize: typography.body, fontWeight: "700" },
    btnTextSecondary: { color: t.colors.primary },
    choiceRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    chip: { borderWidth: 1, borderColor: t.colors.border, borderRadius: radii.pill, paddingVertical: spacing.xs, paddingHorizontal: spacing.md },
    chipOn: { borderColor: t.colors.primary, backgroundColor: t.colors.primary },
    chipText: { color: t.colors.text, fontSize: typography.small },
    chipTextOn: { color: "#FFFFFF", fontWeight: "700" },
  });
}
