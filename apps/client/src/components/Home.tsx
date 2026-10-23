import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { Link } from "expo-router";
import type { Appointment, Note, Notification, Task } from "@personalass/contracts";
import { Screen, getTheme, radii, spacing, typography, type Theme } from "@personalass/ui";
import { ApiClientError, createApi, newUuid } from "../lib/api";
import {
  DEFAULT_TIMEZONE,
  formatDate,
  formatInstant,
  localDateTimeToIso,
  parseDateInput,
} from "../lib/format";

const POLL_MS = 15000;

function readApiBaseUrl(): string {
  try {
    const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (typeof configured === "string" && configured.length > 0) return configured.replace(/\/+$/, "");
  } catch {
    // fall through to the local default
  }
  return "http://127.0.0.1:4310";
}

type Msg = { kind: "ok" | "error"; text: string } | null;

function errText(e: unknown): string {
  if (e instanceof ApiClientError) {
    const fields = e.fieldErrors ? Object.entries(e.fieldErrors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
    return fields ? `${e.message} (${fields})` : e.message;
  }
  return "Có lỗi không mong đợi.";
}

export function Home() {
  const scheme = useColorScheme();
  const theme = useMemo(() => getTheme(scheme === "dark" ? "dark" : "light"), [scheme]);
  const api = useMemo(() => createApi({ baseUrl: readApiBaseUrl() }), []);
  const s = useMemo(() => makeStyles(theme), [theme]);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [t, n, a, no] = await Promise.all([
        api.listTasks(),
        api.listNotes(),
        api.listAppointments(),
        api.listNotifications(false),
      ]);
      setTasks(t);
      setNotes(n);
      setAppts(a);
      setNotifs(no);
      setOffline(false);
    } catch (e) {
      setOffline(true);
      setMsg({ kind: "error", text: errText(e) });
    }
  }, [api]);

  const refreshNotifs = useCallback(async () => {
    try {
      setNotifs(await api.listNotifications(false));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refreshNotifs(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, refreshNotifs]);

  async function run(action: () => Promise<unknown>, okText: string): Promise<boolean> {
    try {
      await action();
      setMsg({ kind: "ok", text: okText });
      await refresh();
      return true;
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
      return false;
    }
  }

  /* ---- memo form ---- */
  const [memoText, setMemoText] = useState("");
  const memoRequestId = useRef(newUuid());
  const [lastMemo, setLastMemo] = useState<{ revisionId: string; text: string } | null>(null);
  const [attach, setAttach] = useState(true);

  async function saveMemo() {
    const text = memoText.trim();
    if (!text) return setMsg({ kind: "error", text: "Nhập nội dung memo." });
    const ok = await run(async () => {
      const receipt = await api.createMemo(text, new Date().toISOString(), DEFAULT_TIMEZONE, memoRequestId.current);
      setLastMemo({ revisionId: receipt.revision_id, text });
    }, "Đã lưu memo.");
    if (ok) {
      memoRequestId.current = newUuid();
      setMemoText("");
    }
  }

  /* ---- task form ---- */
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");

  async function addTask() {
    const title = taskTitle.trim();
    if (!title) return setMsg({ kind: "error", text: "Nhập tên việc." });
    let due: string | undefined;
    if (taskDue.trim()) {
      const parsed = parseDateInput(taskDue);
      if (!parsed) return setMsg({ kind: "error", text: "Hạn phải dạng dd/mm/yyyy." });
      due = parsed;
    }
    const ok = await run(
      () =>
        api.createTask({
          title,
          ...(due ? { due_date: due } : {}),
          ...(lastMemo && attach
            ? { source: { memo_revision_id: lastMemo.revisionId, quote: lastMemo.text.slice(0, 200) } }
            : {}),
        }),
      due ? "Đã tạo việc và nhắc 09:00 ngày hạn." : "Đã tạo việc (không có hạn nên không có nhắc).",
    );
    if (ok) {
      setTaskTitle("");
      setTaskDue("");
    }
  }

  /* ---- appointment form ---- */
  const [apptTitle, setApptTitle] = useState("");
  const [apptStart, setApptStart] = useState("");

  async function addAppt() {
    const title = apptTitle.trim();
    if (!title) return setMsg({ kind: "error", text: "Nhập tên lịch hẹn." });
    const iso = localDateTimeToIso(apptStart);
    if (!iso) return setMsg({ kind: "error", text: "Giờ bắt đầu phải dạng yyyy-mm-dd hh:mm." });
    const ok = await run(() => api.createAppointment(title, iso), "Đã tạo lịch hẹn, nhắc trước 30 phút.");
    if (ok) {
      setApptTitle("");
      setApptStart("");
    }
  }

  /* ---- note form ---- */
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");

  async function addNote() {
    const title = noteTitle.trim();
    if (!title) return setMsg({ kind: "error", text: "Nhập tiêu đề ghi chú." });
    const ok = await run(() => api.createNote(title, noteBody), "Đã lưu ghi chú.");
    if (ok) {
      setNoteTitle("");
      setNoteBody("");
    }
  }

  const unread = notifs.filter((n) => n.state !== "acknowledged");

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={s.page}>
        <View style={s.headerRow}>
          <Text style={s.title}>PersonalAss</Text>
          <Link href="/status" style={s.link}>
            Trạng thái máy chủ
          </Link>
        </View>

        {offline ? (
          <Text style={s.offline} testID="offline-banner">
            Không kết nối được máy chủ. Dữ liệu hiển thị có thể cũ; thử lại sau khi backend chạy.
          </Text>
        ) : null}
        {msg ? (
          <Text style={msg.kind === "ok" ? s.okMsg : s.errMsg} testID="message" accessibilityRole="alert">
            {msg.text}
          </Text>
        ) : null}

        <Card theme={theme} title={`Thông báo (${unread.length} chưa đọc)`}>
          {notifs.length === 0 ? <Text style={s.muted}>Chưa có thông báo.</Text> : null}
          {notifs.map((n) => (
            <View key={n.id} style={s.item} testID={`notification-${n.kind}`}>
              <View style={s.itemMain}>
                <Text style={[s.itemTitle, n.state === "acknowledged" ? s.mutedText : null]}>{n.title}</Text>
                <Text style={s.muted}>
                  {n.kind === "digest" ? "Tóm tắt nhắc bị lỡ: " : `${n.body} · `}
                  {n.kind === "digest" ? n.body : n.scheduled_at ? formatInstant(n.scheduled_at) : ""}
                </Text>
              </View>
              {n.state !== "acknowledged" ? (
                <View style={s.actions}>
                  <Btn s={s} label="Đã xem" onPress={() => void run(() => api.ackNotification(n.id), "Đã xác nhận.")} />
                  {n.kind === "reminder" ? (
                    <Btn s={s} secondary label="Hoãn 30 phút" onPress={() => void run(() => api.snoozeNotification(n.id, 30), "Đã hoãn 30 phút.")} />
                  ) : null}
                </View>
              ) : (
                <Text style={s.muted}>đã xem</Text>
              )}
            </View>
          ))}
        </Card>

        <Card theme={theme} title="Ghi nhanh memo">
          <TextInput
            style={[s.input, s.multiline]}
            multiline
            placeholder="Ví dụ: Mai 9h họp với Minh"
            placeholderTextColor={theme.colors.textMuted}
            value={memoText}
            onChangeText={setMemoText}
            accessibilityLabel="Nội dung memo"
          />
          <Btn s={s} label="Lưu memo" onPress={() => void saveMemo()} />
          <Text style={s.muted}>Memo được lưu nguyên văn. Chưa có AI nên chưa tự tạo việc/lịch; hãy tạo bên dưới.</Text>
        </Card>

        <Card theme={theme} title={`Việc (${tasks.length})`}>
          <TextInput style={s.input} placeholder="Tên việc" placeholderTextColor={theme.colors.textMuted} value={taskTitle} onChangeText={setTaskTitle} accessibilityLabel="Tên việc" />
          <TextInput style={s.input} placeholder="Hạn (dd/mm/yyyy, để trống nếu không có)" placeholderTextColor={theme.colors.textMuted} value={taskDue} onChangeText={setTaskDue} accessibilityLabel="Hạn việc" />
          {lastMemo ? (
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: attach }} onPress={() => setAttach(!attach)}>
              <Text style={s.muted}>{attach ? "☑" : "☐"} Gắn nguồn từ memo vừa lưu</Text>
            </Pressable>
          ) : null}
          <Btn s={s} label="Thêm việc" onPress={() => void addTask()} />
          {tasks.map((t) => (
            <View key={t.id} style={s.item} testID="task-item">
              <View style={s.itemMain}>
                <Text style={[s.itemTitle, t.status === "done" ? s.done : null]}>{t.title}</Text>
                <Text style={s.muted}>
                  {t.due_date ? `Hạn ${formatDate(t.due_date)}` : t.due_at ? `Hạn ${formatInstant(t.due_at)}` : "Không có hạn"}
                  {t.status === "done" ? " · đã xong" : ""}
                </Text>
              </View>
              {t.status === "done" ? (
                <Btn s={s} secondary label="Mở lại" onPress={() => void run(() => api.reopenTask(t.id, t.version), "Đã mở lại việc.")} />
              ) : (
                <Btn s={s} label="Xong" onPress={() => void run(() => api.completeTask(t.id, t.version), "Đã hoàn thành.")} />
              )}
            </View>
          ))}
        </Card>

        <Card theme={theme} title={`Lịch hẹn (${appts.length})`}>
          <TextInput style={s.input} placeholder="Tên lịch hẹn" placeholderTextColor={theme.colors.textMuted} value={apptTitle} onChangeText={setApptTitle} accessibilityLabel="Tên lịch hẹn" />
          <TextInput style={s.input} placeholder="Bắt đầu (yyyy-mm-dd hh:mm, giờ Việt Nam)" placeholderTextColor={theme.colors.textMuted} value={apptStart} onChangeText={setApptStart} accessibilityLabel="Giờ bắt đầu" />
          <Btn s={s} label="Thêm lịch hẹn" onPress={() => void addAppt()} />
          {appts.map((a) => (
            <View key={a.id} style={s.item} testID="appointment-item">
              <View style={s.itemMain}>
                <Text style={s.itemTitle}>{a.title}</Text>
                <Text style={s.muted}>{a.starts_at ? formatInstant(a.starts_at, a.timezone) : a.local_date ? formatDate(a.local_date) : ""}</Text>
              </View>
            </View>
          ))}
        </Card>

        <Card theme={theme} title={`Ghi chú (${notes.length})`}>
          <TextInput style={s.input} placeholder="Tiêu đề" placeholderTextColor={theme.colors.textMuted} value={noteTitle} onChangeText={setNoteTitle} accessibilityLabel="Tiêu đề ghi chú" />
          <TextInput style={[s.input, s.multiline]} multiline placeholder="Nội dung" placeholderTextColor={theme.colors.textMuted} value={noteBody} onChangeText={setNoteBody} accessibilityLabel="Nội dung ghi chú" />
          <Btn s={s} label="Lưu ghi chú" onPress={() => void addNote()} />
          {notes.map((n) => (
            <View key={n.id} style={s.item} testID="note-item">
              <View style={s.itemMain}>
                <Text style={s.itemTitle}>{n.title}</Text>
                {n.body ? <Text style={s.muted}>{n.body.slice(0, 200)}</Text> : null}
              </View>
            </View>
          ))}
        </Card>
      </ScrollView>
    </Screen>
  );
}

