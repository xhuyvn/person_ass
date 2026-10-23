import { Link } from "expo-router";
import Constants from "expo-constants";
import { Pressable, StyleSheet, Text, View, useColorScheme } from "react-native";
import { Screen, getTheme, spacing, typography } from "@personalass/ui";

/**
 * The release version comes from the app config (app.json) through
 * expo-constants: never hardcode it in the UI.
 */
const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";

export default function AboutScreen() {
  const scheme = useColorScheme();
  const theme = getTheme(scheme === "dark" ? "dark" : "light");

  return (
    <Screen>
      <Text style={[styles.title, { color: theme.colors.text }]}>PersonalAss</Text>
      <Text style={[styles.body, { color: theme.colors.textMuted }]}>
        Trợ lý quản lý ghi nhớ, việc nhà, lịch khám và các dự án cá nhân.
      </Text>
      <Text style={[styles.body, { color: theme.colors.textMuted }]}>
        Phiên bản: {APP_VERSION} (mốc M1)
      </Text>

      <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <Text style={[styles.cardTitle, { color: theme.colors.text }]}>Mốc hiện tại</Text>
        <Text style={[styles.body, { color: theme.colors.textMuted }]}>
          M0 — nền tảng: Expo + Expo Router + Fastify + SQLite, giao diện dùng chung.
        </Text>
      </View>

      <Link href="/" asChild>
        <Pressable
          accessibilityRole="link"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.colors.primary, opacity: pressed ? 0.75 : 1 },
          ]}
        >
          <Text style={styles.buttonText}>Về màn hình trạng thái</Text>
        </Pressable>
      </Link>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: typography.title,
    fontWeight: "700",
  },
  body: {
    fontSize: typography.body,
    lineHeight: 22,
  },
  card: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  cardTitle: {
    fontSize: typography.heading,
    fontWeight: "700",
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
