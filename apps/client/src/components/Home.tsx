import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Link } from "expo-router";
import type { Appointment, MemoDetail, Note, Notification, Task } from "@personalass/contracts";
import { Screen } from "@personalass/ui";
import { newUuid } from "../lib/api";
import {
  DEFAULT_TIMEZONE,
  formatDate,
  formatInstant,
  localDateTimeToIso,
  parseDateInput,
} from "../lib/format";
import { describeJob } from "../lib/memo-view";
import { Btn, Card, Check, errText, useScreenKit, type Msg } from "./kit";
import { MemoFeed } from "./MemoFeed";

const POLL_MS = 15000;
/** Faster refresh while a memo job is queued/running so results show up quickly. */
const ACTIVE_POLL_MS = 3000;

export function Home() {
  const { theme, api, s } = useScreenKit();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [memos, setMemos] = useState<MemoDetail[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [t, n, a, no, me] = await Promise.all([
        api.listTasks(),
        api.listNotes(),
        api.listAppointments(),
        api.listNotifications(false),
        api.listMemos(10),
      ]);
      setMemos(me);
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

  // While a memo is being processed, refresh everything (new tasks, questions).
  const processing = memos.some((m) => describeJob(m.job).active);
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void refresh(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [processing, refresh]);

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
  const [useAi, setUseAi] = useState(true);
  const [localOnly, setLocalOnly] = useState(false);

  async function saveMemo() {
    const text = memoText.trim();
    if (!text) return setMsg({ kind: "error", text: "Nhập nội dung memo." });
    const ok = await run(async () => {
      const receipt = await api.createMemo(text, new Date().toISOString(), DEFAULT_TIMEZONE, memoRequestId.current, {
        process: useAi,
        privacy: localOnly ? "local_only" : "default",
      });
      setLastMemo({ revisionId: receipt.revision_id, text });
    }, useAi ? "Đã lưu memo; AI đang xử lý, kết quả hiện ở mục Memo gần đây." : "Đã lưu memo.");
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

  const titleOf = (id: string | null): string | null =>
    id ? (appts.find((a) => a.id === id)?.title ?? tasks.find((t) => t.id === id)?.title ?? null) : null;

  const unread = notifs.filter((n) => n.state !== "acknowledged");

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={s.page}>
        <View style={s.headerRow}>
          <Text style={s.title}>PersonalAss</Text>
          <View style={s.links}>
            <Link href="/settings" style={s.link}>
              Cài đặt AI
            </Link>
            <Link href="/status" style={s.link}>
              Trạng thái máy chủ
            </Link>
          </View>
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
          <Check s={s} checked={useAi} onChange={setUseAi} label="Để AI tạo việc/lịch/ghi chú từ memo" />
          {useAi ? <Check s={s} checked={localOnly} onChange={setLocalOnly} label="Chỉ xử lý cục bộ (không gửi lên cloud)" /> : null}
          <Btn s={s} label="Lưu memo" onPress={() => void saveMemo()} testID="save-memo" />
          <Text style={s.muted}>
            Memo luôn được lưu nguyên văn trước. AI chỉ tự áp dụng phần rõ ràng; phần chưa chắc sẽ hỏi bạn ở mục bên dưới, và mọi thay đổi của AI đều hoàn tác được.
          </Text>
        </Card>

        <Card theme={theme} title="Memo gần đây" testID="memo-feed">
          <MemoFeed memos={memos} api={api} run={run} s={s} theme={theme} titleOf={titleOf} />
        </Card>

        <Card theme={theme} title={`Việc (${tasks.length})`}>
          <TextInput style={s.input} placeholder="Tên việc" placeholderTextColor={theme.colors.textMuted} value={taskTitle} onChangeText={setTaskTitle} accessibilityLabel="Tên việc" />
          <TextInput style={s.input} placeholder="Hạn (dd/mm/yyyy, để trống nếu không có)" placeholderTextColor={theme.colors.textMuted} value={taskDue} onChangeText={setTaskDue} accessibilityLabel="Hạn việc" />
          {lastMemo ? (
            <Check s={s} checked={attach} onChange={setAttach} label="Gắn nguồn từ memo vừa lưu" />
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

