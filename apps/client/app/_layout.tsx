import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { getTheme } from "@personalass/ui";

export default function RootLayout() {
  const scheme = useColorScheme();
  const isDark = scheme === "dark";
  const theme = getTheme(isDark ? "dark" : "light");

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.text,
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: "PersonalAss" }} />
        <Stack.Screen name="settings" options={{ title: "Cài đặt AI" }} />
        <Stack.Screen name="status" options={{ title: "Trạng thái" }} />
        <Stack.Screen name="about" options={{ title: "Giới thiệu" }} />
      </Stack>
    </>
  );
}
