import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View, type ScrollViewInstance } from "react-native";
import { Link } from "expo-router";
import type { AiConnection, AiConnectionKind, AiModel, AiRole, AiRoleBinding } from "@personalass/contracts";
import { Screen } from "@personalass/ui";
import { Btn, Card, Check, Choice, Field, errText, useScreenKit, type Msg } from "./kit";

/**
 * AI settings (docs/04 §1): connections, connection test, model list or
 * manual model id, role bindings with ordered fallback. The API key is
 * write-only: typed here, sent once, never shown again (only a masked hint).
 */

const KINDS: ReadonlyArray<{ value: AiConnectionKind; label: string }> = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "ollama_local", label: "Ollama (máy này/LAN)" },
  { value: "ollama_cloud", label: "Ollama Cloud" },
  { value: "custom_openai", label: "OpenAI-compatible khác" },
];

/** Example URLs only; the owner can type any URL the backend policy allows. */
const KIND_DEFAULTS: Record<AiConnectionKind, { url: string; scope: "local" | "cloud"; needsKey: boolean }> = {
  openrouter: { url: "https://openrouter.ai/api/v1", scope: "cloud", needsKey: true },
  ollama_local: { url: "http://127.0.0.1:11434/v1", scope: "local", needsKey: false },
  ollama_cloud: { url: "https://ollama.com/v1", scope: "cloud", needsKey: true },
  custom_openai: { url: "", scope: "cloud", needsKey: true },
};

const ROLES: ReadonlyArray<{ value: AiRole; label: string; hint: string }> = [
  { value: "information", label: "Xử lý thông tin", hint: "Đọc memo, đề xuất việc/lịch/ghi chú." },
  { value: "ocr", label: "Đọc chữ trong ảnh (OCR)", hint: "Phải là model đọc được ảnh (vision). Bấm “Test ảnh” ở kết nối để kiểm tra." },
  { value: "assistant", label: "Trợ lý hỏi đáp", hint: "Dùng ở bản sau." },
];

const SCOPES = [
  { value: "local", label: "Cục bộ (local)" },
  { value: "cloud", label: "Cloud" },
] as const;

