import { apiClient, request } from "./request";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CreateTaskInput, GenerationTask } from "./task-center";

export type CreationStatus = "idle" | "running" | "waiting_answer" | "waiting_proposal" | "waiting_canvas" | "waiting_payment" | "waiting_task" | "paused" | "completed" | "cancelled";
export type CreationGuard = { executionEpoch: number; owner: string };
export type CreationRun = {
    id: string; userId: string; canvasId?: string; revision: number;
    executionEpoch: number; executionOwner: string; leaseExpiresAt?: string;
    status: CreationStatus; state: Record<string, unknown>;
    approvedProposalVersion?: number; approvedProposalHash?: string;
    createdAt: string; updatedAt: string;
};
export type CreationSubmission = {
    id: string; runId: string; itemKey: string; requestHash: string;
    quote: { model: string; billingMode: string; quantity: number; amountMicrocredits: number; estimated: boolean; expiresAt: string; quoteHash: string; options?: Record<string, unknown> };
    approvedAt?: string; revokedAt?: string; taskId?: string;
};
export type CreationRunDetail = { run: CreationRun; submissions: CreationSubmission[] };

const path = (id: string) => `/creation-runs/${encodeURIComponent(id)}`;
export const creationRuns = {
    create: (input: { clientKey: string; canvasId?: string; state: Record<string, unknown> }, signal?: AbortSignal) => request<CreationRunDetail>(apiClient.post("/creation-runs", input, { signal })),
    get: (id: string, signal?: AbortSignal) => request<CreationRunDetail>(apiClient.get(path(id), { signal })),
    list: (signal?: AbortSignal) => request<{ runs: CreationRun[] }>(apiClient.get("/creation-runs", { signal })),
    save: (id: string, input: CreationGuard & { revision: number; state: Record<string, unknown>; status: CreationStatus }, signal?: AbortSignal) => request<CreationRun>(apiClient.patch(path(id), input, { signal })),
    claim: (id: string, input: { expectedEpoch: number; owner: string }, signal?: AbortSignal) => request<CreationRun>(apiClient.post(`${path(id)}/claim`, input, { signal })),
    heartbeat: (id: string, guard: CreationGuard, signal?: AbortSignal) => request<{ leaseExpiresAt: string }>(apiClient.post(`${path(id)}/heartbeat`, guard, { signal })),
    release: (id: string, guard: CreationGuard) => request<{ released: boolean }>(apiClient.post(`${path(id)}/release`, guard)),
    approveProposal: (id: string, input: CreationGuard & { revision: number; proposalVersion: number; proposal: unknown; ops: CanvasAgentOp[] }, signal?: AbortSignal) => request<CreationRun>(apiClient.post(`${path(id)}/proposal-approve`, input, { signal })),
    invalidateProposal: (id: string, input: CreationGuard & { revision: number }, signal?: AbortSignal) => request<CreationRun>(apiClient.post(`${path(id)}/proposal-invalidate`, input, { signal })),
    canvas: (id: string, guard: CreationGuard, signal?: AbortSignal) => request<{ run: CreationRun; canvasId: string }>(apiClient.post(`${path(id)}/canvas`, guard, { signal })),
    prepare: (id: string, input: CreationGuard & { itemKey: string; proposalVersion?: number; request: CreateTaskInput }, signal?: AbortSignal) => request<CreationSubmission>(apiClient.post(`${path(id)}/submissions/prepare`, input, { signal })),
    approve: (id: string, input: CreationGuard & { submissionIds: string[] }, signal?: AbortSignal) => request<{ submissions: CreationSubmission[] }>(apiClient.post(`${path(id)}/submissions/approve`, input, { signal })),
    refreshQuote: (id: string, input: CreationGuard & { submissionId: string }, signal?: AbortSignal) => request<CreationSubmission>(apiClient.post(`${path(id)}/submissions/refresh`, input, { signal })),
    execute: (id: string, input: CreationGuard & { submissionId: string }, signal?: AbortSignal) => request<GenerationTask>(apiClient.post(`${path(id)}/execute`, input, { signal })).then((task) => {
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wallet:updated"));
        return task;
    }),
    canvasSnapshot: (id: string, signal?: AbortSignal) => request<{ document: CanvasProject; snapshotHash: string }>(apiClient.get(`${path(id)}/canvas-snapshot`, { signal })),
    commitCanvas: (id: string, input: CreationGuard & { expectedSnapshotHash: string; document: CanvasProject }, signal?: AbortSignal) => request<{ snapshotHash: string }>(apiClient.post(`${path(id)}/canvas-commit`, input, { signal })),
};
