import { Text } from "react-native";
import type { PickedFile } from "../lib/image-view";
import type { Styles } from "./kit";

export type ImagePickerProps = {
  s: Styles;
  disabled?: boolean;
  onFiles: (files: PickedFile[]) => void;
};

/** Native fallback: adding images is only implemented on web for now. */
export function ImagePicker({ s }: ImagePickerProps) {
  return (
    <Text style={s.muted} testID="image-picker-unsupported">
      Chưa hỗ trợ thêm ảnh trên ứng dụng này
    </Text>
  );
}
