import { useState } from "react";
import { Image, Text, View } from "react-native";
import type { Attachment, MemoDetail } from "@personalass/contracts";
import type { Theme } from "@personalass/ui";
import { ApiClientError, type Api } from "../lib/api";
import { CORRECTION_CONFLICT_TEXT, describeCorrectionResult, describeOcr, splitOcrText } from "../lib/image-view";
import { Btn, Field, errText, type Styles } from "./kit";

type Run = (action: () => Promise<unknown>, okText: string) => Promise<boolean>;

/** Images of a memo (in order), each with its OCR state and an inline correction form. */
export function MemoImages({ memo, api, run, s, theme }: { memo: MemoDetail; api: Api; run: Run; s: Styles; theme: Theme }) {
  if (memo.attachments.length === 0) return null;
  const sorted = [...memo.attachments].sort((a, b) => a.position - b.position);
  return (
    <View style={{ gap: 12 }} testID="memo-images">
      {sorted.map((att) => (
        <ImageWithOcr key={att.id} att={att} api={api} run={run} s={s} theme={theme} />
      ))}
    </View>
  );
}

/** Constrained image: scales down to the screen width, never wider than 360 px. */
export function MemoImage({ url, label, width, height }: { url: string; label: string; width: number; height: number }) {
  return (
    <Image
      source={{ uri: url }}
      accessibilityLabel={label}
      resizeMode="contain"
      style={{ width: "100%", maxWidth: 360, aspectRatio: width > 0 && height > 0 ? width / height : 1, maxHeight: 480, borderRadius: 6, backgroundColor: "#00000010" }}
    />
  );
}

function ImageWithOcr({ att, api, run, s, theme }: { att: Attachment; api: Api; run: Run; s: Styles; theme: Theme }) {
  const n = att.position + 1;
  const view = describeOcr(att.ocr);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<{ kind: "ok" | "error"; text: string; reload?: boolean } | null>(null);
  const tone = view.tone === "ok" ? s.success : view.tone === "warn" ? s.warn : view.tone === "error" ? s.danger : s.muted;
  const segments = splitOcrText(view.text, view.uncertain.map((u) => u.fragment));

  async function save() {
    const text = draft.trim();
    if (!text) return setLocal({ kind: "error", text: "Nhập chữ đã sửa." });
    setBusy(true);
    try {
      const r = await api.correctOcr(att.id, { text, expected_run_id: att.ocr?.id ?? null });
      const okText = describeCorrectionResult(r.reprocess);
      setEditing(false);
      setLocal({ kind: "ok", text: okText });
      await run(async () => undefined, okText);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409) setLocal({ kind: "error", text: CORRECTION_CONFLICT_TEXT, reload: true });
      else setLocal({ kind: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    await run(async () => undefined, "Đã tải lại.");
    setLocal(null);
    setEditing(false);
  }

  return (
    <View style={{ gap: 6 }} testID="memo-image">
      <MemoImage url={api.attachmentUrl(att.content_path)} label={`Ảnh #${n}`} width={att.width} height={att.height} />
      <Text style={s.label}>Ảnh #{n}</Text>
      <Text style={tone} testID="ocr-status">
        {view.status}
        {view.author ? ` · ${view.author}` : ""}
      </Text>
      {view.text ? (
        <Text style={s.body} testID="ocr-text" selectable>
          {segments.map((seg, i) =>
            seg.uncertain ? (
              <Text key={i} style={{ fontWeight: "700", textDecorationLine: "underline", color: theme.colors.warning }}>
                {seg.text}
              </Text>
            ) : (
              <Text key={i}>{seg.text}</Text>
            ),
          )}
        </Text>
      ) : null}
      {view.uncertain.map((u, i) => (
        <Text key={i} style={s.warn} testID="ocr-uncertain">
          {u.line}
        </Text>
      ))}
      {local ? (
        <Text style={local.kind === "ok" ? s.success : s.danger} accessibilityRole="alert">
          {local.text}
        </Text>
      ) : null}
      {local?.reload ? <Btn s={s} secondary label="Tải lại" onPress={() => void reload()} /> : null}
      {editing ? (
        <View style={{ gap: 6 }}>
          <Field s={s} theme={theme} label={`Chữ trong ảnh #${n}`} value={draft} onChangeText={setDraft} multiline style={[s.input, s.multiline]} autoCapitalize="sentences" />
          <View style={s.actions}>
            <Btn s={s} label={busy ? "Đang lưu…" : "Lưu chữ đã sửa"} disabled={busy} onPress={() => void save()} testID="ocr-save" />
            <Btn s={s} secondary label="Hủy" disabled={busy} onPress={() => setEditing(false)} />
          </View>
        </View>
      ) : (
        <View style={s.actions}>
          <Btn
            s={s}
            secondary
            label="Sửa chữ"
            testID="ocr-edit"
            onPress={() => {
              setDraft(att.ocr?.text ?? "");
              setLocal(null);
              setEditing(true);
            }}
          />
        </View>
      )}
    </View>
  );
}
