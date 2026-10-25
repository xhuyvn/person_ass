import { useState } from "react";
import { Text, View } from "react-native";
import type { SourceDetail } from "@personalass/contracts";
import type { Api } from "../lib/api";
import { IMAGE_CONTENT_PATH, describeSource } from "../lib/image-view";
import { Btn, errText, type Styles } from "./kit";
import { MemoImage } from "./MemoImages";

/** "Nguồn" button with an inline block: memo quote and, for images, the exact OCR run quoted. */
export function SourceView({ type, id, api, s }: { type: "task" | "appointment" | "note"; id: string; api: Api; s: Styles }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SourceDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      setItems(await api.sources(type, id));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <Btn s={s} secondary label={open ? "Ẩn nguồn" : "Nguồn"} onPress={() => void toggle()} testID="source-toggle" />
      {open ? (
        <View style={s.question} testID="source-block">
          {loading ? <Text style={s.muted}>Đang tải nguồn…</Text> : null}
          {error ? <Text style={s.danger}>{error}</Text> : null}
          {items && items.length === 0 ? <Text style={s.muted}>Không có nguồn được ghi nhận.</Text> : null}
          {(items ?? []).map((src, i) => {
            const v = describeSource(src);
            return (
              <View key={i} style={{ gap: 4 }}>
                {v.quote ? <Text style={s.body}>“{v.quote}”</Text> : <Text style={s.muted}>Không có trích dẫn.</Text>}
                {v.imageLabel ? <Text style={s.label}>{v.imageLabel}</Text> : null}
                {v.attachmentId ? <MemoImage url={api.attachmentUrl(IMAGE_CONTENT_PATH(v.attachmentId))} label={v.imageLabel ?? "Ảnh"} width={4} height={3} /> : null}
                {v.ocrText ? <Text style={s.body} selectable>Chữ trong ảnh: {v.ocrText}</Text> : null}
                {v.note ? <Text style={s.warn}>{v.note}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