function Card({ theme, title, children }: { theme: Theme; title: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderWidth: 1, borderRadius: radii.md, padding: spacing.lg, gap: spacing.md }}>
      <Text style={{ color: theme.colors.text, fontSize: typography.heading, fontWeight: "700" }}>{title}</Text>
      {children}
    </View>
  );
}

function Btn({ s, label, onPress, secondary }: { s: ReturnType<typeof makeStyles>; label: string; onPress: () => void; secondary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.btn, secondary ? s.btnSecondary : null, { opacity: pressed ? 0.75 : 1 }]}>
      <Text style={[s.btnText, secondary ? s.btnTextSecondary : null]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    page: { padding: spacing.lg, gap: spacing.lg, maxWidth: 760, width: "100%", alignSelf: "center" },
    headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    title: { color: t.colors.text, fontSize: typography.title, fontWeight: "700" },
    link: { color: t.colors.primary, fontSize: typography.small },
    offline: { color: t.colors.warning, fontSize: typography.body, fontWeight: "600" },
    okMsg: { color: t.colors.success, fontSize: typography.body, fontWeight: "600" },
    errMsg: { color: t.colors.danger, fontSize: typography.body, fontWeight: "600" },
    muted: { color: t.colors.textMuted, fontSize: typography.small },
    mutedText: { color: t.colors.textMuted },
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
    itemMain: { flex: 1, gap: 2 },
    itemTitle: { color: t.colors.text, fontSize: typography.body, fontWeight: "600" },
    actions: { flexDirection: "row", gap: spacing.sm },
    btn: { backgroundColor: t.colors.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radii.md, alignItems: "center" },
    btnSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: t.colors.primary },
    btnText: { color: "#FFFFFF", fontSize: typography.body, fontWeight: "700" },
    btnTextSecondary: { color: t.colors.primary },
  });
}
