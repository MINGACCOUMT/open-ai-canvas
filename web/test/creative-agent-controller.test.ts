import { describe, expect, test } from "bun:test";
import { CreativeAgentController, type CreativeControllerView } from "../src/services/creative-agent-controller";
import { initialCreativeState, type CreativeAgentState } from "../src/lib/creation/creative-agent-state";
import { creationRuns, type CreationRun, type CreationSubmission } from "../src/services/api/creation-runs";
import { applyCanvasAgentOps, type CanvasAgentSnapshot } from "../src/lib/canvas/canvas-agent-ops";
import { defaultConfig } from "../src/stores/use-config-store";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType } from "../src/types/canvas";

function harness(state: CreativeAgentState, status: CreationRun["status"] = "paused", submissions: CreationSubmission[] = [], waitTask?: ConstructorParameters<typeof CreativeAgentController>[0]["waitTask"]) {
    let run: CreationRun = { id: "run", userId: "user", canvasId: "canvas", revision: 1, executionEpoch: 0, executionOwner: "", status, state: structuredClone(state) as unknown as Record<string, unknown>, approvedProposalVersion: state.proposal?.version, createdAt: "", updatedAt: "" };
    let snapshot: CanvasAgentSnapshot = { projectId: "canvas", title: "canvas", nodes: state.media.map((media) => ({ id: media.nodeId, type: CanvasNodeType.Image, title: media.ref, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} })), connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 } };
    let view: CreativeControllerView | undefined;
    let commits = 0, prepares = 0, executions = 0;
    const api = { ...creationRuns,
        get: async () => ({ run: structuredClone(run), submissions: structuredClone(submissions) }),
        claim: async (_id: string, input: { owner: string }) => (run = { ...run, executionEpoch: run.executionEpoch + 1, executionOwner: input.owner }),
        save: async (_id: string, input: { revision: number; status: CreationRun["status"]; state: Record<string, unknown> }) => { if (input.revision !== run.revision) throw new Error("stale"); return run = { ...run, revision: run.revision + 1, state: structuredClone(input.state), status: input.status }; },
        release: async () => ({ released: true }),
        prepare: async () => { prepares++; throw new Error("不应准备新任务"); },
        execute: async () => { executions++; throw new Error("不应执行新任务"); },
        canvas: async () => ({ run, canvasId: "canvas" }),
        canvasSnapshot: async () => ({ document: { id: "canvas", title: "canvas", nodes: snapshot.nodes, connections: snapshot.connections, chatSessions: [], activeChatId: null, viewport: snapshot.viewport, createdAt: "", updatedAt: "", directorScenes: [] }, snapshotHash: "hash" }),
        commitCanvas: async () => { commits++; return { snapshotHash: "saved" }; },
    } as typeof creationRuns;
    const controller = new CreativeAgentController({ config: () => defaultConfig, canvas: () => ({ canvasId: "canvas", read: () => snapshot, apply: async (ops) => snapshot = applyCanvasAgentOps(snapshot, ops) }), onChange: (next) => { view = next; }, onOpenCanvas: () => undefined, api, waitTask, ensureAsset: async () => ({ assetId: "asset", created: false, linkedToProject: false }) });
    return { controller, api, view: () => view!, counters: () => ({ commits, prepares, executions }), snapshot: () => snapshot };
}
const proposal = { id: "p", version: 1, title: "方案", summary: "摘要", markdown: "内容", deliverables: [], workflow: { nodes: [], edges: [], autoRun: false as const }, generationItems: [] };
const submission = (id: string, itemKey: string, taskId?: string): CreationSubmission => ({ id, runId: "run", itemKey, requestHash: "hash", taskId, quote: { model: "model", billingMode: "fixed_request", quantity: 1, amountMicrocredits: 1, estimated: false, expiresAt: "2099-01-01", quoteHash: "quote" } });