export function AiSettings() {
  const { theme, api, s } = useScreenKit();
  const [conns, setConns] = useState<AiConnection[]>([]);
  const [roles, setRoles] = useState<AiRoleBinding[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const scroll = useRef<ScrollViewInstance>(null);

  // Feedback is shown at the top; bring it into view after any action.
  useEffect(() => {
    if (msg) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [msg]);

  const refresh = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([api.listConnections(), api.listRoles()]);
      setConns(c);
      setRoles(r);
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  /* ---- new connection ---- */
  const [kind, setKind] = useState<AiConnectionKind>("openrouter");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(KIND_DEFAULTS.openrouter.url);
  const [apiKey, setApiKey] = useState("");
  const [scope, setScope] = useState<"local" | "cloud">("cloud");
  const [timeoutS, setTimeoutS] = useState("120");

  function pickKind(k: AiConnectionKind) {
    setKind(k);
    setBaseUrl(KIND_DEFAULTS[k].url);
    setScope(KIND_DEFAULTS[k].scope);
  }

  async function addConnection() {
    const seconds = Number(timeoutS);
    if (!name.trim()) return setMsg({ kind: "error", text: "Đặt tên cho kết nối." });
    if (!baseUrl.trim()) return setMsg({ kind: "error", text: "Nhập Base URL." });
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
      return setMsg({ kind: "error", text: "Timeout phải là số giây từ 1 đến 900." });
    }
    const ok = await run(
      () =>
        api.createConnection({
          name: name.trim(),
          kind,
          base_url: baseUrl.trim(),
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          privacy_scope: scope,
          enabled: true,
          timeout_ms: seconds * 1000,
          structured_output: "auto",
        }),
      "Đã thêm kết nối. Bấm “Test” để kiểm tra.",
    );
    if (ok) {
      setName("");
      setApiKey("");
    }
  }

  return (
    <Screen padded={false}>
      <ScrollView ref={scroll} contentContainerStyle={s.page}>
        <View style={s.headerRow}>
          <Text style={s.title}>Cài đặt AI</Text>
          <Link href="/" style={s.link}>
            ← Về trang chính
          </Link>
        </View>
        {msg ? (
          <Text style={msg.kind === "ok" ? s.okMsg : s.errMsg} testID="message" accessibilityRole="alert">
            {msg.text}
          </Text>
        ) : null}

        <Card theme={theme} title={`Kết nối (${conns.length})`} testID="connections">
          {conns.length === 0 ? <Text style={s.muted}>Chưa có kết nối nào. Memo vẫn được lưu và chờ cấu hình.</Text> : null}
          {conns.map((c) => (
            <ConnectionRow key={c.id} conn={c} onChanged={refresh} setMsg={setMsg} />
          ))}
        </Card>

        <Card theme={theme} title="Thêm kết nối">
          <Choice s={s} label="Loại kết nối" options={KINDS} value={kind} onChange={pickKind} />
          <Field s={s} theme={theme} label="Tên" value={name} onChangeText={setName} placeholder="Ví dụ: Ollama máy bàn" />
          <Field s={s} theme={theme} label="Base URL" value={baseUrl} onChangeText={setBaseUrl} placeholder="https://… hoặc http://192.168.x.x:11434/v1" />
          <Field
            s={s}
            theme={theme}
            label={KIND_DEFAULTS[kind].needsKey ? "API key" : "API key (không bắt buộc với Ollama local)"}
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            placeholder="Chỉ gửi lên máy chủ khi lưu, không hiển thị lại"
          />
          <Text style={s.label}>Phạm vi riêng tư</Text>
          <Choice s={s} label="Phạm vi riêng tư" options={SCOPES} value={scope} onChange={setScope} />
          <Text style={s.muted}>
            Memo “chỉ xử lý cục bộ” chỉ được gửi tới kết nối Cục bộ. Chọn Cục bộ chỉ khi chắc chắn endpoint không chuyển dữ liệu lên cloud.
          </Text>
          <Field s={s} theme={theme} label="Timeout (giây)" value={timeoutS} onChangeText={setTimeoutS} keyboardType="numeric" />
          <Btn s={s} label="Lưu kết nối" onPress={() => void addConnection()} testID="add-connection" />
        </Card>

        <RolesCard conns={conns} roles={roles} onSaved={refresh} setMsg={setMsg} />
      </ScrollView>
    </Screen>
  );
}

function ConnectionRow({ conn, onChanged, setMsg }: { conn: AiConnection; onChanged: () => Promise<void>; setMsg: (m: Msg) => void }) {
  const { theme, api, s } = useScreenKit();
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [testModel, setTestModel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [editing, setEditing] = useState(false);

  async function test(kind: "metadata" | "text" | "image") {
    if (kind !== "metadata" && !testModel.trim()) return setResult(kind === "image" ? "Nhập model id để test ảnh." : "Nhập model id để test text.");
    setBusy(true);
    setResult("Đang kiểm tra…");
    try {
      const r = await api.testConnection(conn.id, kind, kind !== "metadata" ? testModel.trim() : undefined);
      setResult(
        r.ok
          ? kind === "metadata"
            ? `OK · ${r.models_count ?? 0} model · ${r.latency_ms ?? "?"} ms`
            : kind === "image"
              ? `OK · model đọc được ảnh (trả lời “${r.sample ?? ""}”) · ${r.latency_ms ?? "?"} ms`
              : `OK · model trả lời “${r.sample ?? ""}” · ${r.latency_ms ?? "?"} ms`
          : r.error?.code === "no_image_input"
            ? "Model này không nhận ảnh (no_image_input). Chọn model có khả năng đọc ảnh cho vai trò OCR."
            : `Lỗi (${r.error?.code}): ${r.error?.message}`,
      );
    } catch (e) {
      setResult(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadModels() {
    setBusy(true);
    try {
      const r = await api.listModels(conn.id);
      setModels(r.items);
      setResult(r.error ? `Không tải được danh sách model (${r.error.message}). Có thể nhập model id bằng tay.` : `${r.items.length} model.`);
    } catch (e) {
      setResult(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function patch(input: Record<string, unknown>, okText: string) {
    try {
      await api.patchConnection(conn.id, { expected_version: conn.version, ...input });
      setMsg({ kind: "ok", text: okText });
      setNewKey("");
      setEditing(false);
      await onChanged();
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }

  return (
    <View style={s.block} testID="connection-item">
      <Text style={[s.itemTitle, conn.enabled ? null : s.mutedText]}>
        {conn.name} {conn.enabled ? "" : "(đang tắt)"}
      </Text>
      <Text style={s.muted}>
        {KINDS.find((k) => k.value === conn.kind)?.label} · {conn.base_url} · {conn.privacy_scope === "local" ? "Cục bộ" : "Cloud"} ·{" "}
        {conn.key_configured ? `key ${conn.key_label ?? "đã lưu"}` : "không có key"}
      </Text>
      <View style={s.actions}>
        <Btn s={s} secondary label="Test" disabled={busy} onPress={() => void test("metadata")} />
        <Btn s={s} secondary label="Tải model" disabled={busy} onPress={() => void loadModels()} />
        <Btn s={s} secondary label={conn.enabled ? "Tắt" : "Bật"} onPress={() => void patch({ enabled: !conn.enabled }, conn.enabled ? "Đã tắt kết nối." : "Đã bật kết nối.")} />
        <Btn s={s} secondary label="Đổi key" onPress={() => setEditing(!editing)} />
      </View>
      {editing ? (
        <View style={{ gap: 8 }}>
          <Field s={s} theme={theme} label="API key mới" value={newKey} onChangeText={setNewKey} secureTextEntry />
          <View style={s.actions}>
            <Btn s={s} label="Lưu key" disabled={!newKey.trim()} onPress={() => void patch({ api_key: newKey.trim() }, "Đã thay API key.")} />
            {conn.key_configured ? <Btn s={s} secondary label="Xóa key" onPress={() => void patch({ clear_api_key: true }, "Đã xóa API key.")} /> : null}
          </View>
        </View>
      ) : null}
      <View style={s.actions}>
        <View style={{ flex: 1, minWidth: 200 }}>
          <Field s={s} theme={theme} label="Model để test (text/ảnh)" value={testModel} onChangeText={setTestModel} placeholder="model id" />
        </View>
        <View style={{ justifyContent: "flex-end" }}>
          <View style={s.actions}>
            <Btn s={s} secondary label="Test text" disabled={busy} onPress={() => void test("text")} />
            <Btn s={s} secondary label="Test ảnh" disabled={busy} onPress={() => void test("image")} testID="test-image" />
          </View>
        </View>
      </View>
      {models && models.length > 0 ? (
        <Choice
          s={s}
          label="Chọn model để test"
          options={models.slice(0, 40).map((m) => ({ value: m.id, label: m.capabilities.image_input === "yes" ? `${m.id} 🖼` : m.id }))}
          value={testModel || null}
          onChange={setTestModel}
        />
      ) : null}
      {result ? (
        <Text style={result.startsWith("OK") ? s.success : s.muted} testID="connection-test-result">
          {result}
        </Text>
      ) : null}
    </View>
  );
}

function RolesCard({ conns, roles, onSaved, setMsg }: { conns: AiConnection[]; roles: AiRoleBinding[]; onSaved: () => Promise<void>; setMsg: (m: Msg) => void }) {
  const { theme, api, s } = useScreenKit();
  const [role, setRole] = useState<AiRole>("information");
  const [connId, setConnId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [fbConn, setFbConn] = useState<string>("none");
  const [fbModel, setFbModel] = useState("");
  const [allowCloud, setAllowCloud] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);

  // Load the saved binding of the selected role into the form.
  useEffect(() => {
    const b = roles.find((r) => r.role === role);
    setConnId(b?.connection_id ?? null);
    setModelId(b?.model_id ?? "");
    setFbConn(b?.fallback.bindings[0]?.connection_id ?? "none");
    setFbModel(b?.fallback.bindings[0]?.model_id ?? "");
    setAllowCloud(b?.fallback.allow_cloud ?? false);
    setModels([]);
  }, [role, roles]);

  async function loadModels(id: string) {
    try {
      const r = await api.listModels(id);
      setModels(r.items);
      if (r.error) setMsg({ kind: "error", text: `Không tải được model: ${r.error.message}. Nhập model id bằng tay.` });
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }

  async function save() {
    if (!connId) return setMsg({ kind: "error", text: "Chọn kết nối cho vai trò." });
    if (!modelId.trim()) return setMsg({ kind: "error", text: "Nhập hoặc chọn model id." });
    if (fbConn !== "none" && !fbModel.trim()) return setMsg({ kind: "error", text: "Nhập model cho kết nối dự phòng." });
    try {
      await api.putRoles([
        {
          role,
          connection_id: connId,
          model_id: modelId.trim(),
          fallback: {
            bindings: fbConn === "none" ? [] : [{ connection_id: fbConn, model_id: fbModel.trim() }],
            allow_cloud: allowCloud,
          },
        },
      ]);
      setMsg({ kind: "ok", text: "Đã lưu vai trò. Memo đang chờ cấu hình sẽ được xử lý lại." });
      await onSaved();
    } catch (e) {
      setMsg({ kind: "error", text: errText(e) });
    }
  }

  const connOptions = conns.map((c) => ({ value: c.id, label: `${c.name}${c.enabled ? "" : " (tắt)"}` }));
  const primary = conns.find((c) => c.id === connId);
  const fallback = conns.find((c) => c.id === fbConn);
  const label = (r: AiRoleBinding) => `${conns.find((c) => c.id === r.connection_id)?.name ?? "?"} · ${r.model_id}`;

  return (
    <Card theme={theme} title="Vai trò AI" testID="roles">
      {roles.length === 0 ? <Text style={s.warn}>Chưa gán model cho vai trò nào: memo sẽ được lưu và chờ cấu hình.</Text> : null}
      {roles.map((r) => (
        <Text key={r.role} style={s.muted}>
          {ROLES.find((x) => x.value === r.role)?.label}: {label(r)}
          {r.fallback.bindings.length > 0 ? ` → dự phòng ${conns.find((c) => c.id === r.fallback.bindings[0]?.connection_id)?.name ?? "?"}` : ""}
        </Text>
      ))}
      <Choice s={s} label="Vai trò" options={ROLES} value={role} onChange={setRole} />
      <Text style={s.muted}>{ROLES.find((r) => r.value === role)?.hint}</Text>
      {conns.length === 0 ? (
        <Text style={s.muted}>Thêm một kết nối trước.</Text>
      ) : (
        <>
          <Text style={s.label}>Kết nối chính</Text>
          <Choice s={s} label="Kết nối chính" options={connOptions} value={connId} onChange={setConnId} />
          <View style={s.actions}>
            <View style={{ flex: 1, minWidth: 200 }}>
              <Field s={s} theme={theme} label="Model id" value={modelId} onChangeText={setModelId} placeholder="nhập tay hoặc tải danh sách" />
            </View>
            <View style={{ justifyContent: "flex-end" }}>
              <Btn s={s} secondary label="Tải model" disabled={!connId} onPress={() => connId && void loadModels(connId)} />
            </View>
          </View>
          {models.length > 0 ? (
            <Choice s={s} label="Model" options={models.slice(0, 40).map((m) => ({ value: m.id, label: m.id }))} value={modelId || null} onChange={setModelId} />
          ) : null}
          <Text style={s.label}>Dự phòng khi kết nối chính lỗi</Text>
          <Choice s={s} label="Kết nối dự phòng" options={[{ value: "none", label: "Không" }, ...connOptions.filter((o) => o.value !== connId)]} value={fbConn} onChange={setFbConn} />
          {fbConn !== "none" ? <Field s={s} theme={theme} label="Model id dự phòng" value={fbModel} onChangeText={setFbModel} /> : null}
          <Check s={s} checked={allowCloud} onChange={setAllowCloud} label="Cho phép dự phòng từ kết nối cục bộ sang cloud" />
          {primary?.privacy_scope === "local" && fallback?.privacy_scope === "cloud" && !allowCloud ? (
            <Text style={s.warn}>Kết nối dự phòng là cloud nhưng chưa cho phép: sẽ không được dùng khi kết nối chính là cục bộ.</Text>
          ) : null}
          <Text style={s.muted}>Memo “chỉ xử lý cục bộ” không bao giờ được gửi lên cloud, kể cả khi bật ô trên.</Text>
          <Btn s={s} label="Lưu vai trò" onPress={() => void save()} testID="save-role" />
        </>
      )}
    </Card>
  );
}
