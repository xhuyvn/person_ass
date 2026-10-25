import { useState } from "react";
import { Text, View } from "react-native";
import { Link } from "expo-router";
import type { Clarification, MemoDetail, ProposalAction } from "@personalass/contracts";
import type { Theme } from "@personalass/ui";
import type { Api } from "../lib/api";
import { formatInstant } from "../lib/format";
import { answerFields, buildAnswerFields, describeAction, describeJob, describeStatus, undoGroups } from "../lib/memo-view";
import { Btn, Choice, Field, type Styles } from "./kit";

type Run = (action: () => Promise<unknown>, okText: string) => Promise<boolean>;

/**
 * Recent memos with their AI processing state: what was applied (with undo),
 * what needs an answer, and what was rejected and why (docs/04 §4: the UI
 * summarizes partial results while clarifications remain).
 */
type TitleOf = (id: string | null) => string | null;

export function MemoFeed({ memos, api, run, s, theme, titleOf }: { memos: MemoDetail[]; api: Api; run: Run; s: Styles; theme: Theme; titleOf: TitleOf }) {
  if (memos.length === 0) return <Text style={s.muted}>Chưa có memo.</Text>;
  return (
    <>
      {memos.map((m) => (
        <MemoItem key={m.id} memo={m} api={api} run={run} s={s} theme={theme} titleOf={titleOf} />
      ))}
    </>
  );
}

function MemoItem({ memo, api, run, s, theme, titleOf }: { memo: MemoDetail; api: Api; run: Run; s: Styles; theme: Theme; titleOf: TitleOf }) {
  const job = describeJob(memo.job);
  const tone = job.tone === "ok" ? s.success : job.tone === "warn" ? s.warn : job.tone === "error" ? s.danger : s.muted;
  const open = memo.clarifications.filter((c) => c.state === "open");
  const groups = undoGroups(memo.actions);
  const shownUndo = new Set<string>();
  const actionsById = new Map(memo.actions.map((a) => [a.id, a]));

  return (
    <View style={s.block} testID="memo-item">
      <Text style={s.body}>{memo.revision?.raw_text ?? ""}</Text>
      <Text style={s.muted}>
        {memo.revision ? formatInstant(memo.revision.captured_at) : ""}
        {memo.privacy === "local_only" ? " · chỉ xử lý cục bộ" : ""}
      </Text>
      <Text style={tone} testID="memo-job-state">
        {job.text}
      </Text>
      {job.needsSettings ? (
        <Link href="/settings" style={s.link}>
          Mở Cài đặt AI
        </Link>
      ) : null}

      {open.map((c) => (
        <ClarificationForm key={c.id} c={c} action={actionsById.get(c.proposal_action_id)} api={api} run={run} s={s} theme={theme} titleOf={titleOf} />
      ))}

      {memo.actions
        .filter((a) => a.status !== "needs_clarification")
        .map((a) => {
          const group = a.action_group_id && groups.has(a.action_group_id) && !shownUndo.has(a.action_group_id) ? a.action_group_id : null;
          if (group) shownUndo.add(group);
          return <ActionRow key={a.id} a={a} title={titleOf(a.target_id)} undoGroup={group} undoCount={group ? (groups.get(group) ?? 1) : 0} api={api} run={run} s={s} />;
        })}

      {job.canReprocess && memo.job ? (
        <View style={s.actions}>
          <Btn s={s} secondary label="Xử lý lại" onPress={() => void run(() => api.reprocessMemo(memo.id), "Đã xếp hàng xử lý lại; mục đã tạo sẽ không bị tạo trùng.")} />
        </View>
      ) : null}
    </View>
  );
}

function ActionRow({ a, title, undoGroup, undoCount, api, run, s }: { a: ProposalAction; title: string | null; undoGroup: string | null; undoCount: number; api: Api; run: Run; s: Styles }) {
  const applied = a.status === "applied" && a.reason !== "undone";
  return (
    <View style={s.item} testID="memo-action">
      <View style={s.itemMain}>
        <Text style={[s.itemTitle, applied ? null : s.mutedText]}>{describeAction(a, title)}</Text>
        <Text style={applied ? s.success : s.muted}>{describeStatus(a)}</Text>
      </View>
      {undoGroup ? (
        <Btn
          s={s}
          secondary
          label={undoCount > 1 ? `Hoàn tác (${undoCount})` : "Hoàn tác"}
          testID="undo"
          onPress={() => void run(() => api.undoActionGroup(undoGroup), "Đã hoàn tác.")}
        />
      ) : null}
    </View>
  );
}

function ClarificationForm({ c, action, api, run, s, theme, titleOf }: { c: Clarification; action: ProposalAction | undefined; api: Api; run: Run; s: Styles; theme: Theme; titleOf: TitleOf }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fields = c.kind === "missing_fields" ? answerFields(c, action) : [];

  async function submit() {
    setError(null);
    if (c.kind === "missing_fields") {
      const built = buildAnswerFields(fields, values);
      if ("error" in built) return setError(built.error);
      await run(() => api.answerClarification(c.id, c.version, { fields: built.fields }), "Đã áp dụng câu trả lời.");
    } else if (c.kind === "choose_target") {
      if (!choice) return setError("Chọn một mục.");
      await run(() => api.answerClarification(c.id, c.version, { choice }), "Đã áp dụng cho mục bạn chọn.");
    } else {
      await run(() => api.answerClarification(c.id, c.version, { confirm: true }), "Đã xác nhận và áp dụng.");
    }
  }

  return (
    <View style={s.question} testID="clarification">
      {action ? <Text style={s.itemTitle}>{describeAction(action, titleOf(action.target_id))}</Text> : null}
      <Text style={s.body}>{c.question}</Text>
      {fields.map((f) => (
        <Field
          key={f.path}
          s={s}
          theme={theme}
          label={f.label}
          placeholder={f.placeholder}
          value={values[f.path] ?? ""}
          onChangeText={(v) => setValues({ ...values, [f.path]: v })}
        />
      ))}
      {c.kind === "choose_target" ? (
        c.options.length > 0 ? (
          <Choice s={s} label="Chọn mục" options={c.options} value={choice} onChange={setChoice} />
        ) : (
          <Text style={s.muted}>Không có mục nào để chọn; hãy bỏ qua.</Text>
        )
      ) : null}
      {error ? <Text style={s.danger}>{error}</Text> : null}
      <View style={s.actions}>
        <Btn
          s={s}
          label={c.kind === "missing_fields" ? "Lưu" : c.kind === "choose_target" ? "Áp dụng" : "Xác nhận"}
          testID="clarification-submit"
          onPress={() => void submit()}
        />
        <Btn s={s} secondary label="Bỏ qua" onPress={() => void run(() => api.answerClarification(c.id, c.version, { dismiss: true }), "Đã bỏ qua.")} />
      </View>
    </View>
  );
}
