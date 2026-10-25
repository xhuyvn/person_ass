import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PickedFile } from "../lib/image-view";
import { Btn } from "./kit";
import type { ImagePickerProps } from "./ImagePicker";

/**
 * Web adapter (the only place that touches DOM events): a hidden file input,
 * clipboard paste of images anywhere on the page, and drag-and-drop.
 */

const toPicked = (files: File[]): PickedFile[] => files.map((f, i) => ({ blob: f, name: f.name || `dán-${Date.now()}-${i + 1}.${f.type.split("/")[1] ?? "png"}`, type: f.type, size: f.size }));

export function ImagePicker({ s, disabled, onFiles }: ImagePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Keep the latest callback without re-registering the document listener.
  const latest = useRef({ onFiles, disabled });
  latest.current = { onFiles, disabled };

  useEffect(() => {
    function onPaste(ev: ClipboardEvent) {
      if (latest.current.disabled) return;
      const files = Array.from(ev.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return; // plain-text paste keeps its normal behaviour
      ev.preventDefault();
      latest.current.onFiles(toPicked(files));
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  return (
    <View style={{ gap: 6 }}>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        data-testid="image-file-input"
        aria-label="Chọn ảnh"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // allow picking the same file again
          if (files.length > 0) onFiles(toPicked(files));
        }}
      />
      <div
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
          if (files.length > 0) onFiles(toPicked(files));
        }}
        style={{ border: `1px dashed ${dragging ? "#2563EB" : "#9CA3AF"}`, borderRadius: 8, padding: 8, boxSizing: "border-box", maxWidth: "100%" }}
      >
        <Btn s={s} secondary label="Thêm ảnh" disabled={disabled} onPress={() => input.current?.click()} testID="add-images" />
        <Text style={s.muted}>JPEG, PNG hoặc WebP, tối đa 10 MB, 10 ảnh mỗi memo. Có thể dán (Ctrl+V) hoặc kéo thả ảnh vào đây.</Text>
      </div>
    </View>
  );
}