describe("创作控制器恢复", () => {
    test("更新过期报价替换分析关联并等待新批准，不执行模型", async () => {
        const old = submission("old", "planning:key");
        const fresh = submission("fresh", "requote:old");
        const h = harness({ ...initialCreativeState(), planning: { itemKey: old.itemKey, submissionId: old.id, protocol: [] }, pendingPayment: [old.id] }, "waiting_payment", [old]);
        h.api.refreshQuote = async () => fresh;
        try {
            await h.controller.load("run"); await h.controller.refreshQuotes();
            expect(h.view().state.planning?.itemKey).toBe("requote:old");
            expect(h.view().state.pendingPayment).toEqual(["fresh"]);
            expect(h.view().run?.status).toBe("waiting_payment"); expect(h.counters().executions).toBe(0);
        } finally { h.controller.dispose(); }
    });
    test("加载报价不执行；批准后只展示首个问答，忽略同批后续方案", async () => {
        const quote = submission("plan", "planning:key");
        const completed = { id: "task", status: "succeeded", resultJson: JSON.stringify({ toolCalls: [
            { id: "first", type: "function", function: { name: "creative_respond", arguments: JSON.stringify({ message: "请补充目标", questions: [{ field: "goal", title: "想做什么？", type: "text", required: true, allowCustom: true }] }) } },
            { id: "second", type: "function", function: { name: "creative_respond", arguments: JSON.stringify({ proposal: { title: "不应执行" } }) } },
        ] }) } as GenerationTask;
        const h = harness({ ...initialCreativeState(), planning: { itemKey: "planning:key", submissionId: "plan", protocol: [] }, pendingPayment: ["plan"] }, "waiting_payment", [quote], async () => completed);
        let approved = false, executed = 0;
        h.api.approve = async () => { approved = true; return { submissions: [{ ...quote, approvedAt: "2026-01-01" }] }; };
        h.api.execute = async () => { expect(approved).toBe(true); executed++; return completed; };
        try {
            await h.controller.load("run"); expect(executed).toBe(0);
            await h.controller.approvePayment();
            expect(executed).toBe(1); expect(h.view().run?.status).toBe("waiting_answer");
            expect(h.view().state.questions?.questions).toHaveLength(1);
            expect(h.view().state.proposal).toBeUndefined(); expect(h.counters().commits).toBe(0);
        } finally { h.controller.dispose(); }
    });
    test("暂停于已批准画布接续时仍可创建节点并完成，不提交模型任务", async () => {
        const h = harness({ ...initialCreativeState(), proposal, operations: [{ type: "add_node", id: "outline", nodeType: CanvasNodeType.Text, title: "大纲", metadata: { content: "内容" } }], canvasApplied: false });
        try { await h.controller.load("run"); await h.controller.resume(); expect(h.snapshot().nodes).toHaveLength(1); expect(h.view().run?.status).toBe("completed"); expect(h.counters()).toEqual({ commits: 1, prepares: 0, executions: 0 }); } finally { h.controller.dispose(); }
    });
    test("prepare回执丢失后按itemKey恢复原报价，不新增调用", async () => {
        const h = harness({ ...initialCreativeState(), planning: { itemKey: "planning:key", protocol: [], model: "model" } }, "running", [submission("existing", "planning:key")]);
        try { await h.controller.load("run"); await h.controller.resume(); expect(h.view().state.planning?.submissionId).toBe("existing"); expect(h.view().quote).toBeDefined(); expect(h.counters().prepares).toBe(0); } finally { h.controller.dispose(); }
    });
    test("第一项失败不阻止同批成功结果回写", async () => {
        const media = ["a", "b"].map((ref) => ({ ref, nodeId: ref, attempt: 1, submissionId: ref, taskId: ref, status: "queued" as const }));
        const h = harness({ ...initialCreativeState(), proposal, canvasApplied: true, media }, "paused", [submission("a", "a", "a"), submission("b", "b", "b")], async (id) => { if (id === "a") throw new Error("A生成失败"); return { id, status: "succeeded", resultJson: JSON.stringify({ images: [{ storageKey: "resource:output", dataUrl: "/api/resources/output/file" }] }) } as GenerationTask; });
        try { await h.controller.load("run"); await expect(h.controller.resume()).rejects.toThrow("A生成失败"); expect(h.view().state.media.map((item) => item.status)).toEqual(["failed", "ready"]); expect(h.counters().executions).toBe(0); expect(h.counters().commits).toBe(1); } finally { h.controller.dispose(); }
    });
    test("暂停后迟到的任务回调不能写画布", async () => {
        let resolveTask!: (task: GenerationTask) => void;
        let waiting!: () => void; const started = new Promise<void>((resolve) => { waiting = resolve; });
        const h = harness({ ...initialCreativeState(), proposal, canvasApplied: true, media: [{ ref: "a", nodeId: "a", attempt: 1, submissionId: "a", taskId: "a", status: "queued" }] }, "waiting_task", [submission("a", "a", "a")], () => { waiting(); return new Promise((resolve) => { resolveTask = resolve; }); });
        try {
            await h.controller.load("run"); const resume = h.controller.resume(); await started; await h.controller.pause();
            resolveTask({ id: "a", status: "succeeded", resultJson: JSON.stringify({ images: [{ storageKey: "resource:a" }] }) } as GenerationTask);
            await expect(resume).rejects.toThrow(); expect(h.counters().commits).toBe(0); expect(h.view().hasControl).toBe(false);
        } finally { h.controller.dispose(); }
    });
});
