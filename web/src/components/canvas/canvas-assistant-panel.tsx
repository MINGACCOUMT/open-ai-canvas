import { Button, Modal } from "antd";
import { Tooltip } from "@/components/ui/base/tooltip";
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { motion } from "motion/react";

import { resolveModelRequestConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { nanoid } from "nanoid";
import { type ResponseInputMessage, type ResponseToolCall } from "@/services/api/image";
import { consumeGenerationTaskAgent } from "@/services/project-asset-sync";
import { applyGenerationConsumerEffect, generationEffectApplied } from "@/services/generation-consumer-dedupe";
import { activeGenerationConsumerController } from "@/services/generation-consumer-lifecycle";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { navigateToSettings } from "@/lib/settings-navigation";
import { cinematicAgentSessionOpsJson, createCinematicAgentSession, isAgentSessionPollingAbort, resumeCinematicAgentSession } from "@/lib/canvas/canvas-agent-session";
import { summarizeCanvasContext } from "@/lib/canvas/canvas-context-summary";
import { AgentChatComposer, AgentChatMessage, AgentWorkingMessage, type CanvasAgentMode } from "./canvas-agent-chat-ui";
import { VoiceRecordingButton } from "@/components/conversation/voice-recording-button";
import { AgentChatEmptyState, AgentPanelChrome } from "./canvas-agent-panel-chrome";
import { CanvasLocalAgentPanel } from "./canvas-local-agent-panel";
import { useResolvedCanvasResourceReferences } from "./use-resolved-canvas-resource-references";
import { type CanvasAssistantMessage, type CanvasAssistantPendingBackendSession, type CanvasAssistantReference, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";
import { canvasAgentPostconditionMessage, summarizeCanvasAgentOps, verifyCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { buildCanvasAgentContext, findCanvasAgentNodes, getCanvasAgentConnection, getCanvasAgentGenerationTasks, getCanvasAgentNode, getCanvasAgentResources, validateCanvasAgentOps } from "@/lib/canvas/canvas-agent-context";
import { resolveStoryboardGenerationContext } from "@/lib/canvas/canvas-storyboard-context";
import { isWritableToolCall } from "@/lib/canvas/canvas-agent-protocol";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { buildSkillMentionReferences, skillRuntime } from "@/services/skill-runtime";
import { handleCinematicContinuationFailure, canvasCinematicContinuationEntryAdapters, type CinematicContinuationFailureDisposition, type CinematicContinuationLiveSessionState } from "./canvas-cinematic-continuation";
import { AgentTextModelPicker, AssistantHistory, AssistantReferenceChip, MessageReferences, assistantImageReferenceLabel, assistantMessageToChatMessage, assistantReferencesToMentionReferences, promptAlreadyHasMention } from "./canvas-assistant-panel-views";
import { backendAgentProviderConfig, buildAssistantReferences, buildToolAgentMessages, cinematicSessionMessageId, compactSnapshot, createSession, describeCanvasSnapshot, explainNoop, nodeToReference, objectDetail, onlineToolToOps, parseToolArguments, previewOnlineToolCalls, requestOnlineAgentModel, requireOps, requireString, snapshotSignature, summarizeToolCalls, toolCallToResponseInput, toolCallsFromDetail, toolResultText, upsertAssistantMessage, type OnlineToolResult } from "./canvas-assistant-online-tools";

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = CANVAS_AGENT_PANEL_MOTION_MS / 1000;
const ONLINE_AGENT_MAX_STEPS = 8;

type OnlineAgentTab = "chat" | "history";
type OnlineLoopContext = { step: number };
type OnlineExecutedToolCall = { toolCallId: string; name: string; result: OnlineToolResult };
type PendingOnlineToolContext = { messages: ResponseInputMessage[]; toolCalls: ResponseToolCall[]; assistantId: string; step: number };
type CanvasAssistantPanelProps = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    snapshot: CanvasAgentSnapshot;
    projectId: string;
    sessions: CanvasAssistantSession[];
    activeSessionId: string | null;
    onSelectNodeIds: (ids: Set<string>) => void;
    onSessionsChange: (sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    onApplyOps: (ops?: CanvasAgentOp[], context?: { conversationId?: string; messageId?: string; source?: "online" | "local" }) => Promise<CanvasAgentSnapshot>;
    canUndoOps: boolean;
    undoOpsCount: number;
    onUndoOps: () => CanvasAgentSnapshot | null;
    onPasteImage: (file: File) => void;
    agentMode: CanvasAgentMode;
    onAgentModeChange: (mode: CanvasAgentMode) => void;
    autoConnectLocal?: boolean;
    closing: boolean;
    onCollapse: () => void;
    cinematicEntry?: boolean;
    onCinematicEntryConsumed?: () => void;
    resizing?: boolean;
};

export { handleCinematicContinuationFailure, runCanvasCinematicContinuationBoundary, canvasCinematicContinuationEntryAdapters } from "./canvas-cinematic-continuation";
export type { CinematicContinuationFailureDisposition } from "./canvas-cinematic-continuation";
export function CanvasAssistantPanel({
    nodes,
    selectedNodeIds,
    snapshot,
    projectId,
    sessions,
    activeSessionId,
    onSelectNodeIds,
    onSessionsChange,
    onApplyOps,
    canUndoOps,
    undoOpsCount,
    onUndoOps,
    onPasteImage,
    agentMode,
    onAgentModeChange,
    autoConnectLocal,
    closing,
    onCollapse,
    cinematicEntry = false,
    onCinematicEntryConsumed,
    resizing = false,
}: CanvasAssistantPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const effectiveConfig = useEffectiveConfig();
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const confirmTools = useCanvasAgentStore((state) => state.confirmTools);
    const setAgentState = useCanvasAgentStore((state) => state.setAgentState);
    const [view, setView] = useState<OnlineAgentTab>("chat");
    const [prompt, setPrompt] = useState("");
    const [cinematicEntryActive, setCinematicEntryActive] = useState(cinematicEntry);
    const [isRunning, setIsRunning] = useState(false);
    const [deleteChatIds, setDeleteChatIds] = useState<string[]>([]);
    const [composerSkills, setComposerSkills] = useState<Skill[]>([]);
    const [attachedReferenceIds, setAttachedReferenceIds] = useState<Set<string>>(() => new Set());
    const [localSessions, setLocalSessions] = useState<CanvasAssistantSession[]>(() => (sessions.length ? sessions : [createSession()]));
    const localSessionsRef = useRef(localSessions);
    const [localActiveSessionId, setLocalActiveSessionIdState] = useState<string | null>(activeSessionId);
    const localActiveSessionIdRef = useRef(localActiveSessionId);
    const setLocalActiveSessionId = (activeId: string | null) => {
        localActiveSessionIdRef.current = activeId;
        setLocalActiveSessionIdState(activeId);
    };
    const applyingExternalSessionsRef = useRef(false);
    const chatListRef = useRef<HTMLDivElement>(null);
    const snapshotRef = useRef(snapshot);
    const pendingToolContextRef = useRef(new Map<string, PendingOnlineToolContext>());
    const cinematicSessionControllersRef = useRef(new Map<string, AbortController>());
    const generationConsumerControllerRef = useRef(new AbortController());

    useEffect(() => {
        let cancelled = false;
        listAddedSkills()
            .then((result) => {
                if (!cancelled) setComposerSkills(result.skills || []);
            })
            .catch(() => {
                if (!cancelled) setComposerSkills([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!sessions.length) return;
        if (sessions === localSessions && activeSessionId === localActiveSessionId) return;
        applyingExternalSessionsRef.current = true;
        localSessionsRef.current = sessions;
        setLocalSessions(sessions);
        setLocalActiveSessionId(activeSessionId);
    }, [activeSessionId, sessions]);

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);

    useEffect(() => {
        generationConsumerControllerRef.current = activeGenerationConsumerController(generationConsumerControllerRef.current);
        return () => {
            // 收起面板或刷新页面时只停止前端查询，后台任务由下次挂载根据持久化 ID 继续接管。
            cinematicSessionControllersRef.current.forEach((controller) => controller.abort());
            cinematicSessionControllersRef.current.clear();
            generationConsumerControllerRef.current.abort();
        };
    }, []);

    useEffect(() => {
        if (applyingExternalSessionsRef.current) {
            applyingExternalSessionsRef.current = false;
            return;
        }
        if (sessions === localSessions && activeSessionId === localActiveSessionId) return;
        onSessionsChange(localSessions, localActiveSessionId);
    }, [activeSessionId, localActiveSessionId, localSessions, onSessionsChange, sessions]);

    const safeSessions = localSessions.length ? localSessions : [createSession()];
    const activeSession = useMemo(() => safeSessions.find((session) => session.id === localActiveSessionId) || safeSessions[0] || null, [localActiveSessionId, safeSessions]);
    const historySessions = safeSessions.filter((session) => session.messages.length > 0);
    const messages = activeSession?.messages || [];
    const hasMessages = messages.length > 0;
    const agentBusy = isRunning || safeSessions.some((session) => session.pendingBackendSession?.status === "pending");
    const selectedReferences = useMemo(() => buildAssistantReferences(nodes, attachedReferenceIds), [attachedReferenceIds, nodes]);
    const composerImageReferences = useMemo(() => assistantReferencesToMentionReferences(selectedReferences), [selectedReferences]);
    const resolvedComposerImageReferences = useResolvedCanvasResourceReferences(composerImageReferences);
    const composerReferences = useMemo(() => [...buildSkillMentionReferences(composerSkills), ...resolvedComposerImageReferences], [composerSkills, resolvedComposerImageReferences]);
    const resolvedPreviewById = useMemo(() => new Map(resolvedComposerImageReferences.map((item) => [item.id, item.previewUrl || ""])), [resolvedComposerImageReferences]);
    const contextSummary = useMemo(() => summarizeCanvasContext(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const iconButtonStyle = { color: theme.node.muted };

    useEffect(() => {
        if (agentMode !== "online" || view !== "chat") return;
        const frame = requestAnimationFrame(() => chatListRef.current?.scrollTo({ top: chatListRef.current.scrollHeight }));
        return () => cancelAnimationFrame(frame);
    }, [agentBusy, agentMode, localActiveSessionId, messages, view]);

    useEffect(() => {
        setAttachedReferenceIds((current) => {
            const nodeById = new Map(nodes.map((node) => [node.id, node]));
            const next = new Set(current);
            let changed = false;
            selectedNodeIds.forEach((id) => {
                const node = nodeById.get(id);
                if (!node || !nodeToReference(node) || next.has(id)) return;
                next.add(id);
                changed = true;
            });
            return changed ? next : current;
        });
    }, [nodes, selectedNodeIds]);

    useEffect(() => {
        setAttachedReferenceIds((current) => {
            const nodeIds = new Set(nodes.map((node) => node.id));
            const next = new Set(Array.from(current).filter((id) => nodeIds.has(id)));
            return next.size === current.size ? current : next;
        });
    }, [nodes]);

    const updateSession = (sessionId: string, updater: (session: CanvasAssistantSession) => CanvasAssistantSession) => {
        const next = localSessionsRef.current.map((session) => (session.id === sessionId ? updater(session) : session));
        localSessionsRef.current = next;
        setLocalSessions(next);
        return next;
    };

    const readCinematicSessionState = (): CinematicContinuationLiveSessionState => ({ sessions: localSessionsRef.current, activeChatId: localActiveSessionIdRef.current });

    const restoreCinematicSessions = (sessions: CanvasAssistantSession[], activeId: string | null) => {
        localSessionsRef.current = sessions;
        setLocalSessions(sessions);
        setLocalActiveSessionId(activeId);
    };
    const restoreCinematicSnapshot = (state: Pick<CanvasAgentSnapshot, "nodes" | "connections">) => {
        snapshotRef.current = { ...snapshotRef.current, nodes: state.nodes, connections: state.connections };
    };

    const hasAgentGenerationEffect = (sessionId: string, effectKey?: string) => {
        const session = localSessionsRef.current.find((candidate) => candidate.id === sessionId);
        return Boolean(session && generationEffectApplied(session, effectKey));
    };

    const appendMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => ({
            ...session,
            title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
            messages: [...session.messages, message],
            updatedAt: new Date().toISOString(),
        }));
    };

    const upsertMessage = (sessionId: string, message: CanvasAssistantMessage) => {
        updateSession(sessionId, (session) => {
            const exists = session.messages.some((item) => item.id === message.id);
            return {
                ...session,
                title: session.messages.length ? session.title : message.text.slice(0, 18) || "新对话",
                messages: exists ? session.messages.map((item) => (item.id === message.id ? { ...item, ...message } : item)) : [...session.messages, message],
                updatedAt: new Date().toISOString(),
            };
        });
    };

    const setPendingCinematicSession = (sessionId: string, backendSessionId: string) => {
        const startedAt = new Date().toISOString();
        const pending: CanvasAssistantPendingBackendSession = {
            id: backendSessionId,
            kind: "cinematic",
            messageId: cinematicSessionMessageId(backendSessionId),
            status: "pending",
            startedAt,
        };
        updateSession(sessionId, (session) => ({
            ...session,
            pendingBackendSession: pending,
            messages: upsertAssistantMessage(session.messages, {
                id: pending.messageId,
                role: "assistant",
                title: "影视项目生成中",
                text: "后端影视 Agent 正在处理。即使页面刷新，也会在重新进入画布后继续等待结果。",
                detail: { kind: "cinematic", backendSessionId, status: "pending", startedAt },
            }),
            updatedAt: startedAt,
        }));
    };

    const completeCinematicSession = (sessionId: string, backendSessionId: string, ops: CanvasAgentOp[], recovered = false, effectKey?: string) => {
        return updateSession(sessionId, (session) => {
            const pending = session.pendingBackendSession;
            if (pending?.id !== backendSessionId) return session;
            const completedAt = new Date().toISOString();
            const summary = summarizeCanvasAgentOps(ops) || "影视项目已写回当前画布。";
            const completed = {
                ...session,
                pendingBackendSession: undefined,
                messages: upsertAssistantMessage(session.messages, {
                    id: pending.messageId,
                    role: "assistant",
                    title: recovered ? "影视项目已恢复并写回" : "影视项目已写回",
                    text: recovered ? `页面重新连接后已恢复后台结果：${summary}` : summary,
                    detail: { kind: "cinematic", backendSessionId, status: "completed", recovered, completedAt },
                }),
                updatedAt: completedAt,
            };
            return effectKey ? applyGenerationConsumerEffect(completed, effectKey, (current) => current).value : completed;
        });
    };

    const failCinematicSession = (sessionId: string, backendSessionId: string, error: unknown) => {
        updateSession(sessionId, (session) => {
            const pending = session.pendingBackendSession;
            if (pending?.id !== backendSessionId) return session;
            const failedAt = new Date().toISOString();
            const text = error instanceof Error ? error.message : "影视项目生成失败";
            return {
                ...session,
                pendingBackendSession: undefined,
                messages: upsertAssistantMessage(session.messages, {
                    id: pending.messageId,
                    role: "error",
                    title: "影视项目生成失败",
                    text,
                    detail: { kind: "cinematic", backendSessionId, status: "failed", failedAt },
                }),
                updatedAt: failedAt,
            };
        });
    };

    const runCinematicSession = async (sessionId: string, text: string, current: CanvasAgentSnapshot, config: AiConfig, onCreated?: (backendSessionId: string) => void) => {
        const requestConfig = resolveModelRequestConfig(config, config.textModel || config.model);
        const storyboardContext = resolveStoryboardGenerationContext(current.nodes);
        const controller = new AbortController();
        const requestKey = `creating:${nanoid()}`;
        let backendSessionId = "";
        cinematicSessionControllersRef.current.set(requestKey, controller);
        try {
            const detail = await createCinematicAgentSession(
                {
                    projectId,
                    prompt: text,
                    canvasSnapshot: compactSnapshot(current) as unknown as Record<string, unknown>,
                    projectStyle: storyboardContext.projectStyle,
                    characters: storyboardContext.characters,
                    config: backendAgentProviderConfig(requestConfig),
                },
                {
                    signal: controller.signal,
                    onCreated: (created) => {
                        backendSessionId = created.session.id;
                        cinematicSessionControllersRef.current.delete(requestKey);
                        cinematicSessionControllersRef.current.set(backendSessionId, controller);
                        setPendingCinematicSession(sessionId, backendSessionId);
                        onCreated?.(backendSessionId);
                    },
                },
            );
            return {
                backendSessionId: detail.session.id,
                ops: requireOps(JSON.parse(cinematicAgentSessionOpsJson(detail))),
                continuationTask: [...detail.tasks].reverse().find((task) => task.status === "succeeded"),
            };
        } catch (error) {
            if (backendSessionId && !isAgentSessionPollingAbort(error)) failCinematicSession(sessionId, backendSessionId, error);
            throw error;
        } finally {
            cinematicSessionControllersRef.current.delete(requestKey);
            if (backendSessionId) cinematicSessionControllersRef.current.delete(backendSessionId);
        }
    };

    const startChatSession = () => {
        if (activeSession && activeSession.messages.length === 0) {
            setLocalActiveSessionId(activeSession.id);
            return;
        }
        const session = createSession();
        setLocalSessions((prev) => [session, ...prev]);
        setLocalActiveSessionId(session.id);
    };

    const removeSessions = (ids: string[]) => {
        const next = safeSessions.filter((session) => !ids.includes(session.id));
        if (!next.length) {
            const session = createSession();
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        } else {
            setLocalSessions(next);
            setLocalActiveSessionId(localActiveSessionId && ids.includes(localActiveSessionId) ? next[0].id : localActiveSessionId);
        }
        void cleanupImages({ sessions: next });
    };

    const clearSessions = () => {
        const session = createSession();
        setLocalSessions([session]);
        setLocalActiveSessionId(session.id);
        void cleanupImages({ sessions: [session] });
    };

    const sendMessage = async (text: string, history: CanvasAssistantMessage[], savedReferences?: CanvasAssistantReference[]) => {
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }

        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }

        const refs = savedReferences || selectedReferences;
        const userMessage: CanvasAssistantMessage = { id: nanoid(), role: "user", text, references: refs };
        const assistantId = nanoid();
        appendMessage(session.id, userMessage);
        setPrompt("");
        setIsRunning(true);
        void runOnlineAgentStep(session.id, assistantId, history, userMessage, { step: 1 });
    };

    const runOnlineAgentStep = async (sessionId: string, assistantId: string, history: CanvasAssistantMessage[], userMessage: CanvasAssistantMessage, loop: OnlineLoopContext) => {
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        try {
            setIsRunning(true);
            const messages = await buildToolAgentMessages(snapshotRef.current, history, userMessage, composerSkills);
            let streamed = "";
            const result = await requestOnlineAgentModel({ ...requestConfig, systemPrompt: "" }, messages, "required", userMessage.text, (text) => {
                streamed = text;
                if (text.trim()) upsertMessage(sessionId, { id: assistantId, role: "assistant", text });
            });
            if (result.toolCalls.length) {
                const writableCalls = result.toolCalls.filter(isWritableToolCall);
                if (confirmTools && writableCalls.length) {
                    upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.content || streamed || "准备执行工具，等待确认。" });
                    const toolMessageId = nanoid();
                    pendingToolContextRef.current.set(toolMessageId, { messages, toolCalls: result.toolCalls, assistantId, step: loop.step });
                    const toolMessage: CanvasAssistantMessage = {
                        id: toolMessageId,
                        role: "tool",
                        title: "确认工具调用",
                        text: summarizeToolCalls(result.toolCalls),
                        detail: { status: "pending", step: loop.step, toolCalls: result.toolCalls, impact: previewOnlineToolCalls(result.toolCalls, snapshotRef.current, effectiveConfig) },
                    };
                    appendMessage(sessionId, toolMessage);
                    return;
                }
                await continueOnlineToolLoop(sessionId, assistantId, messages, result, loop.step);
            } else {
                if (!result.content.trim()) throw new Error("模型没有返回工具调用，画布操作未执行。");
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: result.content || streamed || "没有返回内容。" });
            }
        } catch (error) {
            if (isAgentSessionPollingAbort(error)) return;
            appendMessage(sessionId, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            setIsRunning(false);
        }
    };

    const continueOnlineToolLoop = async (sessionId: string, assistantId: string, messages: ResponseInputMessage[], result: { content: string; toolCalls: ResponseToolCall[] }, step: number) => {
        const toolResults = await executeOnlineToolCalls(sessionId, result.toolCalls);
        appendMessage(sessionId, {
            id: nanoid(),
            role: "tool",
            title: "工具自动执行完成",
            text: toolResults.map((item) => toolResultText(item.result)).join("\n"),
            detail: { status: "completed", step, toolCalls: result.toolCalls, results: toolResults },
        });
        await continueOnlineToolLoopAfterResults(sessionId, assistantId, messages, result.toolCalls, toolResults, step);
    };

    const continueOnlineToolLoopAfterResults = async (sessionId: string, assistantId: string, messages: ResponseInputMessage[], toolCalls: ResponseToolCall[], toolResults: OnlineExecutedToolCall[], step: number) => {
        const nextMessages: ResponseInputMessage[] = [...messages, ...toolCalls.map(toolCallToResponseInput), ...toolResults.map((item) => ({ role: "tool" as const, tool_call_id: item.toolCallId, content: JSON.stringify(item.result) }))];
        if (step >= ONLINE_AGENT_MAX_STEPS) {
            upsertMessage(sessionId, { id: assistantId, role: "assistant", text: toolResults.map((item) => toolResultText(item.result)).join("\n") || "工具已执行。" });
            return;
        }
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        let streamed = "";
        const next = await requestOnlineAgentModel({ ...requestConfig, systemPrompt: "" }, nextMessages, "auto", "继续处理画布工具结果", (text) => {
            streamed = text;
            if (text.trim()) upsertMessage(sessionId, { id: assistantId, role: "assistant", text });
        });
        if (next.toolCalls.length) {
            const writableCalls = next.toolCalls.filter(isWritableToolCall);
            if (confirmTools && writableCalls.length) {
                upsertMessage(sessionId, { id: assistantId, role: "assistant", text: next.content || streamed || "准备执行工具，等待确认。" });
                const toolMessageId = nanoid();
                pendingToolContextRef.current.set(toolMessageId, { messages: nextMessages, toolCalls: next.toolCalls, assistantId, step: step + 1 });
                appendMessage(sessionId, {
                    id: toolMessageId,
                    role: "tool",
                    title: "确认工具调用",
                    text: summarizeToolCalls(next.toolCalls),
                    detail: { status: "pending", step: step + 1, toolCalls: next.toolCalls, impact: previewOnlineToolCalls(next.toolCalls, snapshotRef.current, effectiveConfig) },
                });
                return;
            }
            await continueOnlineToolLoop(sessionId, assistantId, nextMessages, next, step + 1);
            return;
        }
        upsertMessage(sessionId, { id: assistantId, role: "assistant", text: next.content || streamed || toolResults.map((item) => toolResultText(item.result)).join("\n") || "工具已执行。" });
    };

    const executeOps = async (ops: CanvasAgentOp[], context?: { conversationId?: string; messageId?: string; source?: "online" | "local" }) => {
        const beforeSnapshot = snapshotRef.current;
        const validation = validateCanvasAgentOps(beforeSnapshot, ops);
        if (!validation.ok) {
            throw new Error(`画布操作校验失败：${validation.issues.filter((item) => item.severity === "error").map((item) => item.message).join("；")}`);
        }
        const before = snapshotSignature(beforeSnapshot);
        const next = await onApplyOps(ops, context);
        snapshotRef.current = next;
        const verification = verifyCanvasAgentOps(beforeSnapshot, next, ops);
        const noopReason = verification.changed ? "" : explainNoop(ops, beforeSnapshot);
        return { ...verification, verification, snapshot: next, ops, noopReason, before: JSON.parse(before), after: JSON.parse(snapshotSignature(next)) };
    };

    const executeOnlineTool = async (sessionId: string, name: string, args: Record<string, unknown>, messageId?: string): Promise<OnlineToolResult> => {
            const current = snapshotRef.current;
            try {
            const expectedRevision = typeof args.expectedRevision === "number" ? args.expectedRevision : undefined;
            if (expectedRevision !== undefined && expectedRevision !== (current.revision ?? 0)) return { ok: false, message: "画布 revision 已变化，请重新读取 canvas_get_context 后再执行写操作。" };
            const expectedStateHash = typeof args.expectedStateHash === "string" ? args.expectedStateHash : "";
            if (expectedStateHash && expectedStateHash !== buildCanvasAgentContext(current).stateHash) return { ok: false, message: "画布状态已变化，请重新读取 canvas_get_context 后再执行写操作。" };
            const skillToolResult = await skillRuntime.executeAgentTool("onlineAgent", name, args, composerSkills);
            if (skillToolResult) return skillToolResult;
            if (name === "canvas_get_state") return { ok: true, message: describeCanvasSnapshot(current), data: compactSnapshot(current) };
            if (name === "canvas_get_context") return { ok: true, message: "已读取语义化画布上下文。", data: buildCanvasAgentContext(current) };
            if (name === "canvas_find_nodes") return { ok: true, message: "已按条件检索真实节点。", data: findCanvasAgentNodes(current, args as Parameters<typeof findCanvasAgentNodes>[1]) };
            if (name === "canvas_get_node") {
                const data = getCanvasAgentNode(current, { id: requireString(args.id, "id") });
                return { ok: true, message: data.found ? "已精确读取节点。" : "未找到指定节点。", data };
            }
            if (name === "canvas_get_connection") {
                const data = getCanvasAgentConnection(current, { id: requireString(args.id, "id") });
                return { ok: true, message: data.found ? "已精确读取连线。" : "未找到指定连线。", data };
            }
            if (name === "canvas_get_generation_tasks") return { ok: true, message: "已读取画布生成任务观察状态。", data: getCanvasAgentGenerationTasks(current, args as Parameters<typeof getCanvasAgentGenerationTasks>[1]) };
            if (name === "canvas_get_resources") return { ok: true, message: "已读取画布资源清单。", data: getCanvasAgentResources(current, args as Parameters<typeof getCanvasAgentResources>[1]) };
            if (name === "canvas_validate_ops") {
                const result = validateCanvasAgentOps(current, requireOps(args.ops));
                return { ok: result.ok, message: result.ok ? "操作校验通过。" : "操作校验失败。", data: result };
            }
            if (name === "canvas_export_snapshot") return { ok: true, message: describeCanvasSnapshot(current), data: compactSnapshot(current) };
            if (name === "canvas_get_selection") {
                const ids = new Set(current.selectedNodeIds || []);
                return { ok: true, message: `当前选中 ${ids.size} 个节点。`, data: { nodes: compactSnapshot({ ...current, nodes: current.nodes.filter((node) => ids.has(node.id)) }).nodes } };
            }
            if (name === "canvas_create_cinematic_session") {
                const cinematic = await runCinematicSession(sessionId, requireString(args.prompt, "prompt"), current, effectiveConfig);
                let continuationResult: OnlineToolResult | undefined;
                const applyContinuation = async ({ effectKey, signal }: { effectKey?: string; signal?: AbortSignal } = {}) => {
                    if (hasAgentGenerationEffect(sessionId, effectKey)) return;
                    const result = await canvasCinematicContinuationEntryAdapters["online-tool"]({
                        projectId,
                        effectKey,
                        signal,
                        readSnapshot: () => snapshotRef.current,
                        executeOps: () => executeOps(cinematic.ops),
                        completeSession: (key) => completeCinematicSession(sessionId, cinematic.backendSessionId, cinematic.ops, false, key),
                        readLiveSessionState: readCinematicSessionState,
                        restoreLiveSessions: restoreCinematicSessions,
                        restoreLiveSnapshot: restoreCinematicSnapshot,
                        failProvider: (failure) => failCinematicSession(sessionId, cinematic.backendSessionId, failure),
                    });
                    continuationResult = { ok: result.changed, message: result.changed ? summarizeCanvasAgentOps(cinematic.ops) || "后端影视 Agent 已写回画布。" : result.noopReason, data: result };
                };
                if (cinematic.continuationTask) {
                    await consumeGenerationTaskAgent(cinematic.continuationTask, cinematic.backendSessionId, applyContinuation, { signal: generationConsumerControllerRef.current.signal });
                } else {
                    await applyContinuation();
                }
                return continuationResult ?? { ok: true, message: "后端影视 Agent 已完成。" };
            }
            const ops = onlineToolToOps(name, args, current, effectiveConfig);
            const result = await executeOps(ops, { source: "online", conversationId: sessionId, messageId: messageId || sessionId });
            const { snapshot: _snapshot, before: _before, after: _after, ...cleanData } = result;
            return { ok: result.ok, message: result.changed ? canvasAgentPostconditionMessage(result) : result.noopReason, data: cleanData };
        } catch (error) {
            if (isAgentSessionPollingAbort(error)) throw error;
            return { ok: false, message: error instanceof Error ? error.message : "工具执行失败" };
        }
    };

    const executeOnlineToolCall = async (sessionId: string, toolCall: ResponseToolCall): Promise<OnlineExecutedToolCall> => {
        try {
            const result = await executeOnlineTool(sessionId, toolCall.function.name, parseToolArguments(toolCall.function.arguments), toolCall.id);
            return { toolCallId: toolCall.id, name: toolCall.function.name, result };
        } catch (error) {
            if (isAgentSessionPollingAbort(error)) throw error;
            return { toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: error instanceof Error ? error.message : "工具参数错误" } };
        }
    };

    const executeOnlineToolCalls = async (sessionId: string, toolCalls: ResponseToolCall[]) => {
        const results: OnlineExecutedToolCall[] = [];
        let stopped = false;
        for (const toolCall of toolCalls) {
            if (stopped) {
                results.push({ toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: "前一个工具调用失败，未继续执行。" } });
                continue;
            }
            const result = await executeOnlineToolCall(sessionId, toolCall);
            results.push(result);
            if (!result.result.ok) stopped = true;
        }
        return results;
    };

    const approveOnlineTool = async (messageId: string) => {
        const message = safeSessions.flatMap((session) => session.messages).find((item) => item.id === messageId);
        const detail = objectDetail(message?.detail);
        const pendingContext = pendingToolContextRef.current.get(messageId);
        const toolCalls = pendingContext?.toolCalls || toolCallsFromDetail(detail);
        const previousMessages = pendingContext?.messages || [];
        const session = safeSessions.find((session) => session.messages.some((item) => item.id === messageId));
        const assistantId = pendingContext?.assistantId || "";
        if (!session) return;
        if (!toolCalls.length || !previousMessages.length || !assistantId) {
            upsertMessage(session.id, { id: messageId, role: "tool", title: "工具执行失败", text: "工具上下文不完整，无法执行。", detail: { ...detail, status: "failed" } });
            return;
        }
        try {
            setIsRunning(true);
            const results = await executeOnlineToolCalls(session.id, toolCalls);
            upsertMessage(session.id, { id: messageId, role: "tool", title: "工具执行完成", text: results.map((item) => toolResultText(item.result)).join("\n"), detail: { ...detail, results, status: "completed" } });
            pendingToolContextRef.current.delete(messageId);
            await continueOnlineToolLoopAfterResults(session.id, assistantId, previousMessages, toolCalls, results, pendingContext?.step || Number(detail.step) || 1);
        } catch (error) {
            if (isAgentSessionPollingAbort(error)) return;
            appendMessage(session.id, { id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            setIsRunning(false);
        }
    };

    const rejectOnlineTool = (messageId: string) => {
        const session = safeSessions.find((session) => session.messages.some((item) => item.id === messageId));
        pendingToolContextRef.current.delete(messageId);
        if (session) upsertMessage(session.id, { id: messageId, role: "tool", title: "已拒绝执行", text: "工具调用已取消", detail: { ...objectDetail(session.messages.find((item) => item.id === messageId)?.detail), status: "rejected" } });
    };

    const undoLastOnlineBatch = () => {
        const restored = onUndoOps();
        if (!restored) return;
        snapshotRef.current = restored;
        if (activeSession) appendMessage(activeSession.id, { id: nanoid(), role: "tool", title: "已撤销 Agent 批次", text: "已恢复到本次写回前的画布状态", detail: { status: "completed", remainingUndoCount: Math.max(0, undoOpsCount - 1) } });
    };

    const submit = async () => {
        const text = prompt.trim();
        if (!text || agentBusy) return;
        await sendMessage(text, messages);
    };

    const submitQuickAction = (text: string) => {
        if (!text.trim() || agentBusy) return;
        void sendMessage(text.trim(), messages);
    };

    useEffect(() => {
        if (!cinematicEntry) return;
        setCinematicEntryActive(true);
        setView("chat");
        setPrompt("");
        onCinematicEntryConsumed?.();
    }, [cinematicEntry, onCinematicEntryConsumed]);

    const submitCinematicProject = async (text: string) => {
        const value = text.trim();
        if (!value || agentBusy) return;
        const requestConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const session = activeSession || createSession();
        if (!activeSession) {
            setLocalSessions([session]);
            setLocalActiveSessionId(session.id);
        }
        appendMessage(session.id, { id: nanoid(), role: "user", text: value });
        setPrompt("");
        setIsRunning(true);
        let backendSessionId = "";
        let continuationFailureDisposition: CinematicContinuationFailureDisposition | undefined;
        try {
            const cinematic = await runCinematicSession(session.id, value, snapshotRef.current, effectiveConfig, (createdId) => {
                backendSessionId = createdId;
            });
            const applyContinuation = async ({ effectKey, signal }: { effectKey?: string; signal?: AbortSignal } = {}) => {
                if (hasAgentGenerationEffect(session.id, effectKey)) return;
                await canvasCinematicContinuationEntryAdapters["submit-cinematic"]({
                    projectId,
                    effectKey,
                    signal,
                    readSnapshot: () => snapshotRef.current,
                    executeOps: async () => {
                        const next = await onApplyOps(cinematic.ops);
                        snapshotRef.current = next;
                        return next;
                    },
                    completeSession: (key) => completeCinematicSession(session.id, cinematic.backendSessionId, cinematic.ops, false, key),
                    readLiveSessionState: readCinematicSessionState,
                    restoreLiveSessions: restoreCinematicSessions,
                    restoreLiveSnapshot: restoreCinematicSnapshot,
                    failProvider: (failure) => failCinematicSession(session.id, cinematic.backendSessionId, failure),
                    onFailureDisposition: (disposition) => {
                        continuationFailureDisposition = disposition;
                    },
                });
                setCinematicEntryActive(false);
            };
            if (cinematic.continuationTask) {
                await consumeGenerationTaskAgent(cinematic.continuationTask, cinematic.backendSessionId, applyContinuation, { signal: generationConsumerControllerRef.current.signal });
            } else {
                await applyContinuation();
            }
        } catch (error) {
            if (continuationFailureDisposition) return;
            handleCinematicContinuationFailure(error, (failure) => {
                if (backendSessionId) failCinematicSession(session.id, backendSessionId, failure);
                else appendMessage(session.id, { id: nanoid(), role: "error", title: "影视项目生成失败", text: failure instanceof Error ? failure.message : "影视项目生成失败" });
            });
        } finally {
            setIsRunning(false);
        }
    };

    const resumePendingCinematicSession = async (sessionId: string, pending: CanvasAssistantPendingBackendSession) => {
        if (cinematicSessionControllersRef.current.has(pending.id)) return;
        const controller = new AbortController();
        cinematicSessionControllersRef.current.set(pending.id, controller);
        setIsRunning(true);
        let continuationFailureDisposition: CinematicContinuationFailureDisposition | undefined;
        try {
            const detail = await resumeCinematicAgentSession(pending.id, { signal: controller.signal });
            const ops = requireOps(JSON.parse(cinematicAgentSessionOpsJson(detail)));
            const continuationTask = [...detail.tasks].reverse().find((task) => task.status === "succeeded");
            const applyContinuation = async ({ effectKey, signal }: { effectKey?: string; signal?: AbortSignal } = {}) => {
                if (hasAgentGenerationEffect(sessionId, effectKey)) return;
                await canvasCinematicContinuationEntryAdapters["resume-cinematic"]({
                    projectId,
                    effectKey,
                    signal,
                    readSnapshot: () => snapshotRef.current,
                    executeOps: () => executeOps(ops),
                    completeSession: (key) => completeCinematicSession(sessionId, pending.id, ops, true, key),
                    readLiveSessionState: readCinematicSessionState,
                    restoreLiveSessions: restoreCinematicSessions,
                    restoreLiveSnapshot: restoreCinematicSnapshot,
                    failProvider: (failure) => {
                        failCinematicSession(sessionId, pending.id, failure);
                    },
                    onFailureDisposition: (disposition, error) => {
                        continuationFailureDisposition = disposition;
                    },
                });
            };
            if (continuationTask) {
                await consumeGenerationTaskAgent(continuationTask, pending.id, applyContinuation, { signal: controller.signal });
            } else {
                await applyContinuation();
            }
        } catch (error) {
            if (continuationFailureDisposition) return;
            const disposition = handleCinematicContinuationFailure(error, (failure) => {
                failCinematicSession(sessionId, pending.id, failure);
            });
        } finally {
            if (cinematicSessionControllersRef.current.get(pending.id) === controller) cinematicSessionControllersRef.current.delete(pending.id);
            if (cinematicSessionControllersRef.current.size === 0) setIsRunning(false);
        }
    };

    useEffect(() => {
        localSessions.forEach((session) => {
            const pending = session.pendingBackendSession;
            if (pending?.kind === "cinematic" && pending.status === "pending") void resumePendingCinematicSession(session.id, pending);
        });
    }, [localSessions]);

    const addImagesToCanvas = (files: FileList | File[] | null) => {
        const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
        if (file) onPasteImage(file);
    };

    const collapse = () => {
        onCollapse();
    };

    const onlineContent = (
        <>
            {view === "history" ? (
                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2 px-1">
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>历史会话</div>
                        <Tooltip title="清空历史">
                            <Button type="text" shape="circle" className="!h-7 !w-7 !min-w-7" style={iconButtonStyle} icon={<X className="size-3.5" />} disabled={!historySessions.length} onClick={() => setDeleteChatIds(historySessions.map((session) => session.id))} aria-label="清空历史会话" />
                        </Tooltip>
                    </div>
                    <AssistantHistory
                        sessions={historySessions}
                        activeSession={activeSession}
                        onOpen={(id) => {
                            setLocalActiveSessionId(id);
                            setView("chat");
                        }}
                        onDelete={(id) => setDeleteChatIds([id])}
                    />
                </div>
            ) : (
                <div ref={chatListRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                    {messages.length ? (
                        <>
                            {messages.map((message) => (
                                <div key={message.id} className="space-y-2">
                                    <AgentChatMessage item={assistantMessageToChatMessage(message)} theme={theme} user={user} isStreaming={agentBusy && message.id === messages.at(-1)?.id && message.role === "assistant"} onRejectTool={rejectOnlineTool} onApproveTool={approveOnlineTool} onQuickAction={submitQuickAction} />
                                    {message.references?.length ? <MessageReferences message={message} /> : null}
                                </div>
                            ))}
                            {agentBusy ? <AgentWorkingMessage theme={theme} /> : null}
                        </>
                    ) : (
                        <AgentChatEmptyState
                            theme={theme}
                            nodeCount={contextSummary.nodeCount}
                            onSelect={(text) => {
                                setPrompt(text);
                                void sendMessage(text, messages);
                            }}
                        />
                    )}
                </div>
            )}

            {view === "chat" ? (
                <>
                    {selectedReferences.length ? (
                        <div className="thin-scrollbar flex max-w-full items-center gap-1.5 overflow-x-auto px-3 py-1.5">
                            <span className="shrink-0 text-[var(--fs-micro)] font-medium opacity-55">参考 · {selectedReferences.length}</span>
                            {selectedReferences.map((item, index) => (
                                <AssistantReferenceChip
                                    key={item.id}
                                    item={item}
                                    label={assistantImageReferenceLabel(selectedReferences, index)}
                                    previewUrl={resolvedPreviewById.get(item.id) || item.dataUrl}
                                    onRemove={() => {
                                        setAttachedReferenceIds((prev) => {
                                            const next = new Set(prev);
                                            next.delete(item.id);
                                            return next;
                                        });
                                        if (selectedNodeIds.has(item.id)) onSelectNodeIds(new Set(Array.from(selectedNodeIds).filter((nodeId) => nodeId !== item.id)));
                                    }}
                                    onInsertMention={(label) => {
                                        const token = `@${label} `;
                                        setPrompt((prev) => (promptAlreadyHasMention(prev, label) ? prev : prev.trim() ? `${prev.replace(/\s+$/u, "")} ${token}` : token));
                                    }}
                                />
                            ))}
                        </div>
                    ) : null}
                    <AgentChatComposer
                        prompt={prompt}
                        sending={agentBusy}
                        placeholder={cinematicEntryActive ? "一句话描述题材、角色和核心冲突" : "描述你想让 Agent 如何操作画布"}
                        theme={theme}
                        references={composerReferences}
                        slashSkills={composerSkills}
                        onPromptChange={setPrompt}
                        onSubmit={cinematicEntryActive ? () => submitCinematicProject(prompt) : submit}
                        onAddFiles={addImagesToCanvas}
                        left={
                            <>
                                <VoiceRecordingButton disabled={agentBusy} onTranscribed={(text) => setPrompt((prev) => (prev.trim() ? `${prev} ${text}` : text))} />
                                <AgentTextModelPicker config={effectiveConfig} value={effectiveConfig.textModel} onChange={(model) => updateConfig("textModel", model)} />
                                {cinematicEntryActive ? (
                                    <span className="ml-2 inline-flex h-6 items-center rounded-md px-2 text-[var(--fs-tiny)] font-medium" style={{ background: theme.spatial.surface, color: theme.node.muted }}>
                                        影视项目
                                    </span>
                                ) : null}
                            </>
                        }
                    />
                </>
            ) : null}

            <Modal
                title="删除对话记录？"
                open={deleteChatIds.length > 0}
                centered
                onCancel={() => setDeleteChatIds([])}
                footer={
                    <>
                        <Button onClick={() => setDeleteChatIds([])}>取消</Button>
                        <Button
                            danger
                            type="primary"
                            onClick={() => {
                                deleteChatIds.length === historySessions.length ? clearSessions() : removeSessions(deleteChatIds);
                                setDeleteChatIds([]);
                            }}
                        >
                            删除
                        </Button>
                    </>
                }
            >
                <p className="text-sm opacity-60">将删除 {deleteChatIds.length} 条对话记录，此操作不可撤销。</p>
            </Modal>
        </>
    );

    return (
        <motion.aside
            className="pointer-events-auto relative flex h-full w-full flex-col overflow-hidden rounded-[var(--panel-radius)]"
            initial={{ x: 48, opacity: 0 }}
            animate={{ x: closing ? 28 : 0, opacity: closing ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{
                background: theme.spatial.elevated,
                color: theme.node.text,
                boxShadow: `-18px 0 48px ${theme.spatial.shadow}, 0 24px 72px ${theme.spatial.shadow}`,
            }}
        >
            <AgentPanelChrome
                theme={theme}
                mode={agentMode}
                context={contextSummary}
                referenceCount={selectedReferences.length}
                confirmTools={confirmTools}
                canUndo={agentMode === "online" ? canUndoOps : false}
                undoCount={agentMode === "online" ? undoOpsCount : 0}
                onModeChange={onAgentModeChange}
                onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                onUndo={undoLastOnlineBatch}
                onCollapse={collapse}
                historyCount={agentMode === "online" ? historySessions.length : 0}
                historyActive={agentMode === "online" && view === "history"}
                onOpenHistory={agentMode === "online" ? () => setView((current) => current === "history" ? "chat" : "history") : undefined}
                onNewChat={agentMode === "online" ? () => { startChatSession(); setView("chat"); } : undefined}
                newChatDisabled={false}
            />
            {agentMode === "local" ? <CanvasLocalAgentPanel embedded snapshot={snapshot} canUndoOps={canUndoOps} undoOpsCount={undoOpsCount} onApplyOps={onApplyOps} onUndoOps={onUndoOps} autoConnect={autoConnectLocal} /> : onlineContent}
        </motion.aside>
    );
}
