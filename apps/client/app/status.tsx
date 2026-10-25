import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import type { HealthReady } from "@personalass/contracts";
import { Screen, getTheme, spacing, typography } from "@personalass/ui";
import { checkHealth } from "../src/lib/health";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:2310";
const READY_TIMEOUT_MS = 5000;

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; data: HealthReady }
  | { kind: "error"; message: string };

/**
 * EXPO_PUBLIC_* variables are inlined by Metro at build time.
 * The expression must stay a direct `process.env.EXPO_PUBLIC_*` member access
 * so babel-preset-expo can inline it (and so dev mode can read it live).
 * The default keeps the local-only backend address; no secret is ever bundled.
 */
function readApiBaseUrl(): string {
  try {
    const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (typeof configured === "string" && configured.length > 0) {
      return configured.replace(/\/+$/, "");
    }
  } catch {
    // process.env is not available in every runtime; fall back to the default
  }
  return DEFAULT_API_BASE_URL;
}

function sanitize(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

export default function StatusScreen() {
  const scheme = useColorScheme();
  const theme = useMemo(
    () => getTheme(scheme === "dark" ? "dark" : "light"),
    [scheme],
  );

  const apiBaseUrl = useMemo(() => readApiBaseUrl(), []);
  const [state, setState] = useState<HealthState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const result = await checkHealth({
      baseUrl: apiBaseUrl,
      timeoutMs: READY_TIMEOUT_MS,
    });
    if (result.status === "ok") {
      setState({ kind: "ok", data: result.data });
      return;
    }
    setState({ kind: "error", message: result.message });
  }, [apiBaseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      <View style={styles.card}>
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>
          Trạng thái máy chủ
        </Text>
        <Text style={[styles.muted, { color: theme.colors.textMuted }]}>
          {apiBaseUrl}
        </Text>

        {state.kind === "loading" ? (
          <Text style={[styles.body, { color: theme.colors.text }]}>
            Đang kiểm tra…
          </Text>
        ) : null}

        {state.kind === "ok" ? (
          <View style={styles.rows}>
            <Row label="Trạng thái" value={state.data.status} theme={theme} />
            <Row
              label="Số migration đã áp dụng"
              value={String(state.data.checks.database.migrations_applied)}
              theme={theme}
            />
            <Row
              label="Cơ sở dữ liệu"
              value={state.data.checks.database.ok ? "OK" : "Lỗi"}
              theme={theme}
              valueColor={state.data.checks.database.ok ? theme.colors.success : theme.colors.danger}
            />
            <Row
              label="Thư mục dữ liệu"
              value={state.data.checks.data_dir.ok ? "OK" : "Lỗi"}
              theme={theme}
              valueColor={state.data.checks.data_dir.ok ? theme.colors.success : theme.colors.danger}
            />
            <Row label="Thời gian kiểm tra" value={state.data.time} theme={theme} />
          </View>
        ) : null}

        {state.kind === "error" ? (
          <Text style={[styles.error, { color: theme.colors.danger }]}>
            {sanitize(state.message)}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void load();
          }}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.colors.primary, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Text style={styles.buttonText}>
            {state.kind === "loading" ? "Đang tải…" : "Thử lại"}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

type RowProps = {
  label: string;
  value: string;
  theme: ReturnType<typeof getTheme>;
  valueColor?: string;
};

function Row({ label, value, theme, valueColor }: RowProps) {
  return (
    <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
      <Text style={[styles.rowLabel, { color: theme.colors.textMuted }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: valueColor ?? theme.colors.text }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
  },
  cardTitle: {
    fontSize: typography.heading,
    fontWeight: "700",
  },
  muted: {
    fontSize: typography.small,
  },
  body: {
    fontSize: typography.body,
  },
  error: {
    fontSize: typography.body,
    fontWeight: "600",
  },
  rows: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    fontSize: typography.body,
  },
  rowValue: {
    fontSize: typography.body,
    fontWeight: "600",
  },
  button: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: 10,
    alignItems: "center",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: typography.body,
    fontWeight: "700",
  },
});
